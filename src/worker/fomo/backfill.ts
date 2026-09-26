// Backfill (design §4.2): complete the FOMO history of tracked wallets, one wallet at a time, at P2.
//  - Order: followed > seed > user > discovered, then oldest trackedAt. A wallet only starts once the live
//    stream covers it (subscription before backfill; the overlap is deduped by signature).
//  - cutoff = now − FOMO_BACKFILL_DAYS (37 with gTFA), never before FOMO_MARKER_SINCE (2026-01-06).
//  - gTFA path: getTransactionsForAddress(full, jsonParsed, v1, desc, 100/page, succeeded) — 10 credits a page.
//    Version 1 is verified on the first call; if refused (or unparseable) the process switches to the RPC path.
//  - RPC path: getSignaturesForAddress(before, 1000), drop failed, getTransaction each at concurrency 4.
//  - Stops at the cutoff, at the end of the wallet's history, or at the per-wallet cap (config.fomoBackfillMaxTx).
//    coveredFrom = cutoff when reached (or history ended), else the oldest processed blockTime ("partial").
//  - "gap" state (gaps.ts): the same paging down to gapFrom − 60 s, then coveredFrom returns to its old value.
// The cursor is saved after every page, so a restart resumes where it stopped.

import { config } from "@/lib/config";
import { prisma } from "@/lib/db";
import { classifyFomoTx, FOMO_MARKER_SINCE, normalizeTx, toFomoSwapRow, type FomoSwapRow, type MiniTx } from "@/lib/fomo-chain";
import {
  canSpend,
  getSignatures,
  getTransaction,
  getTransactionsForAddress,
  HELIUS_CREDITS,
  HELIUS_PRIORITY,
  isHeliusError,
} from "@/lib/helius";
import { logger } from "../log";
import { forEachLimit } from "../util";
import { GAP_MARGIN_MS, newCursor, parseCursor, type BackfillCursor } from "./gaps";
import { persistRows } from "./ingest";
import { backfillCutoffMs, backfillOutcome, compareBackfill, HOUR_MS } from "./policy";
import { safeErr, state } from "./state";

const log = logger("fomo-backfill");

/** Pages per tick before re-picking (a newly followed wallet can jump the queue). */
const SLICE_PAGES = 5;
const PICK_CACHE_MS = 15_000;
const GTFA_PAGE = 100;
const RPC_SIG_PAGE = 1_000;
const RPC_CHUNK = 20;
const RPC_CONCURRENCY = 4;
const FAIL_LIMIT = 3;
const FAILED_RETRY_MS = HOUR_MS;
const IDLE_MS = 10_000;
const BUSY_MS = 250;
const BUDGET_WAIT_MS = 60_000;
const ERROR_WAIT_MS = 5_000;

const TRANSIENT = ["throttled", "rate_limited", "network", "timeout"] as const;

let queueCache: { wallet: string; origin: string; trackedAtMs: number | null }[] | null = null;
let queueCacheAt = 0;
const failures = new Map<string, number>();
const failedUntil = new Map<string, number>();

function gtfaUsable(): boolean {
  return state.caps?.gtfa === true && state.gtfaFullOk !== false;
}

/** Number of tracked wallets still waiting for (or in) a backfill or gap repair. */
export async function backfillQueueSize(): Promise<number> {
  return prisma.fomoWallet.count({ where: { status: "tracked", backfillState: { in: ["pending", "running", "gap", "failed"] } } });
}

/** One backfill step (≤ 5 pages of one wallet). Returns the delay before the next step. */
export async function backfillTick(): Promise<number> {
  if (!canSpend(HELIUS_PRIORITY.backfill, gtfaUsable() ? HELIUS_CREDITS.gtfa : HELIUS_CREDITS.rpc)) return BUDGET_WAIT_MS;
  const wallet = await pickNext();
  if (!wallet) return IDLE_MS;
  try {
    await runSlice(wallet);
    failures.delete(wallet);
    return BUSY_MS;
  } catch (err) {
    if (err instanceof CursorChanged) {
      queueCache = null;
      return BUSY_MS;
    }
    if (isHeliusError(err, ...TRANSIENT)) {
      log.debug("backfill paused", { wallet, err: safeErr(err) });
      return isHeliusError(err, "throttled") ? BUDGET_WAIT_MS : ERROR_WAIT_MS;
    }
    const n = (failures.get(wallet) ?? 0) + 1;
    failures.set(wallet, n);
    log.warn("backfill step failed", { wallet, attempt: n, err: safeErr(err) });
    if (n >= FAIL_LIMIT) {
      failures.delete(wallet);
      failedUntil.set(wallet, Date.now() + FAILED_RETRY_MS);
      queueCache = null;
      await prisma.fomoWallet
        .updateMany({ where: { wallet, status: "tracked", backfillState: { in: ["pending", "running"] } }, data: { backfillState: "failed" } })
        .catch(() => undefined);
    }
    return ERROR_WAIT_MS;
  }
}

async function pickNext(): Promise<string | null> {
  const now = Date.now();
  if (!queueCache || now - queueCacheAt > PICK_CACHE_MS) {
    const rows = await prisma.fomoWallet.findMany({
      where: { status: "tracked", backfillState: { in: ["pending", "running", "gap", "failed"] } },
      select: { wallet: true, origin: true, trackedAt: true },
    });
    queueCache = rows
      .map((r) => ({ wallet: r.wallet, origin: r.origin, trackedAtMs: r.trackedAt?.getTime() ?? null }))
      .sort((a, b) => compareBackfill({ ...a, followed: state.followed.has(a.wallet) }, { ...b, followed: state.followed.has(b.wallet) }));
    queueCacheAt = now;
  }
  for (const c of queueCache) {
    if ((failedUntil.get(c.wallet) ?? 0) > now) continue;
    if (!state.isLiveCovered(c.wallet)) continue;
    return c.wallet;
  }
  return null;
}

interface PageResult {
  reachedCutoff: boolean;
  endOfHistory: boolean;
}

/** The cursor was rewritten meanwhile (a gap mark): drop this slice, the next one starts from the new cursor. */
class CursorChanged extends Error {}

/** Optimistic save: only when the stored cursor is still the one this slice started from. Returns the new JSON. */
async function saveCursor(wallet: string, cursor: BackfillCursor, prevJson: string | null): Promise<string> {
  const json = JSON.stringify(cursor);
  const res = await prisma.fomoWallet.updateMany({ where: { wallet, status: "tracked", backfillCursor: prevJson }, data: { backfillCursor: json } });
  if (res.count === 0) throw new CursorChanged();
  return json;
}

function rowsFor(wallet: string, txs: readonly MiniTx[], cursor: BackfillCursor): FomoSwapRow[] {
  const source = cursor.mode === "gap" ? "gapfill" : "backfill";
  const rows: FomoSwapRow[] = [];
  for (const tx of txs) {
    if (tx.blockTimeMs === null || tx.blockTimeMs < cursor.cutoffMs || tx.blockTimeMs < FOMO_MARKER_SINCE) continue;
    const row = toFomoSwapRow(tx, classifyFomoTx(tx, wallet), source);
    if (row) rows.push(row);
  }
  return rows;
}

function track(cursor: BackfillCursor, count: number, oldestMs: number | null): void {
  cursor.processed += count;
  if (oldestMs !== null && (cursor.oldestMs === null || oldestMs < cursor.oldestMs)) cursor.oldestMs = oldestMs;
}

/** Switch a cursor that has not processed anything to the RPC path (gTFA refused). */
function switchToRpc(cursor: BackfillCursor, nowMs: number): void {
  cursor.path = "rpc";
  cursor.token = null;
  cursor.before = null;
  if (cursor.mode === "full") cursor.cutoffMs = backfillCutoffMs(nowMs, config.fomoBackfillDays, FOMO_MARKER_SINCE);
}

async function gtfaPage(wallet: string, cursor: BackfillCursor): Promise<PageResult> {
  let page;
  try {
    page = await getTransactionsForAddress(wallet, {
      priority: HELIUS_PRIORITY.backfill,
      transactionDetails: "full",
      limit: GTFA_PAGE,
      sortOrder: "desc",
      filters: { status: "succeeded" },
      paginationToken: cursor.token,
      maxSupportedTransactionVersion: 1,
    });
  } catch (err) {
    const definitive = isHeliusError(err, "rpc", "invalid_response") || (isHeliusError(err, "http") && err.status !== null && err.status < 500 && err.status !== 429);
    if (state.gtfaFullOk === null && definitive && cursor.processed === 0) {
      state.gtfaFullOk = false;
      log.warn("gTFA full (v1) refused for backfill; using getSignaturesForAddress + getTransaction", { err: safeErr(err) });
      switchToRpc(cursor, Date.now());
      return { reachedCutoff: false, endOfHistory: false };
    }
    throw err;
  }
  const txs = page.data.map(normalizeTx).filter((t): t is MiniTx => t !== null);
  if (state.gtfaFullOk === null) {
    if (page.data.length > 0 && txs.length === 0) {
      state.gtfaFullOk = false;
      log.warn("gTFA full (v1) returned an unexpected payload; using the RPC path for backfill");
      if (cursor.processed === 0) switchToRpc(cursor, Date.now());
      return { reachedCutoff: false, endOfHistory: false };
    }
    if (txs.length > 0) {
      state.gtfaFullOk = true;
      log.info("gTFA full with maxSupportedTransactionVersion 1 verified");
    }
  }

  await persistRows(rowsFor(wallet, txs, cursor));
  let oldest: number | null = null;
  for (const t of txs) if (t.blockTimeMs !== null && (oldest === null || t.blockTimeMs < oldest)) oldest = t.blockTimeMs;
  track(cursor, page.data.length, oldest);
  cursor.token = page.paginationToken;
  return {
    reachedCutoff: oldest !== null && oldest < cursor.cutoffMs,
    endOfHistory: page.paginationToken === null || page.data.length === 0,
  };
}

async function rpcPage(wallet: string, cursor: BackfillCursor): Promise<PageResult> {
  const sigs = await getSignatures(wallet, { priority: HELIUS_PRIORITY.backfill, limit: RPC_SIG_PAGE, before: cursor.before ?? undefined });
  if (sigs.length === 0) return { reachedCutoff: false, endOfHistory: true };

  let reachedCutoff = false;
  const inWindow: typeof sigs = [];
  for (const s of sigs) {
    if (s.blockTime !== null && s.blockTime * 1000 < cursor.cutoffMs) {
      reachedCutoff = true;
      break;
    }
    inWindow.push(s);
  }
  const known = new Set<string>();
  const ok = inWindow.filter((s) => !s.err).map((s) => s.signature);
  for (let i = 0; i < ok.length; i += 500) {
    const rows = await prisma.fomoSwap.findMany({ where: { signature: { in: ok.slice(i, i + 500) } }, select: { signature: true } });
    for (const r of rows) known.add(r.signature);
  }

  for (let i = 0; i < inWindow.length; i += RPC_CHUNK) {
    const chunk = inWindow.slice(i, i + RPC_CHUNK);
    const toFetch = chunk.filter((s) => !s.err && !known.has(s.signature));
    if (!canSpend(HELIUS_PRIORITY.backfill, toFetch.length * HELIUS_CREDITS.rpc) || state.stopping) {
      return { reachedCutoff: false, endOfHistory: false }; // resume from cursor.before next time
    }
    const txs: MiniTx[] = [];
    await forEachLimit(toFetch, RPC_CONCURRENCY, async (s) => {
      const raw = await getTransaction(s.signature, { priority: HELIUS_PRIORITY.backfill });
      const tx = raw ? normalizeTx(raw) : null;
      if (tx) txs.push(tx);
    });
    await persistRows(rowsFor(wallet, txs, cursor));
    let oldest: number | null = null;
    for (const s of chunk) if (s.blockTime !== null && (oldest === null || s.blockTime * 1000 < oldest)) oldest = s.blockTime * 1000;
    track(cursor, chunk.length, oldest);
    cursor.before = chunk[chunk.length - 1]!.signature;
    if (cursor.processed >= config.fomoBackfillMaxTx) return { reachedCutoff: false, endOfHistory: false };
  }
  if (reachedCutoff) return { reachedCutoff: true, endOfHistory: false };
  cursor.before = sigs[sigs.length - 1]!.signature;
  return { reachedCutoff: false, endOfHistory: sigs.length < RPC_SIG_PAGE };
}

async function runSlice(wallet: string): Promise<void> {
  const row = await prisma.fomoWallet.findUnique({
    where: { wallet },
    select: { status: true, backfillState: true, backfillCursor: true, coveredFrom: true, gapFrom: true },
  });
  if (!row || row.status !== "tracked" || !["pending", "running", "gap", "failed"].includes(row.backfillState)) {
    queueCache = null;
    return;
  }
  const now = Date.now();
  // No readable cursor (new wallet, or an unexpected state): a full backfill — it also covers any gap, deduped.
  let cursor = row.backfillState === "pending" ? null : parseCursor(row.backfillCursor);
  cursor ??= newCursor({ mode: "full", cutoffMs: FOMO_MARKER_SINCE }, now);
  if (cursor.path === null) {
    cursor.path = gtfaUsable() ? "gtfa" : "rpc";
    cursor.startedAtMs = now;
    if (cursor.mode === "full") {
      const days = cursor.path === "gtfa" ? config.fomoBackfillDaysGtfa : config.fomoBackfillDays;
      cursor.cutoffMs = backfillCutoffMs(now, days, FOMO_MARKER_SINCE);
    }
  }
  const runningState = cursor.mode === "gap" ? "gap" : "running";
  let json = JSON.stringify(cursor);
  const started = await prisma.fomoWallet.updateMany({
    where: { wallet, status: "tracked", backfillState: row.backfillState, backfillCursor: row.backfillCursor },
    data: { backfillState: runningState, backfillCursor: json },
  });
  if (started.count === 0) throw new CursorChanged();
  if (row.backfillState === "pending") log.info("backfill started", { wallet, path: cursor.path, from: new Date(cursor.cutoffMs).toISOString() });

  let finished: PageResult | null = null;
  for (let page = 0; page < SLICE_PAGES && !finished && !state.stopping; page++) {
    const cost = cursor.path === "gtfa" ? HELIUS_CREDITS.gtfa : HELIUS_CREDITS.rpc;
    if (!canSpend(HELIUS_PRIORITY.backfill, cost)) break;
    const res = cursor.path === "gtfa" ? await gtfaPage(wallet, cursor) : await rpcPage(wallet, cursor);
    if (res.reachedCutoff || res.endOfHistory) finished = res;
    else if (cursor.processed >= config.fomoBackfillMaxTx) finished = { reachedCutoff: false, endOfHistory: false };
    json = await saveCursor(wallet, cursor, json);
  }
  if (finished) await complete(wallet, cursor, finished, json);
}

async function complete(wallet: string, cursor: BackfillCursor, fin: PageResult, json: string): Promise<void> {
  const now = Date.now();
  queueCache = null;
  const where = { wallet, status: "tracked", backfillCursor: json };
  if (cursor.mode === "full") {
    const out = backfillOutcome({ ...fin, cutoffMs: cursor.cutoffMs, oldestMs: cursor.oldestMs, nowMs: now });
    if (cursor.pendingGapFromMs !== null) {
      // The stream missed a stretch while this backfill ran: repair what came after the backfill's start.
      const gapFrom = Math.max(cursor.pendingGapFromMs, cursor.startedAtMs - GAP_MARGIN_MS);
      const next = newCursor({ mode: "gap", cutoffMs: gapFrom - GAP_MARGIN_MS, prevState: out.state, prevCoveredFromMs: out.coveredFromMs }, now);
      const res = await prisma.fomoWallet.updateMany({
        where,
        data: { backfillState: "gap", gapFrom: new Date(gapFrom), coveredFrom: new Date(now), backfillCursor: JSON.stringify(next), statsDirty: true },
      });
      if (res.count === 0) throw new CursorChanged();
      log.info("backfill finished; repairing a stream gap next", { wallet, processed: cursor.processed });
      return;
    }
    const res = await prisma.fomoWallet.updateMany({
      where,
      data: { backfillState: out.state, coveredFrom: new Date(out.coveredFromMs), backfillCursor: null, gapFrom: null, statsDirty: true },
    });
    if (res.count === 0) throw new CursorChanged();
    log.info("backfill finished", {
      wallet,
      state: out.state,
      coveredFrom: new Date(out.coveredFromMs).toISOString(),
      processed: cursor.processed,
      path: cursor.path,
    });
    return;
  }

  // Gap repair.
  const filled = fin.reachedCutoff || fin.endOfHistory;
  const stateAfter = filled ? (cursor.prevState ?? "partial") : "partial";
  const coveredFromMs = filled ? cursor.prevCoveredFromMs : Math.max(cursor.cutoffMs, cursor.oldestMs ?? now);
  const res = await prisma.fomoWallet.updateMany({
    where: { ...where, backfillState: "gap" },
    data: {
      backfillState: stateAfter,
      coveredFrom: coveredFromMs !== null ? new Date(coveredFromMs) : null,
      backfillCursor: null,
      gapFrom: null,
      statsDirty: true,
    },
  });
  if (res.count === 0) throw new CursorChanged();
  log.info(filled ? "history gap repaired" : "history gap only partly repaired (cap)", { wallet, processed: cursor.processed });
}
