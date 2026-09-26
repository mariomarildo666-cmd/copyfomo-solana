// Copy engine: TraderEvent → per-agent sizing → paper/live fill → CopyTrade + Position (+ paperSol, + fees).
// Every agent task runs on that agent's serial queue; one agent's failure never touches another.
//
// Venue rule (copyrules.ts): with COPY_VENUE=fomo (default) a buy whose TraderEvent.venue is not "fomo" is
// recorded as a skipped CopyTrade ("not a FOMO trade"); sells are copied from any venue while the agent holds
// that sleeve — including sleeves of traders the agent no longer follows — so agents can always exit.
//
// Live money path (findings F2–F6, F8): a signed swap is journaled (row "sending" + inflight record) before it is
// broadcast; fills are measured from the transaction's own metadata; a send whose outcome is open stays "sending"
// for inflight.ts to finish from the chain (never failed blindly, never retried blindly); copy sells that failed
// while nothing landed are retried (sellretry.ts); one empty balance read never deletes a sleeve.

import type { Agent, Position, TraderEvent } from "@prisma/client";
import { config } from "@/lib/config";
import { prisma } from "@/lib/db";
import { getSolBalance, LAMPORTS_PER_SOL } from "@/lib/solana";
import type { Side } from "@/lib/types";
import { requestBalanceRefresh } from "./balances";
import { copyVenueSkipReason, dispatchTargets } from "./copyrules";
import { requestFeeSweep } from "./feesweep";
import { adoptUntrackedHoldings } from "./holdings";
import { markActive, markDone, type InflightRecord, type InflightResolution } from "./inflight";
import { finishTrade, markSending, recordBuy, recordSell } from "./ledger";
import { errText, logger } from "./log";
import { enqueueForAgent, isShuttingDown } from "./queue";
import { dropSellRetry, isRetryable, parkSellRetry, retryDelayMs, retrySlippageBps, SELL_RETRY_WINDOW_MS, type SellRetry } from "./sellretry";
import { liveSellReserveSol, sizeBuy, sizeSell } from "./sizing";
import {
  InFlightError,
  liveBuy,
  liveSell,
  NothingOnChainError,
  paperBuy,
  paperSell,
  TradeError,
  TradeSkip,
  type Fill,
  type LiveSendHooks,
  type PriceRef,
  type SellFill,
} from "./swap";
import { fetchAgentTxEffect } from "./txmeta";
import { isUniqueViolation, sleep } from "./util";
import { isSealKeyError, withAgentSigner, workerHandlesMode } from "./wallet";

const log = logger("exec");
const ZERO = BigInt(0);
/** A sleeve touched this recently is never cleared on "no tokens on-chain" (RPC lag after its buy, finding F5). */
const RECENT_SLEEVE_MS = 120_000;
/** Close-all / withdraw liquidation: attempts per sleeve (retryable failures only), with escalating slippage. */
const CLOSE_ALL_ATTEMPTS = 3;
const CLOSE_ALL_BACKOFF_MS = 3_000;
/** A landed swap whose details never become available is given up on after this long (holdings.ts adopts it). */
const UNMEASURED_GIVE_UP_MS = 6 * 3600_000;
/** API bounds for slippage: the worker never trusts DB rule values beyond them (finding F10). */
const MIN_SLIPPAGE_BPS = 10;
const MAX_SLIPPAGE_BPS = 5_000;

/** Statuses a copy trade can end in ("pending": broadcast or queued for a retry, finished later). */
type Outcome = { status: "filled"; fill: Fill } | { status: "skipped" | "failed" | "pending"; reason: string };

function isPaper(agent: Pick<Agent, "mode">): boolean {
  return agent.mode === "paper";
}

export function clampSlippageBps(bps: number): number {
  return Number.isFinite(bps) ? Math.min(Math.max(Math.round(bps), MIN_SLIPPAGE_BPS), MAX_SLIPPAGE_BPS) : 300;
}

/**
 * ms since the event's reference time (TraderEvent.blockTime): local receive time for streamed / log-notified
 * trades, chain blockTime for polled ones (see watcher.ts). Used for latency and the max-age check.
 */
function latencySince(blockTime: Date | number): number {
  const t = typeof blockTime === "number" ? blockTime : blockTime.getTime();
  return Math.max(0, Math.round(Date.now() - t));
}

function reasonOf(err: unknown): { reason: string; signature: string | null } {
  if (err instanceof TradeError) return { reason: err.reason, signature: err.signature };
  return { reason: `error: ${errText(err, 140)}`, signature: null };
}

/** The trader's own fill, for the copy-buy price check (null when unusable). */
function priceRef(ev: Pick<TraderEvent, "tokenRaw" | "solAmount">): PriceRef | null {
  if (!/^\d+$/.test(ev.tokenRaw) || !(ev.solAmount > 0)) return null;
  return { tokenRaw: BigInt(ev.tokenRaw), lamports: BigInt(Math.round(ev.solAmount * LAMPORTS_PER_SOL)) };
}

/** Balance a buy may be sized from: paper SOL, or on-chain SOL minus platform fees owed (never spendable). */
async function spendableBalanceSol(agent: Agent): Promise<number> {
  if (isPaper(agent)) return agent.paperSol;
  try {
    return (await getSolBalance(agent.depositAddress)) - Math.max(0, agent.feeOwedSol);
  } catch (err) {
    throw new TradeError(`balance unavailable: ${errText(err, 100)}`);
  }
}

/** Sealed key unusable (wrong seal key pair, tampered blob): stop copying for this agent and say so loudly. */
async function pauseOnSealError(agent: Agent, err: unknown): Promise<void> {
  if (isPaper(agent) || !isSealKeyError(err)) return;
  const paused = await prisma.agent.updateMany({ where: { id: agent.id, status: "active" }, data: { status: "paused" } }).catch(() => null);
  log.error("agent key cannot be opened — agent paused; check WALLET_SEAL_PRIVATE_KEY / WALLET_SEAL_PUBLIC_KEY", {
    agent: agent.name,
    paused: paused?.count === 1,
    err: errText(err, 120),
  });
}

/**
 * Journal hook: once the swap is signed, the row becomes "sending" with its signature and an in-flight record is
 * written — before anything is broadcast. `sent` collects the signature so the caller can release it.
 */
function journalHooks(tradeId: string, base: Omit<InflightRecord, "signature" | "lastValidBlockHeight" | "sentAt" | "tradeId">, sent: string[]): LiveSendHooks {
  return {
    onSigned: async ({ signature, lastValidBlockHeight }) => {
      markActive(signature);
      sent.push(signature);
      await markSending(tradeId, { ...base, tradeId, signature, lastValidBlockHeight, sentAt: Date.now() });
    },
  };
}

/**
 * A landed live swap must never be lost because the DB write failed: its journal record stays, the row stays
 * "sending", and inflight.ts records it from the chain.
 */
async function persistFill(fill: Fill, write: () => Promise<unknown>): Promise<void> {
  try {
    await write();
  } catch (err) {
    if (err instanceof TradeError || fill.venue === "paper") throw err;
    throw new InFlightError(`swap landed; recording it later (${errText(err, 80)})`, fill.signature);
  }
}

// ── Buys ───────────────────────────────────────────────────────────────────────────────────────

async function executeBuy(agent: Agent, ev: TraderEvent, tradeId: string): Promise<Outcome> {
  const skip = async (reason: string, solAmount = 0): Promise<Outcome> => {
    await finishTrade(tradeId, { status: "skipped", reason, solAmount });
    return { status: "skipped", reason };
  };
  // A buy that waited behind a slow task is no longer a copy of the original entry. (Late sells still run:
  // exiting late beats holding a bag the trader already left.)
  if (latencySince(ev.blockTime) > config.maxEventAgeMs) return skip("too late to copy (agent was busy)");
  if (isShuttingDown()) return skip("worker stopping");

  const balance = await spendableBalanceSol(agent);
  // Live wallets that will hold tokens must keep enough SOL for any sell to pay for itself (finding F7).
  const reserve = isPaper(agent) ? agent.minReserveSol : Math.max(agent.minReserveSol, liveSellReserveSol(config.maxPriorityFeeLamports));
  const size = sizeBuy({ ...agent, minReserveSol: reserve }, { solAmount: ev.solAmount, buyFraction: ev.buyFraction }, balance, config.hardMaxPerTradeSol);
  if ("skip" in size) return skip(size.skip, size.intendedSol);
  if (!isPaper(agent) && size.sol < config.minLiveTradeSol) return skip(`below the ${config.minLiveTradeSol} SOL live minimum`, size.sol);

  const lamports = BigInt(Math.floor(size.sol * LAMPORTS_PER_SOL));
  const slippageBps = clampSlippageBps(agent.slippageBps);
  const ref = priceRef(ev);
  const sent: string[] = [];
  try {
    const fill = isPaper(agent)
      ? await paperBuy(ev.mint, lamports, slippageBps, ref)
      : await withAgentSigner(agent, (signer) =>
          liveBuy(signer, ev.mint, lamports, slippageBps, {
            ref,
            hooks: journalHooks(
              tradeId,
              {
                kind: "copy_buy",
                agentId: agent.id,
                owner: agent.depositAddress,
                mint: ev.mint,
                traderId: ev.traderId,
                symbol: ev.symbol,
                decimals: ev.decimals,
                refMs: ev.blockTime.getTime(),
              },
              sent,
            ),
          }),
        );
    const latencyMs = latencySince(ev.blockTime);
    await persistFill(fill, () =>
      recordBuy(agent, tradeId, { traderId: ev.traderId, mint: ev.mint, symbol: ev.symbol, decimals: ev.decimals, latencyMs }, fill),
    );
    return { status: "filled", fill };
  } catch (err) {
    if (err instanceof InFlightError) return { status: "pending", reason: err.reason };
    if (err instanceof TradeSkip) return skip(err.reason, size.sol);
    // Failed rows keep the intended size so the log shows what was attempted.
    const { reason, signature } = reasonOf(err);
    await finishTrade(tradeId, { status: "failed", reason, signature, solAmount: size.sol });
    await pauseOnSealError(agent, err);
    return { status: "failed", reason };
  } finally {
    sent.forEach(markDone);
  }
}

// ── Sells ──────────────────────────────────────────────────────────────────────────────────────

/** Consistent zero reads for an old sleeve: clear it, keeping what it held in the trade log (holdings.ts re-adopts). */
async function clearStaleSleeve(agent: Agent, position: Position, tradeId: string): Promise<Outcome> {
  const reason = `no tokens on-chain (sleeve of ${position.rawAmount} cleared)`;
  await prisma.$transaction([
    prisma.position.deleteMany({ where: { id: position.id } }),
    prisma.copyTrade.update({ where: { id: tradeId }, data: { status: "skipped", reason: reason.slice(0, 200), tokenRaw: position.rawAmount, solAmount: 0 } }),
  ]);
  log.warn("cleared stale sleeve", { agent: agent.name, mint: position.mint });
  return { status: "skipped", reason };
}

/** Sell `raw` from one sleeve (copy sell, retry, close-all). Throws TradeError / InFlightError on failure. */
/** Cost basis of `raw` out of the sleeve, in lamports (a size estimate for fees), or null when unknown. */
function sleeveCostLamports(position: Pick<Position, "rawAmount" | "costSol">, raw: bigint): bigint | null {
  try {
    const held = BigInt(position.rawAmount);
    if (held <= BigInt(0) || !(position.costSol > 0)) return null;
    const share = raw >= held ? 1 : Number((raw * BigInt(1_000_000)) / held) / 1_000_000;
    return BigInt(Math.floor(position.costSol * share * 1e9));
  } catch {
    return null;
  }
}

async function executeSell(
  agent: Agent,
  position: Position,
  raw: bigint,
  tradeId: string,
  refMs: number | null,
  slippageBps: number,
): Promise<Outcome> {
  let fill: Fill | SellFill;
  const sent: string[] = [];
  try {
    fill = isPaper(agent)
      ? await paperSell(position.mint, raw, slippageBps)
      : await withAgentSigner(agent, (signer) =>
          liveSell(signer, position.mint, raw, slippageBps, {
            estSolOutLamports: sleeveCostLamports(position, raw),
            hooks: journalHooks(
              tradeId,
              {
                kind: "copy_sell",
                agentId: agent.id,
                owner: agent.depositAddress,
                mint: position.mint,
                positionId: position.id,
                traderId: position.traderId,
                decimals: position.decimals,
                refMs,
              },
              sent,
            ),
          }),
        );
    const latencyMs = refMs !== null ? latencySince(refMs) : null;
    let feeSol = 0;
    await persistFill(fill, async () => {
      feeSol = (await recordSell(agent, tradeId, position.id, fill, latencyMs, position.decimals)).feeSol;
    });
    if (feeSol > 0 && !isPaper(agent)) requestFeeSweep(agent.id);
    return { status: "filled", fill };
  } catch (err) {
    if (err instanceof NothingOnChainError) {
      if (Date.now() - position.updatedAt.getTime() < RECENT_SLEEVE_MS) {
        throw new TradeError("tokens not visible on-chain yet", null, true);
      }
      return clearStaleSleeve(agent, position, tradeId);
    }
    await pauseOnSealError(agent, err);
    throw err;
  } finally {
    sent.forEach(markDone);
  }
}

/**
 * Copy sell with retries: a retryable failure parks the row as "retrying" (sellretry.ts) instead of failing it,
 * so a transient error never leaves the agent holding after the trader's exit (finding F6).
 */
async function sellOrPark(agent: Agent, ev: TraderEvent, position: Position, raw: bigint, tradeId: string): Promise<Outcome> {
  try {
    return await executeSell(agent, position, raw, tradeId, ev.blockTime.getTime(), clampSlippageBps(agent.slippageBps));
  } catch (err) {
    if (err instanceof InFlightError) return { status: "pending", reason: err.reason };
    if (!isRetryable(err)) throw err;
    const reason = reasonOf(err).reason;
    await parkSellRetry({
      tradeId,
      agentId: agent.id,
      traderId: ev.traderId,
      mint: ev.mint,
      rawWanted: raw.toString(),
      sellFraction: ev.sellFraction,
      attempt: 1,
      firstAt: Date.now(),
      nextAt: Date.now() + retryDelayMs(1),
      lastReason: reason,
      refMs: ev.blockTime.getTime(),
    });
    return { status: "pending", reason: `retrying: ${reason}` };
  }
}

async function copySell(agent: Agent, ev: TraderEvent, tradeId: string): Promise<Outcome> {
  const skip = async (reason: string): Promise<Outcome> => {
    await finishTrade(tradeId, { status: "skipped", reason });
    return { status: "skipped", reason };
  };
  if (!agent.copySells) return skip("copy sells off");
  if (ev.sellFraction === null) return skip("unknown sell fraction");
  const position = await prisma.position.findUnique({
    where: { agentId_traderId_mint: { agentId: agent.id, traderId: ev.traderId, mint: ev.mint } },
  });
  const park = async (reason: string, rawWanted: bigint | null): Promise<Outcome> => {
    await parkSellRetry({
      tradeId,
      agentId: agent.id,
      traderId: ev.traderId,
      mint: ev.mint,
      rawWanted: rawWanted === null ? null : rawWanted.toString(),
      sellFraction: ev.sellFraction,
      attempt: 0,
      firstAt: Date.now(),
      nextAt: Date.now() + retryDelayMs(1),
      lastReason: reason,
      refMs: ev.blockTime.getTime(),
    });
    return { status: "pending", reason };
  };
  if (!position || BigInt(position.rawAmount) <= ZERO) {
    // The copy buy of this sleeve may still be settling (broadcast, being recorded): wait for it rather than miss
    // the exit (findings F2 / F21).
    const settling = await prisma.copyTrade.count({
      where: { agentId: agent.id, traderId: ev.traderId, mint: ev.mint, side: "buy", status: { in: ["pending", "sending"] } },
    });
    if (settling > 0) return park("waiting for the copy buy to settle", null);
    return skip("not holding");
  }
  const raw = sizeSell(BigInt(position.rawAmount), ev.sellFraction);
  if (raw <= ZERO) return skip("sell size rounds to zero");
  if (isShuttingDown()) return park("worker stopping; the next worker sells", raw);
  return sellOrPark(agent, ev, position, raw, tradeId);
}

/** One retry attempt of a parked copy sell (runs on the agent's queue; wired in index.ts). */
export async function retryCopySell(rec: SellRetry): Promise<void> {
  const row = await prisma.copyTrade.findUnique({ where: { id: rec.tradeId }, select: { status: true } });
  if (!row || row.status !== "retrying") {
    await dropSellRetry(rec.tradeId);
    return;
  }
  const done = async (status: "skipped" | "failed", reason: string) => {
    await finishTrade(rec.tradeId, { status, reason });
    await dropSellRetry(rec.tradeId);
  };
  const agent = await prisma.agent.findUnique({ where: { id: rec.agentId } });
  if (!agent || !workerHandlesMode(agent.mode)) return done("skipped", "agent unavailable; sell not retried");
  if (agent.status !== "active") return done("skipped", `agent ${agent.status}; sell not retried`);
  if (Date.now() - rec.firstAt > SELL_RETRY_WINDOW_MS) {
    return done("failed", `exit failed after ${rec.attempt} attempt(s): ${rec.lastReason}`);
  }
  const position = await prisma.position.findUnique({
    where: { agentId_traderId_mint: { agentId: agent.id, traderId: rec.traderId, mint: rec.mint } },
  });
  if (!position || BigInt(position.rawAmount) <= ZERO) {
    const settling = await prisma.copyTrade.count({
      where: { agentId: agent.id, traderId: rec.traderId, mint: rec.mint, side: "buy", status: { in: ["pending", "sending"] } },
    });
    if (settling > 0) {
      await parkSellRetry({ ...rec, nextAt: Date.now() + retryDelayMs(Math.max(1, rec.attempt)) });
      return;
    }
    return done("skipped", rec.attempt === 0 ? "not holding" : "sleeve already closed");
  }
  const sleeve = BigInt(position.rawAmount);
  let raw = rec.rawWanted !== null ? BigInt(rec.rawWanted) : rec.sellFraction !== null ? sizeSell(sleeve, rec.sellFraction) : ZERO;
  if (raw > sleeve) raw = sleeve;
  if (raw <= ZERO) return done("skipped", "sell size rounds to zero");

  try {
    await executeSell(agent, position, raw, rec.tradeId, rec.refMs, retrySlippageBps(clampSlippageBps(agent.slippageBps), rec.attempt));
    await dropSellRetry(rec.tradeId);
    requestBalanceRefreshIfLive(agent);
  } catch (err) {
    if (err instanceof InFlightError) {
      await dropSellRetry(rec.tradeId); // the row is "sending": inflight.ts finishes it
      return;
    }
    const reason = reasonOf(err).reason;
    const attempt = rec.attempt + 1;
    if (isRetryable(err) && Date.now() - rec.firstAt + retryDelayMs(attempt) <= SELL_RETRY_WINDOW_MS) {
      await parkSellRetry({ ...rec, attempt, lastReason: reason, nextAt: Date.now() + retryDelayMs(attempt) });
      return;
    }
    await finishTrade(rec.tradeId, {
      status: "failed",
      reason: isRetryable(err) ? `exit failed after ${attempt} attempt(s): ${reason}` : reason,
      signature: reasonOf(err).signature,
    });
    await dropSellRetry(rec.tradeId);
    requestBalanceRefreshIfLive(agent);
  }
}

function requestBalanceRefreshIfLive(agent: Pick<Agent, "id" | "mode">): void {
  if (!isPaper(agent)) requestBalanceRefresh(agent.id);
}

// ── In-flight resolution (inflight.ts handlers) ─────────────────────────────────────────────────

async function sendingRow(rec: InflightRecord) {
  if (!rec.tradeId) return null;
  const row = await prisma.copyTrade.findUnique({ where: { id: rec.tradeId } });
  return row && row.status === "sending" && row.signature === rec.signature ? row : null;
}

/** Measure a landed swap for the reconciler; null = keep the record for later. */
async function measureLanded(rec: InflightRecord) {
  const effect = await fetchAgentTxEffect(rec.signature, rec.owner, rec.mint ?? "", { tries: 2 });
  if (effect === "unavailable") {
    if (Date.now() - rec.sentAt < UNMEASURED_GIVE_UP_MS) throw new Error("transaction details not available yet");
    return "give_up" as const;
  }
  return effect;
}

async function failFromResolution(rec: InflightRecord, res: Exclude<InflightResolution, { state: "landed" }>): Promise<void> {
  const reason = res.state === "failed" ? "swap failed on-chain" : "swap did not land (expired)";
  await finishTrade(rec.tradeId!, { status: "failed", reason, signature: rec.signature });
}

export async function resolveCopyBuy(rec: InflightRecord, res: InflightResolution): Promise<void> {
  const row = await sendingRow(rec);
  const agent = await prisma.agent.findUnique({ where: { id: rec.agentId }, select: { id: true, mode: true } });
  if (!row || !agent) {
    await prisma.kv.deleteMany({ where: { key: `inflight:${rec.signature}` } });
    return;
  }
  if (res.state !== "landed") return failFromResolution(rec, res);
  const traderId = rec.traderId ?? row.traderId;
  const effect = await measureLanded(rec);
  if (!traderId || effect === "give_up" || effect === "unattributable" || effect.err || effect.tokenDelta <= ZERO) {
    const reason =
      effect !== "give_up" && effect !== "unattributable" && effect.err
        ? "swap failed on-chain"
        : "swap landed but could not be measured (the holdings check adopts its tokens)";
    await finishTrade(row.id, { status: "failed", reason, signature: rec.signature, solAmount: row.solAmount });
    return;
  }
  const spent = -effect.valueDeltaLamports;
  const fill: Fill = {
    solAmount: Number(spent > ZERO ? spent : ZERO) / LAMPORTS_PER_SOL,
    tokenRaw: effect.tokenDelta,
    decimals: effect.decimals,
    signature: rec.signature,
    venue: "jupiter",
  };
  await recordBuy(agent, row.id, {
    traderId,
    mint: row.mint,
    symbol: rec.symbol ?? row.symbol,
    decimals: rec.decimals ?? row.decimals,
    latencyMs: rec.refMs ? Math.max(0, Date.now() - rec.refMs) : null,
  }, fill);
  requestBalanceRefresh(rec.agentId);
}

export async function resolveCopySell(rec: InflightRecord, res: InflightResolution): Promise<void> {
  const row = await sendingRow(rec);
  const agent = await prisma.agent.findUnique({ where: { id: rec.agentId }, select: { id: true, mode: true } });
  if (!row || !agent) {
    await prisma.kv.deleteMany({ where: { key: `inflight:${rec.signature}` } });
    return;
  }
  if (res.state !== "landed") return failFromResolution(rec, res);
  const effect = await measureLanded(rec);
  if (effect === "give_up" || effect === "unattributable" || effect.err || effect.tokenDelta >= ZERO) {
    const reason = effect !== "give_up" && effect !== "unattributable" && effect.err ? "swap failed on-chain" : "sell landed but could not be measured";
    await finishTrade(row.id, { status: "failed", reason, signature: rec.signature });
    return;
  }
  const fill: SellFill = {
    solAmount: Number(effect.valueDeltaLamports > ZERO ? effect.valueDeltaLamports : ZERO) / LAMPORTS_PER_SOL,
    tokenRaw: -effect.tokenDelta,
    decimals: effect.decimals,
    signature: rec.signature,
    venue: "jupiter",
    exhausted: effect.tokenAfter === ZERO,
  };
  const { feeSol } = await recordSell(agent, row.id, rec.positionId ?? null, fill, rec.refMs ? Math.max(0, Date.now() - rec.refMs) : null, rec.decimals ?? row.decimals);
  if (feeSol > 0) requestFeeSweep(rec.agentId);
  requestBalanceRefresh(rec.agentId);
}

// ── Entry points ───────────────────────────────────────────────────────────────────────────────

async function copyEventForAgent(agentId: string, ev: TraderEvent): Promise<void> {
  const agent = await prisma.agent.findUnique({ where: { id: agentId } });
  if (!agent || agent.status !== "active" || !workerHandlesMode(agent.mode)) return;
  const alog = log.child({ agent: agent.name, trader: ev.traderId.slice(-6) });

  let tradeId: string;
  try {
    const row = await prisma.copyTrade.create({
      data: {
        agentId,
        traderId: ev.traderId,
        eventId: ev.id,
        side: ev.side as Side,
        mint: ev.mint,
        symbol: ev.symbol,
        decimals: ev.decimals,
        status: "pending",
      },
    });
    tradeId = row.id;
  } catch (err) {
    if (isUniqueViolation(err)) return; // already copied (or being copied) — idempotent
    throw err;
  }

  try {
    const venueSkip = copyVenueSkipReason(ev.side, ev.venue, config.copyVenue);
    let outcome: Outcome;
    if (venueSkip) {
      await finishTrade(tradeId, { status: "skipped", reason: venueSkip });
      outcome = { status: "skipped", reason: venueSkip };
    } else {
      outcome = ev.side === "buy" ? await executeBuy(agent, ev, tradeId) : await copySell(agent, ev, tradeId);
    }
    // Money may have moved on-chain: refresh the dashboard balance soon (balance loop, debounced).
    if (outcome.status !== "skipped") requestBalanceRefreshIfLive(agent);
    if (outcome.status === "filled") {
      alog.info(`${ev.side} filled`, {
        mint: ev.mint,
        sol: outcome.fill.solAmount.toFixed(6),
        raw: outcome.fill.tokenRaw.toString(),
        venue: outcome.fill.venue,
        latencyMs: latencySince(ev.blockTime),
      });
    } else if (outcome.status === "failed") {
      alog.warn(`${ev.side} failed`, { mint: ev.mint, reason: outcome.reason });
    } else if (outcome.status === "pending") {
      alog.info(`${ev.side} pending`, { mint: ev.mint, reason: outcome.reason });
    } else {
      alog.info(`${ev.side} skipped`, { mint: ev.mint, reason: outcome.reason });
    }
  } catch (err) {
    if (err instanceof InFlightError) {
      alog.info(`${ev.side} pending`, { mint: ev.mint, reason: err.reason, sig: err.signature ?? undefined });
      return;
    }
    const { reason, signature } = reasonOf(err);
    alog.warn(`${ev.side} failed`, { mint: ev.mint, reason, sig: signature ?? undefined });
    await finishTrade(tradeId, { status: "failed", reason, signature }).catch((e: unknown) =>
      alog.error("could not mark trade failed", { trade: tradeId, err: errText(e) }),
    );
    requestBalanceRefreshIfLive(agent);
  }
}

/**
 * Fan a detected trade out to its agents. Buys: active agents following the trader. Sells: those plus active
 * agents still holding a sleeve of that token from this trader (e.g. after unfollowing). Only enqueues.
 */
export async function dispatchEvent(ev: TraderEvent): Promise<void> {
  const [follows, holders] = await Promise.all([
    prisma.follow.findMany({
      where: { traderId: ev.traderId, agent: { status: "active" } },
      select: { agentId: true, agent: { select: { mode: true } } },
    }),
    ev.side === "sell"
      ? prisma.position.findMany({
          where: { traderId: ev.traderId, mint: ev.mint, rawAmount: { not: "0" }, agent: { status: "active" } },
          select: { agentId: true, agent: { select: { mode: true } } },
        })
      : Promise.resolve([]),
  ]);
  const targets = dispatchTargets(
    ev.side,
    follows.map((f) => ({ agentId: f.agentId, mode: f.agent.mode })),
    holders.map((h) => ({ agentId: h.agentId, mode: h.agent.mode })),
  );
  for (const t of targets) {
    if (!workerHandlesMode(t.mode)) continue;
    enqueueForAgent(t.agentId, () => copyEventForAgent(t.agentId, ev)).catch((err: unknown) =>
      log.error("copy task crashed", { agent: t.agentId, event: ev.id, err: errText(err) }),
    );
  }
}

export interface CloseAllResult {
  sold: number;
  skipped: number;
  failed: number;
  /** Sells broadcast but not settled yet (finished from the chain by inflight.ts). */
  pending: number;
  proceedsSol: number;
  errors: string[];
}

/**
 * Sell every sleeve at 100%. Must run on the agent's queue (commands.ts does). Live agents first adopt
 * explainable untracked tokens (holdings.ts) so they are sold too. Each sell is its own CopyTrade (eventId null)
 * so the owner sees it in the trade log; a retryable failure is retried a couple of times with more slippage.
 */
export async function sellAllPositions(agent: Agent): Promise<CloseAllResult> {
  const result: CloseAllResult = { sold: 0, skipped: 0, failed: 0, pending: 0, proceedsSol: 0, errors: [] };
  if (!isPaper(agent)) {
    await adoptUntrackedHoldings(agent).catch((err: unknown) => log.warn("holdings check before close-all failed", { agent: agent.name, err: errText(err) }));
  }
  const positions = await prisma.position.findMany({ where: { agentId: agent.id }, orderBy: { openedAt: "asc" } });
  const baseSlippage = clampSlippageBps(agent.slippageBps);

  for (const position of positions) {
    if (isShuttingDown()) {
      result.errors.push("stopped early: the worker is shutting down");
      break;
    }
    const raw = BigInt(position.rawAmount);
    const row = await prisma.copyTrade.create({
      data: {
        agentId: agent.id,
        traderId: position.traderId,
        side: "sell",
        mint: position.mint,
        symbol: position.symbol,
        decimals: position.decimals,
        status: "pending",
      },
    });
    if (raw <= ZERO) {
      await prisma.position.deleteMany({ where: { id: position.id } });
      await finishTrade(row.id, { status: "skipped", reason: "empty sleeve" });
      result.skipped++;
      continue;
    }
    for (let attempt = 0; ; attempt++) {
      try {
        const outcome = await executeSell(agent, position, raw, row.id, null, retrySlippageBps(baseSlippage, attempt));
        if (outcome.status === "filled") {
          result.sold++;
          result.proceedsSol += outcome.fill.solAmount;
        } else {
          result.skipped++;
        }
        break;
      } catch (err) {
        if (err instanceof InFlightError) {
          result.pending++;
          break;
        }
        if (isRetryable(err) && attempt + 1 < CLOSE_ALL_ATTEMPTS && !isShuttingDown()) {
          await sleep(CLOSE_ALL_BACKOFF_MS * (attempt + 1));
          continue;
        }
        const { reason, signature } = reasonOf(err);
        result.failed++;
        result.errors.push(`${position.symbol ?? position.mint.slice(0, 6)}: ${reason}`);
        await finishTrade(row.id, { status: "failed", reason, signature }).catch(() => undefined);
        break;
      }
    }
  }
  log.info("close-all finished", { agent: agent.name, sold: result.sold, skipped: result.skipped, failed: result.failed, pending: result.pending });
  return result;
}
