// Copy sells that fail while nothing landed are retried (finding F6): a trader's exit is usually a one-off event,
// and one Jupiter 429, a slippage failure on a dumping token or an expired send must not leave the agent holding a
// bag the trader already left.
//
//   - only failures where nothing moved are retried (TradeError.retryable: quote / build / preflight / on-chain
//     failure / expiry / balance read problems / guard refusals). A send whose outcome is open (InFlightError) is
//     never retried: inflight.ts finishes it from the chain;
//   - fresh quote each attempt, slippage doubling per attempt up to max(own, 2500 bps), backoff 5 s → 60 s, for
//     SELL_RETRY_WINDOW_MS; then the row is failed ("exit failed after N attempts");
//   - the CopyTrade row stays one row with status "retrying" (the API shows it as pending) and its reason;
//   - the retry state is persisted (Kv "sellretry:<tradeId>"), so a restart resumes it instead of dropping it;
//   - each attempt runs on the agent's serial queue and re-reads the sleeve (a close-all or a later sell may have
//     changed it).

import { prisma } from "@/lib/db";
import { errText, logger } from "./log";
import { enqueueForAgent, isShuttingDown } from "./queue";
import { InFlightError, TradeError } from "./swap";

const log = logger("retry");

export const SELL_RETRY_WINDOW_MS = 10 * 60_000;
export const SELL_RETRY_MAX_SLIPPAGE_BPS = 2_500;
const FIRST_DELAY_MS = 5_000;
const MAX_DELAY_MS = 60_000;
const TICK_MS = 1_000;
const PREFIX = "sellretry:";

export interface SellRetry {
  tradeId: string;
  agentId: string;
  traderId: string;
  mint: string;
  /** Raw tokens to sell (capped by the sleeve at each attempt); null = size from sellFraction at the attempt. */
  rawWanted: string | null;
  sellFraction: number | null;
  /** Attempts already made. */
  attempt: number;
  firstAt: number;
  nextAt: number;
  lastReason: string;
  /** Reference time of the copied event (latency). */
  refMs: number | null;
}

/** Delay before attempt `attempt + 1` (attempt ≥ 1 made so far). */
export function retryDelayMs(attempt: number): number {
  return Math.min(FIRST_DELAY_MS * 2 ** Math.max(0, attempt - 1), MAX_DELAY_MS);
}

/** Slippage for an attempt: the agent's own on the first, doubling after each failure, capped. Never below own. */
export function retrySlippageBps(baseBps: number, attemptsMade: number): number {
  const cap = Math.max(baseBps, SELL_RETRY_MAX_SLIPPAGE_BPS);
  return Math.min(cap, Math.max(baseBps, Math.round(baseBps * 2 ** Math.max(0, attemptsMade))));
}

/** Safe to try again: the failure is known to have moved nothing. */
export function isRetryable(err: unknown): boolean {
  return err instanceof TradeError && err.retryable && !(err instanceof InFlightError);
}

const key = (tradeId: string) => `${PREFIX}${tradeId}`;
const pending = new Map<string, SellRetry>();
const running = new Set<string>();

/** Persist a retry and mark its row "retrying". */
export async function parkSellRetry(rec: SellRetry): Promise<void> {
  const value = JSON.stringify(rec);
  await prisma.$transaction([
    prisma.kv.upsert({ where: { key: key(rec.tradeId) }, create: { key: key(rec.tradeId), value }, update: { value } }),
    prisma.copyTrade.update({
      where: { id: rec.tradeId },
      data: { status: "retrying", reason: `exit retry ${rec.attempt}: ${rec.lastReason}`.slice(0, 200) },
    }),
  ]);
  pending.set(rec.tradeId, rec);
}

export async function dropSellRetry(tradeId: string): Promise<void> {
  pending.delete(tradeId);
  await prisma.kv.deleteMany({ where: { key: key(tradeId) } });
}

/** Retry records persisted by a previous process (startup). */
export async function loadSellRetries(): Promise<SellRetry[]> {
  const rows = await prisma.kv.findMany({ where: { key: { startsWith: PREFIX } } });
  const out: SellRetry[] = [];
  for (const r of rows) {
    try {
      const v = JSON.parse(r.value) as SellRetry;
      if (v && typeof v.tradeId === "string" && typeof v.agentId === "string") out.push(v);
    } catch {
      await prisma.kv.deleteMany({ where: { key: r.key } });
    }
  }
  return out;
}

/**
 * Starts the retry loop: resumes persisted retries, then runs each due one on its agent's queue through `run`
 * (executor.retryCopySell). Returns a stop function (retries stay persisted for the next worker).
 */
export function startSellRetryLoop(run: (rec: SellRetry) => Promise<void>): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const tick = () => {
    if (stopped || isShuttingDown()) return;
    const now = Date.now();
    for (const rec of pending.values()) {
      if (rec.nextAt > now || running.has(rec.tradeId)) continue;
      running.add(rec.tradeId);
      pending.delete(rec.tradeId); // `run` re-parks it when another attempt is due
      enqueueForAgent(rec.agentId, () => run(rec))
        .catch((err: unknown) => {
          log.error("sell retry crashed; trying again later", { trade: rec.tradeId, err: errText(err) });
          if (!pending.has(rec.tradeId)) pending.set(rec.tradeId, { ...rec, nextAt: Date.now() + MAX_DELAY_MS });
        })
        .finally(() => running.delete(rec.tradeId));
    }
    timer = setTimeout(tick, TICK_MS);
  };
  void loadSellRetries()
    .then((recs) => {
      for (const r of recs) if (!pending.has(r.tradeId)) pending.set(r.tradeId, r);
      if (recs.length) log.info("resuming sell retries", { n: recs.length });
    })
    .catch((err: unknown) => log.warn("could not load sell retries", { err: errText(err) }))
    .finally(() => {
      if (!stopped) tick();
    });
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
