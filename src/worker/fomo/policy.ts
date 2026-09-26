// Pure policy of the FOMO indexer (design §4.2, §5.6, §5.7, §2.7): no I/O, no Prisma, no network.
// Everything here is unit-tested in policy.test.ts; the loops in this folder only wire it to the DB.

import { MIN_POSITION_COST_USD, type OpenPosition } from "@/lib/fomo-stats";

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

// ── Discovery scoring (§5.6) ────────────────────────────────────────────────────────────────────────

/** Candidate score = USDC volume of sampled trades, decayed exp(−Δt / 3 days). */
export const SCORE_TAU_MS = 3 * DAY_MS;
/** Promotion: decayed score ≥ $1,000 … */
export const PROMOTE_MIN_SCORE_USD = 1_000;
/** … and sampled within the last 3 days. */
export const PROMOTE_RECENT_MS = 3 * DAY_MS;
/** Demotion: discovered/user wallets not eligible in any window for 14 days (never seed, never followed). */
export const DEMOTE_AFTER_MS = 14 * DAY_MS;

/** `score` (as of `fromMs`) decayed to `toMs`. A missing / future timestamp means no decay. */
export function decayScore(score: number, fromMs: number | null, toMs: number): number {
  if (!Number.isFinite(score) || score <= 0) return 0;
  if (fromMs === null || !Number.isFinite(fromMs) || toMs <= fromMs) return score;
  return score * Math.exp(-(toMs - fromMs) / SCORE_TAU_MS);
}

/** bumpCandidate: sampleScore × exp(−Δt / 3 d) + usd. Non-positive / non-finite usd adds nothing. */
export function bumpScore(prev: { score: number; atMs: number | null }, usd: number, nowMs: number): number {
  return decayScore(prev.score, prev.atMs, nowMs) + (Number.isFinite(usd) && usd > 0 ? usd : 0);
}

/** Sum sampled trades per user: {hits, usd}. */
export function aggregateHits(trades: readonly { user: string; usd: number }[]): Map<string, { hits: number; usd: number }> {
  const out = new Map<string, { hits: number; usd: number }>();
  for (const t of trades) {
    const a = out.get(t.user) ?? { hits: 0, usd: 0 };
    a.hits += 1;
    if (Number.isFinite(t.usd) && t.usd > 0) a.usd += t.usd;
    out.set(t.user, a);
  }
  return out;
}

export interface CandidateRow {
  wallet: string;
  sampleScore: number;
  sampleScoreAtMs: number | null;
  sampleHits: number;
  lastSampleAtMs: number | null;
}

/**
 * Hourly promotion (§5.6): candidates with ≥ minHits sample hits, decayed score ≥ $1,000 and a sample in the
 * last 3 days, best decayed score first, at most `limit`.
 */
export function selectPromotions(
  rows: readonly CandidateRow[],
  opts: { nowMs: number; minHits: number; limit: number; minScoreUsd?: number; recentMs?: number },
): { wallet: string; score: number }[] {
  const limit = Math.max(0, Math.floor(opts.limit));
  if (limit === 0) return [];
  const minScore = opts.minScoreUsd ?? PROMOTE_MIN_SCORE_USD;
  const recent = opts.recentMs ?? PROMOTE_RECENT_MS;
  return rows
    .filter((r) => r.sampleHits >= opts.minHits && r.lastSampleAtMs !== null && opts.nowMs - r.lastSampleAtMs <= recent)
    .map((r) => ({ wallet: r.wallet, score: decayScore(r.sampleScore, r.sampleScoreAtMs, opts.nowMs) }))
    .filter((r) => r.score >= minScore)
    .sort((a, b) => b.score - a.score || (a.wallet < b.wallet ? -1 : a.wallet > b.wallet ? 1 : 0))
    .slice(0, limit);
}

/** How many candidates may still be promoted now: the daily allowance and the tracked cap both bind. */
export function promotionAllowance(p: { perDay: number; promotedToday: number; maxTracked: number; tracked: number }): number {
  return Math.max(0, Math.min(p.perDay - p.promotedToday, p.maxTracked - p.tracked));
}

export interface DemoteRow {
  wallet: string;
  origin: string;
  trackedAtMs: number | null;
  /** Last time any window was eligible (null: never since tracked). */
  lastEligibleAtMs: number | null;
  eligibleNow: boolean;
  followed: boolean;
}

/**
 * Daily demotion (§5.6): tracked wallets of origin "discovered" or "user", not followed, not eligible in any
 * window now, and not eligible for 14 days (counted from tracking when never eligible). Seed wallets never.
 */
export function selectDemotions(rows: readonly DemoteRow[], nowMs: number, afterMs: number = DEMOTE_AFTER_MS): string[] {
  const out: string[] = [];
  for (const r of rows) {
    if (r.origin !== "discovered" && r.origin !== "user") continue;
    if (r.followed || r.eligibleNow) continue;
    const since = r.lastEligibleAtMs ?? r.trackedAtMs;
    if (since === null) continue; // unknown history: keep it
    if (nowMs - since >= afterMs) out.push(r.wallet);
  }
  return out;
}

// ── Backpressure (§5.7) ─────────────────────────────────────────────────────────────────────────────

export const INGEST_QUEUE_MAX = 20_000;
/** Above this, the sampler and S2 pause. */
export const INGEST_PAUSE_DISCOVERY_AT = 15_000;
/** Above this, S2 messages are dropped. */
export const INGEST_DROP_S2_AT = 19_000;
/** Hysteresis: S2 resubscribes once the queue is back below this. */
export const INGEST_RESUME_DISCOVERY_AT = 10_000;

/** "live": S1 stream, logs mode, watcher, gap-fill — never dropped. "discovery": S2 stream and the sampler. */
export type IngestLane = "live" | "discovery";
export type Admission = "accept" | "drop" | "gap";

/**
 * Admission of one item into the ingest queue of `size` items. Live items are never dropped: when the queue is
 * full they are refused with "gap" (the caller marks the wallet for gap repair). Discovery items are dropped
 * above 19,000 queued items.
 */
export function admitToIngest(size: number, lane: IngestLane): Admission {
  if (lane === "discovery") return size > INGEST_DROP_S2_AT ? "drop" : "accept";
  return size >= INGEST_QUEUE_MAX ? "gap" : "accept";
}

export function discoveryPaused(size: number): boolean {
  return size > INGEST_PAUSE_DISCOVERY_AT;
}

// ── Drift counters (§2.7) ───────────────────────────────────────────────────────────────────────────

/** Events in the trailing window (default 1 h), in `buckets` time buckets (default 60 × 1 min). */
export class RollingCounter {
  private readonly counts: number[];
  private readonly stamps: number[];
  private readonly bucketMs: number;

  constructor(
    private readonly windowMs: number = HOUR_MS,
    buckets = 60,
  ) {
    this.bucketMs = Math.max(1, Math.floor(windowMs / buckets));
    this.counts = new Array<number>(buckets).fill(0);
    this.stamps = new Array<number>(buckets).fill(-1);
  }

  add(n = 1, nowMs: number = Date.now()): void {
    const slot = Math.floor(nowMs / this.bucketMs);
    const i = slot % this.counts.length;
    if (this.stamps[i] !== slot) {
      this.stamps[i] = slot;
      this.counts[i] = 0;
    }
    this.counts[i]! += n;
  }

  total(nowMs: number = Date.now()): number {
    const slot = Math.floor(nowMs / this.bucketMs);
    const oldest = slot - this.counts.length + 1;
    let sum = 0;
    for (let i = 0; i < this.counts.length; i++) {
      const s = this.stamps[i]!;
      if (s >= oldest && s <= slot) sum += this.counts[i]!;
    }
    return sum;
  }
}

// ── Gap-fill strategy (§4.2) ────────────────────────────────────────────────────────────────────────

/** Longer outages are repaired by the P2 backfill loop ("gap" state), not by the P1 gap-fill. */
export const GAP_MAX_LIVE_MS = 6 * HOUR_MS;
/** Upper bound of relayer traffic (E11: 561–1,463 tx/min). */
export const RELAYER_TX_PER_MIN = 1_500;
/** Signatures per tracked wallet per day (§5.2 recheck: 244/day). */
export const WALLET_SIGS_PER_DAY = 244;
/** A P1 gap-fill never plans to spend more than this share of the daily cap; beyond it → P2 "gap" repair. */
export const GAP_FILL_MAX_CAP_SHARE = 0.05;
/**
 * All P1 gap-fills of one UTC day together stay under this share of the daily cap (P1 is never paused by the
 * meter, so a flapping socket would otherwise spend past the cap); beyond it gaps go to the P2 backfill loop.
 */
export const GAP_FILL_DAILY_CAP_SHARE = 0.2;
const GTFA_PAGE_TXS = 100;
const GTFA_PAGE_CREDITS = 10;

export type GapPlan =
  | { kind: "none" }
  | { kind: "mark_gap"; reason: "too_long" | "too_expensive" | "daily_budget" }
  | { kind: "relayer_scan"; estCredits: number; maxPages: number }
  | { kind: "per_wallet"; estCredits: number };

/**
 * How to repair a stream outage of `gapMs` for `wallets` tracked wallets:
 *  - relayer_scan: gTFA "full" pages over the FOMO relayer (every FOMO trade is relayer-paid; 10 credits per 100 tx)
 *  - per_wallet:   getSignaturesForAddress + getTransaction per wallet (1 + ~244/day × gap credits each)
 * The cheaper one is chosen; a gap over 6 h, one that would cost more than 5 % of the daily cap, or one that
 * would take today's P1 gap-fill spend (`spentTodayCredits`) past 20 % of the cap is handed to the P2 backfill
 * loop instead ("mark_gap").
 */
export function planGapFill(p: { gapMs: number; wallets: number; gtfa: boolean; capCredits: number; spentTodayCredits?: number }): GapPlan {
  if (!(p.gapMs > 0) || p.wallets <= 0) return { kind: "none" };
  if (p.gapMs > GAP_MAX_LIVE_MS) return { kind: "mark_gap", reason: "too_long" };
  const perWallet = p.wallets * (1 + Math.ceil((WALLET_SIGS_PER_DAY * p.gapMs) / DAY_MS));
  let best: Extract<GapPlan, { estCredits: number }> = { kind: "per_wallet", estCredits: perWallet };
  if (p.gtfa) {
    const pages = Math.max(1, Math.ceil(((p.gapMs / MINUTE_MS) * RELAYER_TX_PER_MIN) / GTFA_PAGE_TXS));
    const relayer = pages * GTFA_PAGE_CREDITS;
    if (relayer < perWallet) best = { kind: "relayer_scan", estCredits: relayer, maxPages: Math.ceil(pages * 1.5) + 2 };
  }
  if (best.estCredits > GAP_FILL_MAX_CAP_SHARE * p.capCredits) return { kind: "mark_gap", reason: "too_expensive" };
  const spent = Number.isFinite(p.spentTodayCredits) && p.spentTodayCredits! > 0 ? p.spentTodayCredits! : 0;
  if (spent + best.estCredits > GAP_FILL_DAILY_CAP_SHARE * p.capCredits) return { kind: "mark_gap", reason: "daily_budget" };
  return best;
}

// ── Restart resume point (§4.2) ─────────────────────────────────────────────────────────────────────

/**
 * The persisted restart resume point: the earliest of the last frame received on a subscribed stream and every
 * stretch not yet durably repaired (an open stream gap, a pending / running gap-fill, an unwritten live item).
 * A restart gap-fills from here, so nothing older than it can be lost. null: nothing known yet.
 */
export function resumePointMs(points: readonly (number | null | undefined)[]): number | null {
  let min: number | null = null;
  for (const p of points) if (typeof p === "number" && Number.isFinite(p) && (min === null || p < min)) min = p;
  return min;
}

// ── Backfill (§4.2) ─────────────────────────────────────────────────────────────────────────────────

/** now − days, never earlier than the day FOMO's marker appeared (rule R is invalid before). */
export function backfillCutoffMs(nowMs: number, days: number, markerSinceMs: number): number {
  return Math.max(nowMs - Math.max(0, days) * DAY_MS, markerSinceMs);
}

const ORIGIN_RANK: Record<string, number> = { seed: 1, user: 2, discovered: 3 };

/** Backfill order: followed > seed > user > discovered, then oldest trackedAt, then wallet. */
export function compareBackfill(
  a: { wallet: string; origin: string; followed: boolean; trackedAtMs: number | null },
  b: { wallet: string; origin: string; followed: boolean; trackedAtMs: number | null },
): number {
  const ra = a.followed ? 0 : (ORIGIN_RANK[a.origin] ?? 4);
  const rb = b.followed ? 0 : (ORIGIN_RANK[b.origin] ?? 4);
  if (ra !== rb) return ra - rb;
  const ta = a.trackedAtMs ?? Number.MAX_SAFE_INTEGER;
  const tb = b.trackedAtMs ?? Number.MAX_SAFE_INTEGER;
  if (ta !== tb) return ta - tb;
  return a.wallet < b.wallet ? -1 : a.wallet > b.wallet ? 1 : 0;
}

/**
 * Where a finished (or capped) backfill leaves the wallet: history is complete back to the cutoff when the
 * cutoff was reached or the wallet's history ended; otherwise only back to the oldest processed transaction.
 */
export function backfillOutcome(p: {
  reachedCutoff: boolean;
  endOfHistory: boolean;
  cutoffMs: number;
  oldestMs: number | null;
  nowMs: number;
}): { state: "done" | "partial"; coveredFromMs: number } {
  if (p.reachedCutoff || p.endOfHistory) return { state: "done", coveredFromMs: p.cutoffMs };
  return { state: "partial", coveredFromMs: Math.max(p.cutoffMs, p.oldestMs ?? p.nowMs) };
}

// ── Logs mode (§4.2) ────────────────────────────────────────────────────────────────────────────────

export const LOGS_PER_CONNECTION = 60;
export const LOGS_MAX_CONNECTIONS = 4;

/**
 * Logs mode subscribes one `logsSubscribe` per wallet, ≤ 60 per connection, ≤ 4 connections. Every tracked
 * wallet is planned, including the ones the copy engine watches: the watcher is not a complete source (it drops
 * polled signatures older than WORKER_MAX_EVENT_AGE_MS and polls ≤ 100 signatures), so its hand-over is only a
 * bonus, deduped by signature. Priority: `priority` wallets (followed by agents — the traders people copy) >
 * seed > user > discovered, then most recent trade. Returns the wallets to subscribe and the ones that do not fit.
 */
export function planLogsWallets(
  tracked: readonly { wallet: string; origin: string; lastTradeAtMs: number | null }[],
  priority: ReadonlySet<string>,
  capacity: number = LOGS_PER_CONNECTION * LOGS_MAX_CONNECTIONS,
): { subscribe: string[]; overflow: string[] } {
  const ordered = [...tracked]
    .sort((a, b) => {
      const pa = priority.has(a.wallet) ? 0 : 1;
      const pb = priority.has(b.wallet) ? 0 : 1;
      if (pa !== pb) return pa - pb;
      const ra = ORIGIN_RANK[a.origin] ?? 4;
      const rb = ORIGIN_RANK[b.origin] ?? 4;
      if (ra !== rb) return ra - rb;
      const ta = a.lastTradeAtMs ?? -1;
      const tb = b.lastTradeAtMs ?? -1;
      if (ta !== tb) return tb - ta;
      return a.wallet < b.wallet ? -1 : a.wallet > b.wallet ? 1 : 0;
    })
    .map((t) => t.wallet);
  return { subscribe: ordered.slice(0, capacity), overflow: ordered.slice(capacity) };
}

export const SUBSCRIBE_RETRY_BASE_MS = 5_000;
export const SUBSCRIBE_RETRY_MAX_MS = 5 * MINUTE_MS;
/** A logsSubscribe failing this long is handed to the P2 backfill loop (durable gap mark) while retries go on. */
export const SUBSCRIBE_ESCALATE_MS = 5 * MINUTE_MS;

/** Delay before the next retry round of failed logsSubscribe calls: 5 s, doubling per failed round, ≤ 5 min. */
export function subscribeRetryDelayMs(attempt: number, baseMs: number = SUBSCRIBE_RETRY_BASE_MS, maxMs: number = SUBSCRIBE_RETRY_MAX_MS): number {
  const n = Number.isFinite(attempt) ? Math.max(0, Math.min(30, Math.floor(attempt))) : 0;
  return Math.min(maxMs, baseMs * 2 ** n);
}

/** Logs mode drift check (§2.7): 1 in 20 non-candidate notifications is fetched anyway, ≤ 120 an hour. */
export const DRIFT_SAMPLE_EVERY = 20;
export const DRIFT_SAMPLE_MAX_PER_HOUR = 120;

/**
 * Picks which non-candidate logs notifications (no known FOMO router / Relay invoke in the logs) are fetched
 * anyway, so a trade through a router we do not know still reaches rule R and the unknownRouter counter. A
 * sampled trade counts `every` times in the drift counters (it stands for the ones not sampled).
 */
export class DriftSampler {
  private seen = 0;
  private hour = -1;
  private taken = 0;

  constructor(
    readonly every: number = DRIFT_SAMPLE_EVERY,
    private readonly maxPerHour: number = DRIFT_SAMPLE_MAX_PER_HOUR,
  ) {}

  take(nowMs: number): boolean {
    const h = Math.floor(nowMs / HOUR_MS);
    if (h !== this.hour) {
      this.hour = h;
      this.taken = 0;
    }
    this.seen++;
    if (this.seen % this.every !== 0 || this.taken >= this.maxPerHour) return false;
    this.taken++;
    return true;
  }
}

// ── Retention (§4.2) ────────────────────────────────────────────────────────────────────────────────

export interface RetentionGroup {
  wallet: string;
  mint: string;
  /** Newest FomoSwap.createdAt of the group (when the last of its rows was written). */
  maxCreatedAtMs: number | null;
}

export interface RetentionWallet {
  status: string;
  statsDirty: boolean;
  /** FomoWallet.statsAt: written in the same transaction as the wallet's FomoPosition rows. */
  statsAtMs: number | null;
}

/**
 * Rule 1 of the daily retention, applied to (wallet, mint) groups whose swaps are ALL older than 31 days:
 *  - tracked wallets: only when no FomoPosition is open for the group AND that answer is current — the wallet's
 *    stats are clean (statsDirty false) and were computed after the group's newest row was written (backfill
 *    keeps inserting old buys; FomoPosition is only rewritten by the stats job). Otherwise the group may still
 *    hold an open lot and FIFO needs every lot of it.
 *  - excluded wallets: deleted (never ranked, no positions).
 *  - candidates: left to rule 2 (swaps older than 45 days).
 */
export function selectRetentionGroups<G extends RetentionGroup>(
  groups: readonly G[],
  wallets: ReadonlyMap<string, RetentionWallet>,
  open: ReadonlySet<string>,
): G[] {
  const out: G[] = [];
  for (const g of groups) {
    const w = wallets.get(g.wallet);
    if (!w) continue;
    if (w.status === "excluded") {
      out.push(g);
      continue;
    }
    if (w.status !== "tracked") continue;
    if (open.has(`${g.wallet}:${g.mint}`)) continue;
    if (w.statsDirty || w.statsAtMs === null || g.maxCreatedAtMs === null || g.maxCreatedAtMs >= w.statsAtMs) continue;
    out.push(g);
  }
  return out;
}

// ── Daily jobs ──────────────────────────────────────────────────────────────────────────────────────

export const DAILY_MAX_ATTEMPTS = 3;
export const DAILY_RETRY_MS = HOUR_MS;

/**
 * After `failures` consecutive failures of a daily job in its current slot: retry after `failures` hours, and
 * after 3 failures give up until the next slot (the run is recorded), so a failing paid call is not re-billed
 * every 10 minutes.
 */
export function dailyFailurePlan(failures: number): { giveUp: boolean; retryInMs: number } {
  if (failures >= DAILY_MAX_ATTEMPTS) return { giveUp: true, retryInMs: 0 };
  return { giveUp: false, retryInMs: DAILY_RETRY_MS * Math.max(1, failures) };
}

/**
 * Is a daily job due? Without `hourUtc`: ≥ 23.5 h since the last run. With `hourUtc`: once per UTC day at or
 * after that hour (a job that never ran is due immediately).
 */
export function dailyDue(lastRunMs: number | null, nowMs: number, hourUtc?: number): boolean {
  if (lastRunMs === null || !Number.isFinite(lastRunMs)) return true;
  if (hourUtc === undefined) return nowMs - lastRunMs >= DAY_MS - 30 * MINUTE_MS;
  const dayStart = Math.floor(nowMs / DAY_MS) * DAY_MS;
  const todaySlot = dayStart + hourUtc * HOUR_MS;
  const slot = nowMs >= todaySlot ? todaySlot : todaySlot - DAY_MS;
  return lastRunMs < slot;
}

/** Start of the UTC hour containing `ms`. */
export function hourStartMs(ms: number): number {
  return Math.floor(ms / HOUR_MS) * HOUR_MS;
}

/**
 * First hour in [fromMs, toMs] (hour starts) with no stored SOL/USD hour within ±`toleranceHours` (what
 * solUsdLookup can still price), or null when the whole range is priceable.
 */
export function firstUnpricedHour(have: ReadonlySet<number>, fromMs: number, toMs: number, toleranceHours = 6): number | null {
  const from = hourStartMs(fromMs);
  const to = hourStartMs(toMs);
  let lastHave = Number.NEGATIVE_INFINITY;
  for (let t = from - toleranceHours * HOUR_MS; t < from; t += HOUR_MS) if (have.has(t)) lastHave = t;
  for (let t = from; t <= to; t += HOUR_MS) {
    if (have.has(t)) {
      lastHave = t;
      continue;
    }
    if (t - lastHave <= toleranceHours * HOUR_MS) continue;
    let next = false;
    for (let k = 1; k <= toleranceHours && !next; k++) next = have.has(t + k * HOUR_MS);
    if (!next) return t;
  }
  return null;
}

// ── Open positions: reconciliation caps and unrealized PnL ──────────────────────────────────────────

/** On-chain balance of a mint read by the daily reconciliation (raw units) and when it was read. */
export interface ReconcileOverride {
  raw: bigint;
  atMs: number;
}

/**
 * Cap FIFO positions at the on-chain balance read by the reconciliation, scaling cost and value. An override
 * only applies while no swap of that mint happened after it was read. Positions left under $0.01 are dropped.
 */
export function applyReconcile(
  positions: readonly OpenPosition[],
  overrides: ReadonlyMap<string, ReconcileOverride> | undefined,
  lastSwapMs: ReadonlyMap<string, number>,
): OpenPosition[] {
  if (!overrides || overrides.size === 0) return [...positions];
  const out: OpenPosition[] = [];
  for (const p of positions) {
    const o = overrides.get(p.mint);
    let raw: bigint;
    try {
      raw = BigInt(p.rawAmount);
    } catch {
      out.push(p);
      continue;
    }
    if (!o || (lastSwapMs.get(p.mint) ?? 0) > o.atMs || o.raw >= raw) {
      out.push(p);
      continue;
    }
    if (o.raw <= BigInt(0) || raw <= BigInt(0)) continue;
    const share = Number((o.raw * BigInt(1_000_000_000)) / raw) / 1e9;
    const costUsd = p.costUsd * share;
    if (costUsd < MIN_POSITION_COST_USD) continue;
    out.push({
      ...p,
      rawAmount: o.raw.toString(),
      costUsd,
      costSol: p.costSol === null ? null : p.costSol * share,
      valueUsd: p.valueUsd === null ? null : p.valueUsd * share,
    });
  }
  return out;
}

/**
 * USD per whole token implied by a stored FomoPosition valuation (used to warm the price cache after a restart),
 * or null when it cannot be derived.
 */
export function unitPriceOf(valueUsd: number | null, rawAmount: string, decimals: number): number | null {
  if (valueUsd === null || !Number.isFinite(valueUsd) || valueUsd < 0) return null;
  const raw = Number(rawAmount);
  if (!Number.isFinite(raw) || raw <= 0 || !Number.isInteger(decimals) || decimals < 0) return null;
  const price = valueUsd / (raw / 10 ** decimals);
  return Number.isFinite(price) ? price : null;
}

/** Σ(value − cost) over priced positions; null when none is priced (never zero). */
export function unrealizedOf(positions: readonly { costUsd: number; valueUsd: number | null }[]): number | null {
  let sum = 0;
  let any = false;
  for (const p of positions) {
    if (p.valueUsd === null || !Number.isFinite(p.valueUsd)) continue;
    any = true;
    sum += p.valueUsd - p.costUsd;
  }
  return any ? sum : null;
}
