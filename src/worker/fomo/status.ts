// Indexer status (design §4.2 status, §2.7 drift): every 10 s Kv "fomo:indexer" (read by GET /api/indexer through
// getIndexerStatus) and the restart resume point Kv "fomo:stream:lastMsgAt". Counts and flags only — never keys,
// URLs or anything from a Helius response.
//
// The resume point is NOT simply the last frame received: it is the earliest of that and every stretch not yet
// durably repaired (an open stream gap, a failing subscribe, a queued / running gap-fill, a queued gap mark, a
// live item not written yet), so a crash or restart never skips a stretch (policy.resumePointMs).

import { config } from "@/lib/config";
import { kvGet, kvSet, prisma } from "@/lib/db";
import { FOMO_INDEXER_KV_KEY, FOMO_STREAM_LAST_MSG_KV_KEY, type FomoIndexerKv } from "@/lib/fomo";
import { meter } from "@/lib/helius";
import { logger } from "../log";
import { backfillQueueSize } from "./backfill";
import { gapFillOutstandingSince } from "./gapfill";
import { pendingGapMarkMinMs } from "./gaps";
import { ingestCounters, ingestQueueSize, oldestUnwrittenLiveMs } from "./ingest";
import { MINUTE_MS, resumePointMs } from "./policy";
import { state } from "./state";

const log = logger("fomo");

const COUNTS_EVERY_MS = 60_000;
const DRIFT_SHARE = 0.05;
const WARN_EVERY_MS = 15 * MINUTE_MS;
const NO_TRADE_WARN_MS = 15 * MINUTE_MS;

let counts = { tracked: 0, candidates: 0, backfillQueue: 0, at: 0 };
let persistedResumeAt: number | null = null;
let lastWarnAt = 0;
let wasThrottled = false;

const iso = (ms: number | null): string | null => (ms !== null ? new Date(ms).toISOString() : null);

/** Kv "fomo:stream:lastMsgAt" (the restart resume point) from the previous run (ms), or null. */
export async function readPersistedLastMsgAt(): Promise<number | null> {
  const row = await kvGet<unknown>(FOMO_STREAM_LAST_MSG_KV_KEY).catch(() => null);
  const t = typeof row?.value === "string" ? Date.parse(row.value) : NaN;
  return Number.isFinite(t) ? t : null;
}

/** The restart resume point now (see the header), or null when nothing is known yet. */
export function currentResumePoint(streamGapSince?: () => number | null): number | null {
  return resumePointMs([state.lastMsgAt, streamGapSince?.() ?? null, gapFillOutstandingSince(), pendingGapMarkMinMs(), oldestUnwrittenLiveMs()]);
}

export async function writeStatus(opts: { final?: boolean; streamGapSince?: () => number | null } = {}): Promise<void> {
  const now = Date.now();
  if (now - counts.at >= COUNTS_EVERY_MS || opts.final) {
    const [tracked, candidates, backfillQueue] = await Promise.all([
      prisma.fomoWallet.count({ where: { status: "tracked" } }),
      prisma.fomoWallet.count({ where: { status: "candidate" } }),
      backfillQueueSize(),
    ]);
    counts = { tracked, candidates, backfillQueue, at: now };
  }
  await meter.sync();
  const snap = meter.snapshot();
  const noMarker = state.noMarkerSwaps.total(now);
  const unknownRouter = state.unknownRouter.total(now);
  const trades = state.trades.total(now);

  const value: FomoIndexerKv & Record<string, unknown> = {
    mode: opts.final ? "off" : state.mode,
    connected: opts.final ? false : state.connected,
    lastMsgAt: iso(state.lastMsgAt),
    lastFomoTradeAt: iso(state.lastFomoTradeAt),
    tracked: counts.tracked,
    candidates: counts.candidates,
    backfillQueue: counts.backfillQueue,
    creditsToday: Math.round(snap.creditsToday),
    capToday: snap.cap,
    pausedPriorities: snap.pausedPriorities,
    plan: config.heliusPlan,
    caps: state.caps ? { ts: state.caps.ts, gtfa: state.caps.gtfa, identity: state.caps.identity } : null,
    noMarkerSwaps1h: noMarker,
    unknownRouter1h: unknownRouter,
    trades1h: trades,
    // Extra diagnostics (the web reads the fields above; these are for operators).
    s1Filter: state.s1Filter,
    uncovered: state.uncovered.size,
    subscribeFailed: state.subscribeFailed.size,
    ingestQueue: ingestQueueSize(),
    ingest: { ...ingestCounters() },
  };
  await kvSet(FOMO_INDEXER_KV_KEY, value);

  const resumeAt = currentResumePoint(opts.streamGapSince);
  if (resumeAt !== null && resumeAt !== persistedResumeAt) {
    await kvSet(FOMO_STREAM_LAST_MSG_KV_KEY, new Date(resumeAt).toISOString());
    persistedResumeAt = resumeAt;
  }

  if (snap.throttled !== wasThrottled) {
    wasThrottled = snap.throttled;
    if (snap.throttled) log.warn("Helius daily credit cap reached: only the copy engine and the live stream run", { creditsToday: Math.round(snap.creditsToday), cap: snap.cap });
    else log.info("Helius credit cap no longer reached");
  }
  if (!opts.final && now - lastWarnAt >= WARN_EVERY_MS) {
    const warn =
      noMarker > DRIFT_SHARE * trades
        ? "FOMO marker may have changed: relayer-paid swaps without it seen in the last hour (check FOMO_MARKERS)"
        : unknownRouter > DRIFT_SHARE * trades && unknownRouter > 0
          ? "FOMO trades are using a swap router we don't know"
          : state.connected && state.tracked.size > 0 && state.lastFomoTradeAt !== null && now - state.lastFomoTradeAt > NO_TRADE_WARN_MS
            ? "no FOMO trade detected in 15 minutes while the stream is connected"
            : null;
    if (warn) {
      lastWarnAt = now;
      log.warn(warn, { noMarkerSwaps1h: noMarker, unknownRouter1h: unknownRouter, trades1h: trades });
    }
  }
}
