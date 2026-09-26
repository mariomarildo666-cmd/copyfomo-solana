// Run: npx tsx --test src/worker/fomo/policy.test.ts
// Pure indexer policy: discovery scoring decay, promotion / demotion selection, ingest backpressure thresholds,
// drift counters, gap-fill planning (+ daily budget), restart resume point, backfill ordering / outcome,
// logs-mode planning / subscribe retry / drift sampling, retention, daily jobs (+ failure policy), positions,
// SOL/USD history holes.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  admitToIngest,
  aggregateHits,
  applyReconcile,
  backfillCutoffMs,
  backfillOutcome,
  bumpScore,
  compareBackfill,
  dailyDue,
  dailyFailurePlan,
  DAY_MS,
  decayScore,
  discoveryPaused,
  DriftSampler,
  firstUnpricedHour,
  GAP_FILL_DAILY_CAP_SHARE,
  HOUR_MS,
  INGEST_DROP_S2_AT,
  INGEST_PAUSE_DISCOVERY_AT,
  INGEST_QUEUE_MAX,
  MINUTE_MS,
  planGapFill,
  planLogsWallets,
  promotionAllowance,
  resumePointMs,
  RollingCounter,
  selectDemotions,
  selectPromotions,
  selectRetentionGroups,
  subscribeRetryDelayMs,
  unitPriceOf,
  unrealizedOf,
  type CandidateRow,
  type DemoteRow,
  type RetentionWallet,
} from "./policy";

const NOW = Date.parse("2026-09-26T12:00:00Z");
const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);

// ── Scoring ──────────────────────────────────────────────────────────────────────────────────────────

test("decayScore: exp(−Δt / 3 days); no decay without a timestamp or for Δt ≤ 0", () => {
  near(decayScore(1_000, NOW - 3 * DAY_MS, NOW), 1_000 / Math.E, 1e-9);
  near(decayScore(1_000, NOW - 6 * DAY_MS, NOW), 1_000 / Math.E ** 2, 1e-9);
  assert.equal(decayScore(1_000, null, NOW), 1_000);
  assert.equal(decayScore(1_000, NOW + DAY_MS, NOW), 1_000);
  assert.equal(decayScore(-5, NOW - DAY_MS, NOW), 0);
  assert.equal(decayScore(Number.NaN, NOW - DAY_MS, NOW), 0);
});

test("bumpScore: decays the old score, then adds the sampled USD (ignoring junk amounts)", () => {
  near(bumpScore({ score: 1_000, atMs: NOW - 3 * DAY_MS }, 250, NOW), 1_000 / Math.E + 250, 1e-9);
  assert.equal(bumpScore({ score: 0, atMs: null }, 400, NOW), 400);
  assert.equal(bumpScore({ score: 100, atMs: NOW }, -50, NOW), 100);
  assert.equal(bumpScore({ score: 100, atMs: NOW }, Number.POSITIVE_INFINITY, NOW), 100);
});

test("aggregateHits: one entry per user with hits and summed USD", () => {
  const agg = aggregateHits([
    { user: "A", usd: 10 },
    { user: "B", usd: 5 },
    { user: "A", usd: 15 },
    { user: "A", usd: -3 },
  ]);
  assert.deepEqual(agg.get("A"), { hits: 3, usd: 25 });
  assert.deepEqual(agg.get("B"), { hits: 1, usd: 5 });
});

// ── Promotion / demotion ─────────────────────────────────────────────────────────────────────────────

const cand = (wallet: string, score: number, hits: number, lastSampleAgoMs: number, scoreAgoMs = lastSampleAgoMs): CandidateRow => ({
  wallet,
  sampleScore: score,
  sampleScoreAtMs: NOW - scoreAgoMs,
  sampleHits: hits,
  lastSampleAtMs: NOW - lastSampleAgoMs,
});

test("selectPromotions: hits ≥ min, decayed score ≥ $1,000, sampled within 3 days; best first; limited", () => {
  const rows = [
    cand("low-hits", 50_000, 2, HOUR_MS),
    cand("stale", 50_000, 10, 4 * DAY_MS),
    cand("decayed-below", 2_000, 5, HOUR_MS, 3 * DAY_MS), // 2000/e ≈ 736 < 1000
    cand("ok-small", 1_200, 3, HOUR_MS, 0),
    cand("ok-big", 9_000, 4, 2 * DAY_MS, 2 * DAY_MS), // 9000·e^(−2/3) ≈ 4621
    cand("ok-mid", 3_000, 3, 0, 0),
  ];
  const picks = selectPromotions(rows, { nowMs: NOW, minHits: 3, limit: 10 });
  assert.deepEqual(
    picks.map((p) => p.wallet),
    ["ok-big", "ok-mid", "ok-small"],
  );
  near(picks[0]!.score, 9_000 * Math.exp(-2 / 3), 1e-6);
  assert.deepEqual(
    selectPromotions(rows, { nowMs: NOW, minHits: 3, limit: 2 }).map((p) => p.wallet),
    ["ok-big", "ok-mid"],
  );
  assert.deepEqual(selectPromotions(rows, { nowMs: NOW, minHits: 3, limit: 0 }), []);
  // Free plan: 2 hits are enough.
  assert.ok(selectPromotions(rows, { nowMs: NOW, minHits: 2, limit: 10 }).some((p) => p.wallet === "low-hits"));
});

test("promotionAllowance: the daily allowance and the tracked cap both bind; never negative", () => {
  assert.equal(promotionAllowance({ perDay: 50, promotedToday: 0, maxTracked: 2_000, tracked: 60 }), 50);
  assert.equal(promotionAllowance({ perDay: 50, promotedToday: 45, maxTracked: 2_000, tracked: 60 }), 5);
  assert.equal(promotionAllowance({ perDay: 50, promotedToday: 0, maxTracked: 2_000, tracked: 1_990 }), 10);
  assert.equal(promotionAllowance({ perDay: 50, promotedToday: 60, maxTracked: 2_000, tracked: 60 }), 0);
  assert.equal(promotionAllowance({ perDay: 3, promotedToday: 0, maxTracked: 80, tracked: 95 }), 0);
});

test("selectDemotions: only discovered/user, not followed, not eligible now, 14 days since last eligible (or tracked)", () => {
  const row = (wallet: string, extra: Partial<DemoteRow>): DemoteRow => ({
    wallet,
    origin: "discovered",
    trackedAtMs: NOW - 30 * DAY_MS,
    lastEligibleAtMs: null,
    eligibleNow: false,
    followed: false,
    ...extra,
  });
  const out = selectDemotions(
    [
      row("never-eligible-old", {}),
      row("never-eligible-new", { trackedAtMs: NOW - 5 * DAY_MS }),
      row("eligible-recently", { lastEligibleAtMs: NOW - 3 * DAY_MS }),
      row("eligible-long-ago", { lastEligibleAtMs: NOW - 15 * DAY_MS }),
      row("eligible-now", { eligibleNow: true }),
      row("followed", { followed: true }),
      row("seed", { origin: "seed" }),
      row("user", { origin: "user" }),
      row("unknown-history", { trackedAtMs: null }),
    ],
    NOW,
  );
  assert.deepEqual(out, ["never-eligible-old", "eligible-long-ago", "user"]);
});

// ── Backpressure (§5.7) ──────────────────────────────────────────────────────────────────────────────

test("backpressure thresholds: pause discovery > 15k, drop S2 > 19k, live never dropped (gap at 20k)", () => {
  assert.equal(INGEST_QUEUE_MAX, 20_000);
  assert.equal(INGEST_PAUSE_DISCOVERY_AT, 15_000);
  assert.equal(INGEST_DROP_S2_AT, 19_000);

  assert.equal(discoveryPaused(15_000), false);
  assert.equal(discoveryPaused(15_001), true);

  assert.equal(admitToIngest(0, "discovery"), "accept");
  assert.equal(admitToIngest(19_000, "discovery"), "accept");
  assert.equal(admitToIngest(19_001, "discovery"), "drop");
  assert.equal(admitToIngest(25_000, "discovery"), "drop");

  assert.equal(admitToIngest(19_999, "live"), "accept");
  assert.equal(admitToIngest(20_000, "live"), "gap");
  assert.equal(admitToIngest(19_500, "live"), "accept"); // S1 is not dropped where S2 is
});

// ── Drift counters ───────────────────────────────────────────────────────────────────────────────────

test("RollingCounter: sums the trailing hour and forgets older buckets", () => {
  const c = new RollingCounter();
  c.add(1, NOW);
  c.add(2, NOW + 10 * MINUTE_MS);
  c.add(3, NOW + 59 * MINUTE_MS);
  assert.equal(c.total(NOW + 59 * MINUTE_MS), 6);
  assert.equal(c.total(NOW + 61 * MINUTE_MS), 5); // the first bucket fell out
  assert.equal(c.total(NOW + 71 * MINUTE_MS), 3);
  assert.equal(c.total(NOW + 3 * HOUR_MS), 0);
  c.add(4, NOW + 3 * HOUR_MS); // bucket reuse resets the stale count
  assert.equal(c.total(NOW + 3 * HOUR_MS), 4);
});

// ── Gap-fill planning ────────────────────────────────────────────────────────────────────────────────

test("planGapFill: none / per-wallet / relayer scan / handed to backfill", () => {
  const cap = 300_000;
  assert.deepEqual(planGapFill({ gapMs: 0, wallets: 60, gtfa: true, capCredits: cap }), { kind: "none" });
  assert.deepEqual(planGapFill({ gapMs: MINUTE_MS, wallets: 0, gtfa: true, capCredits: cap }), { kind: "none" });
  assert.deepEqual(planGapFill({ gapMs: 7 * HOUR_MS, wallets: 60, gtfa: true, capCredits: cap }), { kind: "mark_gap", reason: "too_long" });

  // 60 seeds, 5 min: per wallet 60 × (1 + 1) = 120 credits < relayer 75 pages × 10.
  assert.deepEqual(planGapFill({ gapMs: 5 * MINUTE_MS, wallets: 60, gtfa: true, capCredits: cap }), { kind: "per_wallet", estCredits: 120 });
  // 2,000 tracked, 5 min: relayer 750 credits ≪ per wallet 4,000.
  const big = planGapFill({ gapMs: 5 * MINUTE_MS, wallets: 2_000, gtfa: true, capCredits: cap });
  assert.equal(big.kind, "relayer_scan");
  assert.equal(big.kind === "relayer_scan" && big.estCredits, 750);
  assert.ok(big.kind === "relayer_scan" && big.maxPages > 75);
  // Without gTFA only the per-wallet path exists.
  assert.equal(planGapFill({ gapMs: 5 * MINUTE_MS, wallets: 2_000, gtfa: false, capCredits: cap }).kind, "per_wallet");
  // Over 5 % of the daily cap → P2 backfill repairs it instead of P1.
  assert.deepEqual(planGapFill({ gapMs: 5 * HOUR_MS, wallets: 2_000, gtfa: true, capCredits: cap }), { kind: "mark_gap", reason: "too_expensive" });
  // Free: 80 wallets × (1 + ⌈244 × 30 min / 1 day⌉ = 6) = 560 credits.
  assert.deepEqual(planGapFill({ gapMs: 30 * MINUTE_MS, wallets: 80, gtfa: false, capCredits: 30_000 }), { kind: "per_wallet", estCredits: 560 });
});

test("planGapFill: all P1 gap-fills of a day share 20 % of the cap (a flapping socket cannot spend past it)", () => {
  const cap = 300_000;
  const budget = GAP_FILL_DAILY_CAP_SHARE * cap; // 60,000
  const one = { gapMs: 90_000, wallets: 2_000, gtfa: true, capCredits: cap }; // relayer scan, 230 credits
  const plan = planGapFill(one);
  assert.equal(plan.kind, "relayer_scan");
  const cost = plan.kind === "relayer_scan" ? plan.estCredits : 0;
  assert.equal(planGapFill({ ...one, spentTodayCredits: budget - cost }).kind, "relayer_scan");
  assert.deepEqual(planGapFill({ ...one, spentTodayCredits: budget - cost + 1 }), { kind: "mark_gap", reason: "daily_budget" });
  // 20 reconnects an hour for a day = 480 gap-fills × 230 credits > budget: the tail is handed to P2.
  let spent = 0;
  let scans = 0;
  for (let i = 0; i < 480; i++) {
    const p = planGapFill({ ...one, spentTodayCredits: spent });
    if (p.kind === "relayer_scan") {
      spent += p.estCredits;
      scans++;
    }
  }
  assert.ok(spent <= budget && scans < 480, `spent ${spent} in ${scans} scans`);
  // Junk spend values are ignored.
  assert.equal(planGapFill({ ...one, spentTodayCredits: Number.NaN }).kind, "relayer_scan");
});

test("resumePointMs: the earliest of the last frame and every unrepaired stretch; null when nothing is known", () => {
  assert.equal(resumePointMs([]), null);
  assert.equal(resumePointMs([null, undefined, Number.NaN]), null);
  assert.equal(resumePointMs([NOW]), NOW);
  // A connection down since NOW − 5 min while another one keeps receiving frames: the restart repairs from the outage.
  assert.equal(resumePointMs([NOW, NOW - 5 * MINUTE_MS, null]), NOW - 5 * MINUTE_MS);
  // A queued gap-fill / unwritten item older than the last frame holds it back too.
  assert.equal(resumePointMs([NOW, null, NOW - 90_000, NOW - 30_000]), NOW - 90_000);
});

// ── Backfill ─────────────────────────────────────────────────────────────────────────────────────────

test("backfillCutoffMs never goes before FOMO_MARKER_SINCE", () => {
  const since = Date.parse("2026-01-06T00:00:00Z");
  assert.equal(backfillCutoffMs(NOW, 37, since), NOW - 37 * DAY_MS);
  assert.equal(backfillCutoffMs(Date.parse("2026-01-20T00:00:00Z"), 37, since), since);
});

test("compareBackfill: followed > seed > user > discovered, then oldest trackedAt", () => {
  const rows = [
    { wallet: "d", origin: "discovered", followed: false, trackedAtMs: 1 },
    { wallet: "u", origin: "user", followed: false, trackedAtMs: 1 },
    { wallet: "s2", origin: "seed", followed: false, trackedAtMs: 20 },
    { wallet: "s1", origin: "seed", followed: false, trackedAtMs: 10 },
    { wallet: "f", origin: "discovered", followed: true, trackedAtMs: 99 },
    { wallet: "sn", origin: "seed", followed: false, trackedAtMs: null },
  ];
  assert.deepEqual(
    [...rows].sort(compareBackfill).map((r) => r.wallet),
    ["f", "s1", "s2", "sn", "u", "d"],
  );
});

test("backfillOutcome: cutoff reached or history ended → done from cutoff; capped → partial from oldest", () => {
  const cutoffMs = NOW - 37 * DAY_MS;
  assert.deepEqual(backfillOutcome({ reachedCutoff: true, endOfHistory: false, cutoffMs, oldestMs: cutoffMs - 1, nowMs: NOW }), {
    state: "done",
    coveredFromMs: cutoffMs,
  });
  assert.deepEqual(backfillOutcome({ reachedCutoff: false, endOfHistory: true, cutoffMs, oldestMs: NOW - 2 * DAY_MS, nowMs: NOW }), {
    state: "done",
    coveredFromMs: cutoffMs,
  });
  assert.deepEqual(backfillOutcome({ reachedCutoff: false, endOfHistory: false, cutoffMs, oldestMs: NOW - 8 * DAY_MS, nowMs: NOW }), {
    state: "partial",
    coveredFromMs: NOW - 8 * DAY_MS,
  });
  assert.deepEqual(backfillOutcome({ reachedCutoff: false, endOfHistory: false, cutoffMs, oldestMs: null, nowMs: NOW }), {
    state: "partial",
    coveredFromMs: NOW,
  });
});

// ── Logs mode ────────────────────────────────────────────────────────────────────────────────────────

test("planLogsWallets: every tracked wallet is planned, followed/watched first; seed > user > discovered, recent first; capacity", () => {
  const tracked = [
    { wallet: "d-old", origin: "discovered", lastTradeAtMs: 1 },
    { wallet: "d-new", origin: "discovered", lastTradeAtMs: 5 },
    { wallet: "u", origin: "user", lastTradeAtMs: null },
    { wallet: "s", origin: "seed", lastTradeAtMs: null },
    { wallet: "watched-disc", origin: "discovered", lastTradeAtMs: 0 },
  ];
  // The copy engine's watch is not a complete source (90 s staleness drop, 100-signature polls): a watched
  // wallet must be subscribed by the indexer itself — first, since those are the traders people copy.
  const plan = planLogsWallets(tracked, new Set(["watched-disc"]), 3);
  assert.deepEqual(plan.subscribe, ["watched-disc", "s", "u"]);
  assert.deepEqual(plan.overflow, ["d-new", "d-old"]);
  const all = planLogsWallets(tracked, new Set(["watched-disc"]));
  assert.equal(all.subscribe.length, 5);
  assert.ok(all.subscribe.includes("watched-disc"));
  assert.deepEqual(planLogsWallets(tracked, new Set(), 3).subscribe, ["s", "u", "d-new"]);
});

test("subscribeRetryDelayMs: 5 s doubling per failed round, capped at 5 min", () => {
  assert.equal(subscribeRetryDelayMs(0), 5_000);
  assert.equal(subscribeRetryDelayMs(1), 10_000);
  assert.equal(subscribeRetryDelayMs(3), 40_000);
  assert.equal(subscribeRetryDelayMs(6), 5 * MINUTE_MS);
  assert.equal(subscribeRetryDelayMs(1_000), 5 * MINUTE_MS);
  assert.equal(subscribeRetryDelayMs(-3), 5_000);
  assert.equal(subscribeRetryDelayMs(Number.NaN), 5_000);
  assert.equal(subscribeRetryDelayMs(2, 100), 400);
});

test("DriftSampler: 1 in N non-candidate notifications, at most M an hour, counter resets each hour", () => {
  const s = new DriftSampler(20, 3);
  let taken = 0;
  for (let i = 0; i < 200; i++) if (s.take(NOW)) taken++;
  assert.equal(taken, 3, "hourly cap binds");
  const s2 = new DriftSampler(20, 1_000);
  let t2 = 0;
  for (let i = 0; i < 200; i++) if (s2.take(NOW)) t2++;
  assert.equal(t2, 10);
  // Next hour: the cap resets.
  let t3 = 0;
  for (let i = 0; i < 40; i++) if (s.take(NOW + HOUR_MS)) t3++;
  assert.equal(t3, 2);
  assert.equal(s.every, 20);
});

// ── Retention ────────────────────────────────────────────────────────────────────────────────────────

test("selectRetentionGroups: a tracked group goes only when no position is open AND the stats answer is current", () => {
  const wallets = new Map<string, RetentionWallet>([
    ["clean", { status: "tracked", statsDirty: false, statsAtMs: NOW }],
    ["dirty", { status: "tracked", statsDirty: true, statsAtMs: NOW }],
    ["never", { status: "tracked", statsDirty: false, statsAtMs: null }],
    ["excl", { status: "excluded", statsDirty: true, statsAtMs: null }],
    ["cand", { status: "candidate", statsDirty: false, statsAtMs: null }],
  ]);
  const g = (wallet: string, mint: string, maxCreatedAtMs: number | null) => ({ wallet, mint, maxCreatedAtMs });
  const groups = [
    g("clean", "closed", NOW - HOUR_MS), // closed and reflected in the stats → delete
    g("clean", "open", NOW - HOUR_MS), // open position → keep
    // Backfill wrote a 35-day-old buy after the last stats pass: FomoPosition does not know it yet → keep.
    g("clean", "fresh-backfill", NOW + MINUTE_MS),
    g("clean", "same-instant", NOW),
    g("dirty", "m", NOW - DAY_MS), // stats dirty → keep
    g("never", "m", NOW - DAY_MS), // never computed → keep
    g("excl", "m", NOW), // excluded → delete
    g("cand", "m", NOW - DAY_MS), // candidate → rule 2 (45 days)
    g("gone", "m", NOW - DAY_MS), // no wallet row → keep (cascade handles it)
    g("clean", "no-created", null),
  ];
  const out = selectRetentionGroups(groups, wallets, new Set(["clean:open"]));
  assert.deepEqual(
    out.map((x) => `${x.wallet}:${x.mint}`),
    ["clean:closed", "excl:m"],
  );
});

// ── Daily jobs ───────────────────────────────────────────────────────────────────────────────────────

test("dailyFailurePlan: retry after 1 h then 2 h; give up for the slot after 3 failures (no re-billing every 10 min)", () => {
  assert.deepEqual(dailyFailurePlan(1), { giveUp: false, retryInMs: HOUR_MS });
  assert.deepEqual(dailyFailurePlan(2), { giveUp: false, retryInMs: 2 * HOUR_MS });
  assert.deepEqual(dailyFailurePlan(3), { giveUp: true, retryInMs: 0 });
  assert.equal(dailyFailurePlan(10).giveUp, true);
  // Attempts per slot are bounded: 144 checks a day can never mean 144 paid runs.
  let attempts = 0;
  for (let f = 1; ; f++) {
    attempts++;
    if (dailyFailurePlan(f).giveUp) break;
  }
  assert.equal(attempts, 3);
});

test("firstUnpricedHour: small recorder holes are priceable (±6 h); a long hole or a missing tail is not", () => {
  const from = Date.parse("2026-08-01T00:00:00Z");
  const to = from + 48 * HOUR_MS;
  const all = new Set<number>();
  for (let t = from; t <= to; t += HOUR_MS) all.add(t);
  assert.equal(firstUnpricedHour(all, from, to), null);
  const small = new Set(all);
  for (let k = 10; k < 20; k++) small.delete(from + k * HOUR_MS); // 10-hour hole: every hour within 6 h of a price
  assert.equal(firstUnpricedHour(small, from, to), null);
  const big = new Set(all);
  for (let k = 10; k < 24; k++) big.delete(from + k * HOUR_MS); // 14-hour hole: hour 16 is 7 h from hour 9 and 8 h from hour 24
  assert.equal(firstUnpricedHour(big, from, to), from + 16 * HOUR_MS);
  // Nothing stored before day 2 (the old 45-day window): the first hours are unpriced.
  const tail = new Set([...all].filter((t) => t >= from + 24 * HOUR_MS));
  assert.equal(firstUnpricedHour(tail, from, to), from);
  assert.equal(firstUnpricedHour(new Set(), from, to), from);
});

test("dailyDue: never ran → due; ≥ 23.5 h; with an hour: once per UTC day at/after it", () => {
  assert.equal(dailyDue(null, NOW), true);
  assert.equal(dailyDue(NOW - 23 * HOUR_MS, NOW), false);
  assert.equal(dailyDue(NOW - 24 * HOUR_MS, NOW), true);
  const at0230 = Date.parse("2026-09-26T02:30:00Z");
  const at0310 = Date.parse("2026-09-26T03:10:00Z");
  assert.equal(dailyDue(Date.parse("2026-09-25T03:05:00Z"), at0230, 3), false); // today's 03:00 not reached yet
  assert.equal(dailyDue(Date.parse("2026-09-25T03:05:00Z"), at0310, 3), true);
  assert.equal(dailyDue(Date.parse("2026-09-26T03:01:00Z"), at0310, 3), false); // already ran today
  assert.equal(dailyDue(Date.parse("2026-09-24T12:00:00Z"), at0230, 3), true); // missed yesterday's slot
});

// ── Positions ────────────────────────────────────────────────────────────────────────────────────────

test("applyReconcile caps positions at the on-chain balance until the mint trades again; unrealizedOf", () => {
  const pos = (mint: string, raw: string, costUsd: number, valueUsd: number | null) => ({
    mint,
    rawAmount: raw,
    decimals: 6,
    costUsd,
    costSol: costUsd / 100,
    openedAt: new Date(NOW - DAY_MS),
    valueUsd,
  });
  const positions = [pos("A", "1000", 100, 150), pos("B", "1000", 50, null), pos("C", "1000", 10, 5), pos("D", "1000", 20, 30)];
  const overrides = new Map([
    ["A", { raw: BigInt(250), atMs: NOW - HOUR_MS }], // capped to 25 %
    ["B", { raw: BigInt(0), atMs: NOW - HOUR_MS }], // moved out entirely → dropped
    ["C", { raw: BigInt(100), atMs: NOW - 2 * HOUR_MS }], // traded after the read → ignored
    ["D", { raw: BigInt(5_000), atMs: NOW - HOUR_MS }], // chain holds more → unchanged
  ]);
  const lastSwap = new Map([["C", NOW - HOUR_MS]]);
  const out = applyReconcile(positions, overrides, lastSwap);
  assert.deepEqual(
    out.map((p) => [p.mint, p.rawAmount]),
    [
      ["A", "250"],
      ["C", "1000"],
      ["D", "1000"],
    ],
  );
  near(out[0]!.costUsd, 25);
  near(out[0]!.valueUsd!, 37.5);
  near(out[0]!.costSol!, 0.25);
  assert.equal(applyReconcile(positions, undefined, lastSwap).length, 4);

  assert.equal(unrealizedOf([{ costUsd: 10, valueUsd: null }]), null);
  near(unrealizedOf(out)!, 37.5 - 25 + (5 - 10) + (30 - 20));
});

test("unitPriceOf: USD per whole token from a stored valuation (price cache warm-up after a restart)", () => {
  near(unitPriceOf(37.5, "250", 0)!, 0.15);
  near(unitPriceOf(12, "3000000", 6)!, 4); // 3 tokens worth $12
  near(unitPriceOf(0, "1000", 6)!, 0);
  assert.equal(unitPriceOf(null, "1000", 6), null);
  assert.equal(unitPriceOf(5, "0", 6), null);
  assert.equal(unitPriceOf(5, "not-a-number", 6), null);
  assert.equal(unitPriceOf(-1, "1000", 6), null);
  assert.equal(unitPriceOf(5, "1000", -1), null);
});

test("aggregate: a sampled trader's score is the decayed sum across ticks", () => {
  let s = { score: 0, atMs: null as number | null };
  for (const [ago, usd] of [
    [6 * DAY_MS, 3_000],
    [3 * DAY_MS, 1_000],
    [0, 500],
  ] as const) {
    s = { score: bumpScore(s, usd, NOW - ago), atMs: NOW - ago };
  }
  near(s.score, 3_000 / Math.E ** 2 + 1_000 / Math.E + 500, 1e-6);
});
