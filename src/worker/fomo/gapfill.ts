// Gap-fill after a stream reconnect or a worker restart (design §4.2), P1.
// The missed stretch starts at the last frame received (Kv "fomo:stream:lastMsgAt" across restarts) − 60 s.
// Strategy (policy.planGapFill, cheapest first):
//  - relayer_scan: gTFA full pages over FOMO's relayer, newest → oldest, keeping tracked traders' transactions
//    (every FOMO trade / xchain is relayer-paid): ~10 credits per 100 relayer txs (~5 s of FOMO traffic);
//  - per_wallet:   getSignaturesForAddress + getTransaction per tracked wallet;
//  - mark_gap:     outage > 6 h, or too expensive for P1 → the P2 backfill loop repairs it ("gap" state).
// Wallets still waiting for their first backfill are skipped (it starts from the newest transaction anyway).
// Any failure hands the stretch to the backfill loop instead: history is never silently incomplete. So does a
// shutdown: the running job's unfinished wallets and any job still queued are marked (markGaps) before exit.
// P1 is never paused by the credit meter, so all gap-fills of a UTC day share a budget (policy
// GAP_FILL_DAILY_CAP_SHARE of the cap); past it, gaps go to the P2 backfill loop.

import { config } from "@/lib/config";
import { prisma } from "@/lib/db";
import { FOMO_RELAYERS, normalizeTx, type MiniTx } from "@/lib/fomo-chain";
import { getSignatures, getTransaction, getTransactionsForAddress, HELIUS_CREDITS, HELIUS_PRIORITY, utcDay } from "@/lib/helius";
import { logger } from "../log";
import { forEachLimit } from "../util";
import { traderOf } from "./classify";
import { GAP_MARGIN_MS, markGaps } from "./gaps";
import { enqueueFomoTx, ingestRunning, isSeen } from "./ingest";
import { planGapFill } from "./policy";
import { safeErr, state } from "./state";

const log = logger("fomo-gapfill");

const WALLET_SIG_PAGE = 100;
const WALLET_MAX_PAGES = 10;
const WALLET_CONCURRENCY = 4;
const TX_CONCURRENCY = 4;

interface Job {
  sinceMs: number;
  wallets: Set<string> | "all";
  reasons: Set<string>;
}

let pending: Job | null = null;
let current: Job | null = null;
let running: Promise<void> | null = null;
/** Credits spent by P1 gap-fills today (UTC). In memory: a restart starts the day's count again. */
let spent = { day: utcDay(), credits: 0 };

function spentToday(): number {
  const day = utcDay();
  if (spent.day !== day) spent = { day, credits: 0 };
  return spent.credits;
}

function spend(credits: number): void {
  spentToday();
  spent.credits += credits;
}

/** Enqueue a repaired transaction; after stopIngest the item cannot be stored: fail so the wallet is marked. */
function enqueueRepaired(tx: MiniTx): boolean {
  if (enqueueFomoTx(tx, "gapfill", { lane: "live" })) return true;
  if (!ingestRunning()) throw new Error("ingest stopped");
  return false; // queue full: enqueueFomoTx already marked the trader's wallet
}

/** Repair [sinceMs − 60 s, now] for `wallets` (null: every tracked wallet). Coalesces concurrent requests. */
export function requestGapFill(sinceMs: number, wallets: string[] | null, reason: string): void {
  if (!Number.isFinite(sinceMs)) return;
  if (!pending) pending = { sinceMs, wallets: wallets ? new Set(wallets) : "all", reasons: new Set([reason]) };
  else {
    pending.sinceMs = Math.min(pending.sinceMs, sinceMs);
    pending.reasons.add(reason);
    if (wallets === null) pending.wallets = "all";
    else if (pending.wallets !== "all") for (const w of wallets) pending.wallets.add(w);
  }
  running ??= drain().finally(() => {
    running = null;
  });
}

/** Wait for a running gap-fill (shutdown). */
export async function gapFillIdle(timeoutMs = 5_000): Promise<void> {
  if (running) await Promise.race([running, new Promise((r) => setTimeout(r, timeoutMs))]);
}

/** Start of the oldest stretch a queued or running gap-fill still has to repair (restart resume point), or null. */
export function gapFillOutstandingSince(): number | null {
  const a = pending?.sinceMs ?? null;
  const b = current?.sinceMs ?? null;
  if (a === null) return b;
  return b === null ? a : Math.min(a, b);
}

async function drain(): Promise<void> {
  while (pending && !state.stopping) {
    const job = pending;
    pending = null;
    current = job;
    try {
      await run(job);
    } catch (err) {
      // Unexpected (e.g. the wallet query failed): never drop the stretch silently.
      log.warn("gap-fill failed; handing the stretch to backfill", { err: safeErr(err) });
      await markJob(job, "gap-fill failed");
    } finally {
      current = null;
    }
  }
  if (state.stopping && pending) {
    // Shutdown: a job that never ran would otherwise be forgotten (the restart resume point may be later).
    const job = pending;
    pending = null;
    await markJob(job, "shutdown before gap-fill");
  }
}

async function markJob(job: Job, why: string): Promise<void> {
  const wallets = job.wallets === "all" ? [...state.tracked.keys()] : [...job.wallets];
  await markGaps(wallets, job.sinceMs - GAP_MARGIN_MS, `${[...job.reasons].join("+")}: ${why}`);
}

async function run(job: Job): Promise<void> {
  const since = job.sinceMs - GAP_MARGIN_MS;
  const rows = await prisma.fomoWallet.findMany({
    where: {
      status: "tracked",
      backfillState: { not: "pending" },
      ...(job.wallets === "all" ? {} : { wallet: { in: [...job.wallets] } }),
    },
    select: { wallet: true },
  });
  const wallets = rows.map((r) => r.wallet);
  const now = Date.now();
  const reason = [...job.reasons].join("+");
  const plan = planGapFill({
    gapMs: now - since,
    wallets: wallets.length,
    gtfa: state.caps?.gtfa === true && state.gtfaFullOk !== false,
    capCredits: config.heliusDailyCreditCap,
    spentTodayCredits: spentToday(),
  });
  if (plan.kind === "none") return;
  log.info("gap-fill", { reason, plan: plan.kind, wallets: wallets.length, gapSec: Math.round((now - since) / 1000) });

  if (plan.kind === "mark_gap") {
    await markGaps(wallets, since, `${reason}: ${plan.reason}`);
    return;
  }
  if (plan.kind === "relayer_scan") {
    try {
      const n = await scanRelayer(since, job.wallets === "all" ? null : new Set(wallets), plan.maxPages);
      log.info("gap-fill done", { via: "relayer", txs: n });
    } catch (err) {
      log.warn("relayer gap-fill failed; handing the stretch to backfill", { err: safeErr(err) });
      await markGaps(wallets, since, `${reason}: relayer scan failed`);
    }
    return;
  }

  const failed: string[] = [];
  let txs = 0;
  await forEachLimit(wallets, WALLET_CONCURRENCY, async (w) => {
    if (state.stopping) {
      failed.push(w);
      return;
    }
    try {
      txs += await fillWallet(w, since);
    } catch (err) {
      log.debug("wallet gap-fill failed", { wallet: w, err: safeErr(err) });
      failed.push(w);
    }
  });
  if (failed.length > 0) await markGaps(failed, since, `${reason}: per-wallet fill failed`);
  log.info("gap-fill done", { via: "wallets", wallets: wallets.length, txs, failed: failed.length });
}

/** gTFA over the relayer(s) down to `since`; tracked traders' transactions go to ingest. */
async function scanRelayer(since: number, only: Set<string> | null, maxPages: number): Promise<number> {
  let enqueued = 0;
  for (const relayer of FOMO_RELAYERS) {
    let token: string | null = null;
    for (let page = 0; ; page++) {
      if (page >= maxPages) throw new Error(`relayer scan exceeded ${maxPages} pages`);
      if (state.stopping) throw new Error("stopping");
      const res = await getTransactionsForAddress(relayer, {
        priority: HELIUS_PRIORITY.live,
        transactionDetails: "full",
        limit: 100,
        sortOrder: "desc",
        filters: { status: "succeeded" },
        paginationToken: token,
      });
      spend(HELIUS_CREDITS.gtfa);
      let oldest: number | null = null;
      for (const item of res.data) {
        const tx = normalizeTx(item);
        if (!tx || tx.blockTimeMs === null) continue;
        if (oldest === null || tx.blockTimeMs < oldest) oldest = tx.blockTimeMs;
        if (tx.blockTimeMs < since) continue;
        const trader = traderOf(tx);
        if (!trader || !state.tracked.has(trader) || (only && !only.has(trader))) continue;
        if (enqueueRepaired(tx)) enqueued++;
      }
      token = res.paginationToken;
      if (oldest === null || oldest < since || !token) break;
    }
  }
  return enqueued;
}

/** getSignaturesForAddress newest → `since`, then getTransaction for the unseen successful ones. */
async function fillWallet(wallet: string, since: number): Promise<number> {
  let before: string | undefined;
  let enqueued = 0;
  for (let page = 0; page < WALLET_MAX_PAGES; page++) {
    const sigs = await getSignatures(wallet, { priority: HELIUS_PRIORITY.live, limit: WALLET_SIG_PAGE, before });
    spend(HELIUS_CREDITS.rpc);
    let done = sigs.length < WALLET_SIG_PAGE;
    const want: string[] = [];
    for (const s of sigs) {
      if (s.blockTime !== null && s.blockTime * 1000 < since) {
        done = true;
        break;
      }
      if (s.err || isSeen(s.signature)) continue;
      want.push(s.signature);
    }
    const known = new Set(
      want.length
        ? (await prisma.fomoSwap.findMany({ where: { signature: { in: want } }, select: { signature: true } })).map((r) => r.signature)
        : [],
    );
    const txs: MiniTx[] = [];
    await forEachLimit(
      want.filter((s) => !known.has(s)),
      TX_CONCURRENCY,
      async (sig) => {
        spend(HELIUS_CREDITS.rpc);
        const raw = await getTransaction(sig, { priority: HELIUS_PRIORITY.live });
        const tx = raw ? normalizeTx(raw) : null;
        if (tx) txs.push(tx);
      },
    );
    for (const tx of txs) if (enqueueRepaired(tx)) enqueued++;
    if (done) return enqueued;
    before = sigs[sigs.length - 1]!.signature;
  }
  throw new Error("gap longer than the per-wallet page limit");
}
