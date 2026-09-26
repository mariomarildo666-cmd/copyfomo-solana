// FOMO indexer ingest (design §4.2, §5.7): a bounded queue of normalized transactions → rule R → FomoSwap rows
// for tracked traders, written in batches (≤ 500 rows per transaction, every 250 ms).
//
//  - Sources: stream (S1/S2), logs, watcher (the copy engine hands over its followed wallets' txs, §6.6),
//    gapfill, sample. Backfill writes pages directly through persistRows (same serialized writer).
//  - Dedupe: an in-memory LRU of processed signatures + a DB prefetch (SQLite has no createMany skipDuplicates).
//  - Backpressure: live items are never dropped — when the queue is full the trader's wallet is marked for gap
//    repair instead. Discovery items (S2 / sampler) are dropped above 19,000 queued items.
//  - Per written wallet: statsDirty = true, lastTradeAt = newest trade, evidenceSig = first trade seen.

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { toFomoSwapRow, type FomoSwapRow, type FomoSwapSource, type MiniTx } from "@/lib/fomo-chain";
import { logger } from "../log";
import { LruSet } from "../util";
import { classifyForIngest, traderOf, type IngestClassification } from "./classify";
import { GAP_MARGIN_MS, flushGapMarks, requestGapMark } from "./gaps";
import { admitToIngest, MINUTE_MS, type IngestLane } from "./policy";
import { currentSolUsd } from "./solprice";
import { safeErr, state } from "./state";

const log = logger("fomo-ingest");

const FLUSH_MS = 250;
const BATCH_ITEMS = 500;
const WRITE_CHUNK = 500;
const IN_CHUNK = 500;
const SEEN_MAX = 100_000;
const UNTRACKED_TTL_MS = 60_000;
const RETRY_BACKOFF_MS = 1_000;
/** Rows of transactions this recent get the live SOL/USD price stamped on them. */
const LIVE_PRICE_MAX_AGE_MS = 10 * MINUTE_MS;

const LIVE_SOURCES: ReadonlySet<FomoSwapSource> = new Set<FomoSwapSource>(["stream", "logs", "watcher", "gapfill", "check"]);
/** Drift counters (§2.7) only count what the live stream / watcher sees. */
const DRIFT_SOURCES: ReadonlySet<FomoSwapSource> = new Set<FomoSwapSource>(["stream", "logs", "watcher"]);

interface Item {
  tx: MiniTx;
  source: FomoSwapSource;
  receivedAtMs: number;
  lane: IngestLane;
  /** How many trades this item stands for in the drift counters (a sampled logs notification: > 1). */
  driftWeight: number;
}

/** Earliest time an item may cover: its blockTime (gap-fill items are old) or when it was received. */
const itemTime = (i: Item): number => Math.min(i.receivedAtMs, i.tx.blockTimeMs ?? Number.POSITIVE_INFINITY);

/** FIFO with O(1) push/shift and an unshift for retried batches. */
class ItemQueue {
  private items: Item[] = [];
  private head = 0;

  get size(): number {
    return this.items.length - this.head;
  }

  push(item: Item): void {
    this.items.push(item);
  }

  take(n: number): Item[] {
    const out = this.items.slice(this.head, this.head + n);
    this.head += out.length;
    if (this.head > 4_096 && this.head * 2 > this.items.length) {
      this.items = this.items.slice(this.head);
      this.head = 0;
    }
    return out;
  }

  unshift(batch: Item[]): void {
    this.items = batch.concat(this.items.slice(this.head));
    this.head = 0;
  }

  /** Every queued item, oldest first (no copy). */
  *values(): IterableIterator<Item> {
    for (let i = this.head; i < this.items.length; i++) yield this.items[i]!;
  }
}

const queue = new ItemQueue();
const seen = new LruSet(SEEN_MAX);
const untrackedAt = new Map<string, number>();
let running = false;
let timer: NodeJS.Timeout | undefined;
let flushing: Promise<void> | null = null;
/** The batch flushOnce took off the queue and is writing (lost too if the process dies mid-write). */
let writingBatch: Item[] | null = null;
let retryAt = 0;

const counters = { accepted: 0, droppedDiscovery: 0, refusedLive: 0, written: 0, writeErrors: 0 };

// ── Public API ──────────────────────────────────────────────────────────────────────────────────────

/**
 * Hand one normalized transaction to the indexer (design §6.6: the copy engine's watcher calls this for the
 * wallets it follows, with source "watcher"). Classified with rule R later; only trade / convert / xchain rows
 * of tracked traders are stored. Returns false when not accepted (indexer off, discovery item dropped, or the
 * queue is full — a live item then marks its trader's wallet for gap repair). Never throws.
 */
export function enqueueFomoTx(
  tx: MiniTx,
  source: FomoSwapSource,
  opts: { receivedAtMs?: number; lane?: IngestLane; driftWeight?: number } = {},
): boolean {
  if (!running || !tx || typeof tx.signature !== "string") return false;
  if (seen.has(tx.signature)) return true;
  const receivedAtMs = opts.receivedAtMs ?? Date.now();
  const lane: IngestLane = opts.lane ?? (LIVE_SOURCES.has(source) ? "live" : "discovery");
  const verdict = admitToIngest(queue.size, lane);
  if (verdict === "drop") {
    counters.droppedDiscovery++;
    return false;
  }
  if (verdict === "gap") {
    counters.refusedLive++;
    const trader = traderOf(tx);
    if (trader && state.tracked.has(trader)) requestGapMark(trader, (tx.blockTimeMs ?? receivedAtMs) - GAP_MARGIN_MS, "ingest queue full");
    return false;
  }
  const driftWeight = opts.driftWeight !== undefined && Number.isFinite(opts.driftWeight) && opts.driftWeight > 0 ? opts.driftWeight : 1;
  queue.push({ tx, source, receivedAtMs, lane, driftWeight });
  counters.accepted++;
  return true;
}

export function ingestQueueSize(): number {
  return queue.size;
}

/** Ingest accepts items (started and not stopped). */
export function ingestRunning(): boolean {
  return running;
}

/**
 * Earliest time covered by a live item not written yet (queued or being written), or null. Part of the restart
 * resume point: a crash loses these items, so a restart must gap-fill from here.
 */
export function oldestUnwrittenLiveMs(): number | null {
  let min: number | null = null;
  const consider = (i: Item) => {
    if (i.lane !== "live") return;
    const t = itemTime(i);
    if (Number.isFinite(t) && (min === null || t < min)) min = t;
  };
  for (const i of queue.values()) consider(i);
  if (writingBatch) for (const i of writingBatch) consider(i);
  return min;
}

export function ingestCounters(): Readonly<typeof counters> {
  return { ...counters };
}

/** Signature already processed (FOMO or not) by this process. */
export function isSeen(signature: string): boolean {
  return seen.has(signature);
}

export function markSeen(signature: string): void {
  seen.add(signature);
}

export function startIngest(): void {
  if (running) return;
  running = true;
  schedule(FLUSH_MS);
}

/**
 * Stop accepting items and write what is queued (≤ timeoutMs). Live items that could not be written are handed
 * to the P2 backfill loop (durable gap marks per trader), so they are repaired whatever the restart resume point.
 */
export async function stopIngest(timeoutMs = 5_000): Promise<void> {
  running = false;
  clearTimeout(timer);
  const deadline = Date.now() + timeoutMs;
  const drain = async () => {
    if (flushing) await flushing.catch(() => undefined);
    while (queue.size > 0 && Date.now() < deadline) {
      const before = queue.size;
      await flushOnce().catch((err: unknown) => log.warn("final ingest flush failed", { err: safeErr(err) }));
      if (queue.size >= before) break; // write failing: give up and mark the gaps below
    }
    const left = markUnwrittenAsGaps();
    if (left > 0) log.warn("ingest stopped with unwritten items; their traders are marked for gap repair", { items: left });
    await flushGapMarks().catch(() => undefined);
  };
  await Promise.race([drain(), new Promise((r) => setTimeout(r, timeoutMs + 1_000))]);
}

/** Queue a gap mark for the trader of every unwritten live item of a tracked wallet. Returns the item count. */
function markUnwrittenAsGaps(): number {
  let n = 0;
  for (const i of queue.values()) {
    n++;
    if (i.lane !== "live") continue;
    const trader = traderOf(i.tx);
    if (trader && state.tracked.has(trader)) requestGapMark(trader, itemTime(i) - GAP_MARGIN_MS, "ingest stopped");
  }
  return n;
}

// ── Flush loop ──────────────────────────────────────────────────────────────────────────────────────

function schedule(delay: number): void {
  if (!running) return;
  clearTimeout(timer);
  timer = setTimeout(() => {
    flushing = (Date.now() < retryAt ? Promise.resolve() : flushOnce())
      .catch((err: unknown) => log.warn("ingest flush failed", { err: safeErr(err) }))
      .finally(() => {
        flushing = null;
        schedule(FLUSH_MS);
      });
  }, delay);
}

async function flushOnce(): Promise<void> {
  if (queue.size === 0) return;
  const batch = queue.take(BATCH_ITEMS);
  writingBatch = batch;
  try {
    await writeBatch(batch);
  } catch (err) {
    // Keep the items (in order) and retry shortly; live items are never dropped. This also covers a failed
    // tracked-wallet lookup before the write (the batch used to be lost then).
    queue.unshift(batch);
    retryAt = Date.now() + RETRY_BACKOFF_MS;
    counters.writeErrors++;
    throw err;
  } finally {
    writingBatch = null;
  }
}

async function writeBatch(batch: Item[]): Promise<void> {
  const now = Date.now();
  const solUsd = currentSolUsd();

  const results: { item: Item; c: IngestClassification }[] = [];
  const unknown = new Set<string>();
  const batchSigs = new Set<string>();
  for (const item of batch) {
    const sig = item.tx.signature;
    if (seen.has(sig) || batchSigs.has(sig)) continue;
    batchSigs.add(sig);
    const t = item.tx.blockTimeMs ?? item.receivedAtMs;
    const c = classifyForIngest(item.tx, item.source, (w) => state.tracked.has(w), {
      receivedAtMs: item.receivedAtMs,
      solUsd: Math.abs(now - t) <= LIVE_PRICE_MAX_AGE_MS ? solUsd : null,
    });
    results.push({ item, c });
    if (c.untrackedUser && c.user) {
      const at = untrackedAt.get(c.user);
      if (at === undefined || now - at > UNTRACKED_TTL_MS) unknown.add(c.user);
    }
  }

  // Wallets tracked since the last refresh (e.g. just followed): check the DB before discarding their rows.
  if (unknown.size > 0) {
    const nowTracked = new Set<string>();
    const users = [...unknown];
    for (let i = 0; i < users.length; i += IN_CHUNK) {
      const rows = await prisma.fomoWallet.findMany({
        where: { wallet: { in: users.slice(i, i + IN_CHUNK) }, status: "tracked" },
        select: { wallet: true, origin: true, trackedAt: true, lastTradeAt: true },
      });
      for (const r of rows) {
        nowTracked.add(r.wallet);
        state.tracked.set(r.wallet, { origin: r.origin, trackedAtMs: r.trackedAt?.getTime() ?? null, lastTradeAtMs: r.lastTradeAt?.getTime() ?? null });
      }
    }
    for (const u of users) {
      if (nowTracked.has(u)) untrackedAt.delete(u);
      else untrackedAt.set(u, now);
    }
    if (untrackedAt.size > 50_000) untrackedAt.clear();
    for (const r of results) {
      if (r.c.row || !r.c.user || !nowTracked.has(r.c.user)) continue;
      const t = r.item.tx.blockTimeMs ?? r.item.receivedAtMs;
      r.c.row = toFomoSwapRow(r.item.tx, r.c.cls, r.item.source, {
        receivedAtMs: r.item.receivedAtMs,
        solUsd: Math.abs(now - t) <= LIVE_PRICE_MAX_AGE_MS ? solUsd : null,
      });
    }
  }

  const rows = results.map((r) => r.c.row).filter((r): r is FomoSwapRow => r !== null);
  await persistRows(rows);

  for (const { item, c } of results) {
    seen.add(item.tx.signature);
    if (!DRIFT_SOURCES.has(item.source)) continue;
    if (c.drift.unmarkedSwap) state.noMarkerSwaps.add(item.driftWeight, now);
    if (c.drift.trade) {
      state.trades.add(item.driftWeight, now);
      if (c.drift.unknownRouter) state.unknownRouter.add(item.driftWeight, now);
      const t = item.tx.blockTimeMs ?? item.receivedAtMs;
      if (state.lastFomoTradeAt === null || t > state.lastFomoTradeAt) state.lastFomoTradeAt = t;
    }
  }
}

// ── Serialized writer (ingest flush, backfill, gap-fill) ────────────────────────────────────────────

let writeChain: Promise<unknown> = Promise.resolve();

/**
 * Insert FomoSwap rows that are not stored yet and update their wallets (statsDirty, lastTradeAt, evidenceSig).
 * All writers go through one chain, so the signature prefetch and the insert never race each other.
 */
export function persistRows(rows: readonly FomoSwapRow[]): Promise<{ inserted: number }> {
  const run = writeChain.then(() => writeRows(rows));
  writeChain = run.catch(() => undefined);
  return run;
}

async function existingSignatures(sigs: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  for (let i = 0; i < sigs.length; i += IN_CHUNK) {
    const rows = await prisma.fomoSwap.findMany({ where: { signature: { in: sigs.slice(i, i + IN_CHUNK) } }, select: { signature: true } });
    for (const r of rows) out.add(r.signature);
  }
  return out;
}

function walletUpdates(rows: readonly FomoSwapRow[]): Prisma.PrismaPromise<unknown>[] {
  const wallets = [...new Set(rows.map((r) => r.wallet))];
  const ops: Prisma.PrismaPromise<unknown>[] = [
    prisma.fomoWallet.updateMany({ where: { wallet: { in: wallets } }, data: { statsDirty: true } }),
  ];
  const newest = new Map<string, Date>();
  const firstTrade = new Map<string, string>();
  for (const r of rows) {
    if (r.kind !== "buy" && r.kind !== "sell") continue;
    const prev = newest.get(r.wallet);
    if (!prev || r.blockTime > prev) newest.set(r.wallet, r.blockTime);
    if (!firstTrade.has(r.wallet)) firstTrade.set(r.wallet, r.signature);
  }
  for (const [wallet, t] of newest) {
    ops.push(
      prisma.fomoWallet.updateMany({
        where: { wallet, OR: [{ lastTradeAt: null }, { lastTradeAt: { lt: t } }] },
        data: { lastTradeAt: t },
      }),
    );
  }
  for (const [wallet, sig] of firstTrade) {
    ops.push(prisma.fomoWallet.updateMany({ where: { wallet, evidenceSig: null }, data: { evidenceSig: sig } }));
  }
  return ops;
}

function isKnownRequestError(err: unknown, ...codes: string[]): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && codes.includes(err.code);
}

async function writeRows(input: readonly FomoSwapRow[]): Promise<{ inserted: number }> {
  if (input.length === 0) return { inserted: 0 };
  const unique = new Map<string, FomoSwapRow>();
  for (const r of input) if (!unique.has(r.signature)) unique.set(r.signature, r);
  const known = await existingSignatures([...unique.keys()]);
  const fresh = [...unique.values()].filter((r) => !known.has(r.signature));
  let inserted = 0;

  for (let i = 0; i < fresh.length; i += WRITE_CHUNK) {
    const chunk = fresh.slice(i, i + WRITE_CHUNK);
    try {
      await prisma.$transaction([prisma.fomoSwap.createMany({ data: chunk }), ...walletUpdates(chunk)]);
      inserted += chunk.length;
    } catch (err) {
      if (!isKnownRequestError(err, "P2002", "P2003")) throw err;
      // A duplicate or a wallet row that vanished: isolate the offending rows instead of retrying forever.
      const ok: FomoSwapRow[] = [];
      for (const row of chunk) {
        try {
          await prisma.fomoSwap.create({ data: row });
          ok.push(row);
        } catch (rowErr) {
          if (isKnownRequestError(rowErr, "P2002")) continue;
          if (isKnownRequestError(rowErr, "P2003")) {
            log.warn("FOMO swap skipped: wallet row missing", { wallet: row.wallet, sig: row.signature });
            continue;
          }
          throw rowErr;
        }
      }
      if (ok.length > 0) await prisma.$transaction(walletUpdates(ok));
      inserted += ok.length;
    }
  }
  counters.written += inserted;
  return { inserted };
}
