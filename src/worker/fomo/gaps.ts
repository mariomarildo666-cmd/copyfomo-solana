// Backfill cursor (FomoWallet.backfillCursor, JSON) and gap marking.
//
// A "gap" is a stretch of a tracked wallet's history the live stream missed (worker down > 6 h, a gap-fill that
// failed or was too expensive for P1, a live item refused by a full ingest queue). Marking it hands the repair
// to the P2 backfill loop:
//  - done / partial → state "gap": the backfill pages newest → oldest down to gapFrom − 60 s. Until then
//    coveredFrom = the marking time (history is only known complete from there), so every window reads
//    "partial" and the wallet is not ranked; afterwards coveredFrom returns to its previous value.
//  - running (full backfill in progress) → remembered in the cursor and repaired right after it finishes.
//  - gap → gapFrom = the earlier of both; paging restarts from the newest transaction.
//  - pending → nothing to do (the full backfill will start from the newest transaction anyway).

import { z } from "zod";
import { prisma } from "@/lib/db";
import { logger } from "../log";
import { MINUTE_MS } from "./policy";
import { safeErr } from "./state";

const log = logger("fomo");

/** Gap-fill pages until blockTime < gapFrom − 60 s (clock skew / receive-time blockTimes). */
export const GAP_MARGIN_MS = MINUTE_MS;

export interface BackfillCursor {
  v: 1;
  /** "full": the backfill window of a newly tracked wallet. "gap": repair down to cutoffMs. */
  mode: "full" | "gap";
  /** Chosen on the first page; pagination tokens do not mix. null: not started. */
  path: "gtfa" | "rpc" | null;
  /** gTFA paginationToken of the next page. */
  token: string | null;
  /** RPC path: oldest fully processed signature (getSignaturesForAddress `before`). */
  before: string | null;
  /** Stop once transactions are older than this. */
  cutoffMs: number;
  startedAtMs: number;
  /** Transactions processed so far (per-wallet cap: config.fomoBackfillMaxTx). */
  processed: number;
  oldestMs: number | null;
  /** Gap mode: state and coveredFrom to restore once the gap is filled. */
  prevState: "done" | "partial" | null;
  prevCoveredFromMs: number | null;
  /** A gap noticed while a full backfill was running (repaired right after it). */
  pendingGapFromMs: number | null;
}

const cursorSchema = z.object({
  v: z.literal(1),
  mode: z.enum(["full", "gap"]),
  path: z.enum(["gtfa", "rpc"]).nullable(),
  token: z.string().nullable(),
  before: z.string().nullable(),
  cutoffMs: z.number(),
  startedAtMs: z.number(),
  processed: z.number(),
  oldestMs: z.number().nullable(),
  prevState: z.enum(["done", "partial"]).nullable(),
  prevCoveredFromMs: z.number().nullable(),
  pendingGapFromMs: z.number().nullable(),
});

export function parseCursor(raw: string | null | undefined): BackfillCursor | null {
  if (!raw) return null;
  try {
    const r = cursorSchema.safeParse(JSON.parse(raw));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

export function newCursor(p: Pick<BackfillCursor, "mode" | "cutoffMs"> & Partial<BackfillCursor>, nowMs: number): BackfillCursor {
  return {
    v: 1,
    path: null,
    token: null,
    before: null,
    startedAtMs: nowMs,
    processed: 0,
    oldestMs: null,
    prevState: null,
    prevCoveredFromMs: null,
    pendingGapFromMs: null,
    ...p,
  };
}

/** Hand a missed stretch [gapFromMs, now] of these wallets to the P2 backfill loop. Never throws. */
export async function markGaps(wallets: readonly string[], gapFromMs: number, reason: string): Promise<number> {
  if (wallets.length === 0 || !Number.isFinite(gapFromMs)) return 0;
  const now = Date.now();
  let marked = 0;
  for (let i = 0; i < wallets.length; i += 200) {
    const chunk = wallets.slice(i, i + 200);
    let rows;
    try {
      rows = await prisma.fomoWallet.findMany({ where: { wallet: { in: [...chunk] }, status: "tracked" }, select: GAP_ROW_SELECT });
    } catch (err) {
      log.warn("gap marking failed", { wallets: chunk.length, err: safeErr(err) });
      continue;
    }
    for (const r of rows) {
      try {
        if (await markOne(r, gapFromMs, now)) marked++;
      } catch (err) {
        log.warn("gap marking failed", { wallet: r.wallet, err: safeErr(err) });
      }
    }
  }
  if (marked > 0) log.warn("history gap handed to backfill", { wallets: marked, from: new Date(gapFromMs).toISOString(), reason });
  return marked;
}

const GAP_ROW_SELECT = { wallet: true, status: true, backfillState: true, backfillCursor: true, coveredFrom: true, gapFrom: true } as const;
/** A conditional update that lost a race (backfill saved its cursor meanwhile) is re-read and retried. */
const MARK_ATTEMPTS = 5;

interface GapRow {
  wallet: string;
  status: string;
  backfillState: string;
  backfillCursor: string | null;
  coveredFrom: Date | null;
  gapFrom: Date | null;
}

/**
 * The cursor of a wallet already in gap repair that is marked again: the repair restarts from the newest
 * transaction down to the earlier of both gaps, so the paging position AND the per-run progress (processed,
 * oldestMs) restart too — otherwise a capped run would report coverage from the previous run's oldestMs, older
 * than the new gap it never reached.
 */
export function remarkGapCursor(cursor: BackfillCursor | null, fromMs: number, nowMs: number): BackfillCursor {
  const next: BackfillCursor = cursor ? { ...cursor } : newCursor({ mode: "gap", cutoffMs: fromMs - GAP_MARGIN_MS }, nowMs);
  next.cutoffMs = Math.min(next.cutoffMs, fromMs - GAP_MARGIN_MS);
  next.token = null;
  next.before = null;
  next.startedAtMs = nowMs;
  next.processed = 0;
  next.oldestMs = null;
  return next;
}

async function markOne(row: GapRow, gapFromMs: number, now: number): Promise<boolean> {
  let r: GapRow | null = row;
  for (let attempt = 0; attempt < MARK_ATTEMPTS; attempt++) {
    if (!r || r.status !== "tracked") return false;
    const res = await tryMarkOne(r, gapFromMs, now);
    if (res !== "conflict") return res === "marked";
    r = await prisma.fomoWallet.findUnique({ where: { wallet: row.wallet }, select: GAP_ROW_SELECT });
  }
  log.warn("gap marking kept losing a race with the backfill; gap not recorded", { wallet: row.wallet, from: new Date(gapFromMs).toISOString() });
  return false;
}

/** One conditional write, only if the row still has the state AND cursor it was read with. */
async function tryMarkOne(r: GapRow, gapFromMs: number, now: number): Promise<"marked" | "skipped" | "conflict"> {
  const cursor = parseCursor(r.backfillCursor);
  const where = { wallet: r.wallet, status: "tracked", backfillState: r.backfillState, backfillCursor: r.backfillCursor };
  const write = async (data: Parameters<typeof prisma.fomoWallet.updateMany>[0]["data"]) =>
    (await prisma.fomoWallet.updateMany({ where, data })).count > 0 ? "marked" : "conflict";

  if (r.backfillState === "pending") return "skipped";

  if ((r.backfillState === "running" || r.backfillState === "failed") && cursor?.mode === "full") {
    cursor.pendingGapFromMs = Math.min(cursor.pendingGapFromMs ?? gapFromMs, gapFromMs);
    return write({ backfillCursor: JSON.stringify(cursor) });
  }

  if (r.backfillState === "gap" || cursor?.mode === "gap") {
    const from = Math.min(r.gapFrom?.getTime() ?? gapFromMs, gapFromMs);
    const next = remarkGapCursor(cursor, from, now);
    return write({ backfillState: "gap", gapFrom: new Date(from), coveredFrom: new Date(now), backfillCursor: JSON.stringify(next), statsDirty: true });
  }

  if (r.backfillState === "done" || r.backfillState === "partial") {
    const next = newCursor(
      {
        mode: "gap",
        cutoffMs: gapFromMs - GAP_MARGIN_MS,
        prevState: r.backfillState,
        prevCoveredFromMs: r.coveredFrom?.getTime() ?? null,
      },
      now,
    );
    return write({ backfillState: "gap", gapFrom: new Date(gapFromMs), coveredFrom: new Date(now), backfillCursor: JSON.stringify(next), statsDirty: true });
  }

  // "failed" without a cursor restarts from scratch anyway.
  return "skipped";
}

// ── Coalesced marking for synchronous callers (ingest backpressure) ─────────────────────────────────

const pendingMarks = new Map<string, { from: number; reason: string }>();
let markTimer: NodeJS.Timeout | undefined;

/** Queue a gap mark (earliest gapFrom per wallet wins); written within ~2 s. */
export function requestGapMark(wallet: string, gapFromMs: number, reason: string): void {
  if (!Number.isFinite(gapFromMs)) return;
  const prev = pendingMarks.get(wallet);
  if (!prev || gapFromMs < prev.from) pendingMarks.set(wallet, { from: gapFromMs, reason });
  if (markTimer) return;
  markTimer = setTimeout(() => {
    markTimer = undefined;
    void flushGapMarks();
  }, 2_000);
}

/** Earliest gapFrom of the marks queued but not written yet (part of the restart resume point), or null. */
export function pendingGapMarkMinMs(): number | null {
  let min: number | null = null;
  for (const m of pendingMarks.values()) if (min === null || m.from < min) min = m.from;
  return min;
}

/** Write queued gap marks now (also called on shutdown). */
export async function flushGapMarks(): Promise<void> {
  clearTimeout(markTimer);
  markTimer = undefined;
  const groups = new Map<string, { from: number; reason: string; wallets: string[] }>();
  for (const [wallet, m] of pendingMarks) {
    const key = `${m.from}|${m.reason}`;
    const g = groups.get(key);
    if (g) g.wallets.push(wallet);
    else groups.set(key, { from: m.from, reason: m.reason, wallets: [wallet] });
  }
  pendingMarks.clear();
  for (const g of groups.values()) await markGaps(g.wallets, g.from, g.reason);
}
