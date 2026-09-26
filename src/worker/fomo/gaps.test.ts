// Run: npx tsx --test src/worker/fomo/gaps.test.ts
// Gap re-marking (pure part): a wallet already in gap repair that is marked again restarts its repair from the
// newest transaction, so its per-run progress (processed, oldestMs) restarts too. No DB is touched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { backfillOutcome, DAY_MS, HOUR_MS } from "./policy";
import { GAP_MARGIN_MS, newCursor, parseCursor, remarkGapCursor } from "./gaps";

const NOW = Date.parse("2026-09-26T12:00:00Z");

test("remarkGapCursor: paging AND per-run progress restart; cutoff = the earlier gap; restore info kept", () => {
  // First repair got deep: processed 7,900, oldest at o1 (well before the new gap).
  const o1 = NOW - 3 * DAY_MS;
  const first = newCursor({ mode: "gap", cutoffMs: NOW - 4 * DAY_MS, prevState: "done", prevCoveredFromMs: NOW - 37 * DAY_MS }, NOW - DAY_MS);
  first.path = "gtfa";
  first.token = "page-80";
  first.processed = 7_900;
  first.oldestMs = o1;

  const secondGap = NOW - HOUR_MS;
  const next = remarkGapCursor(first, Math.min(NOW - 4 * DAY_MS + GAP_MARGIN_MS, secondGap), NOW);
  assert.equal(next.token, null);
  assert.equal(next.before, null);
  assert.equal(next.startedAtMs, NOW);
  assert.equal(next.processed, 0, "the per-wallet cap counts this run only");
  assert.equal(next.oldestMs, null, "a capped run must not claim coverage from the previous run's oldest tx");
  assert.equal(next.cutoffMs, NOW - 4 * DAY_MS);
  assert.equal(next.prevState, "done");
  assert.equal(next.prevCoveredFromMs, NOW - 37 * DAY_MS);
  assert.equal(next.path, "gtfa");
  assert.equal(first.processed, 7_900, "the input cursor is not mutated");
  assert.ok(parseCursor(JSON.stringify(next)), "still a valid stored cursor");

  // The failure scenario: the first new page crosses the cap. Coverage is then only claimed from what THIS run
  // reached (the newest page), not from o1 — the second gap is not reported as repaired.
  next.processed = 8_000;
  next.oldestMs = NOW - 10 * 60_000;
  const capped = backfillOutcome({ reachedCutoff: false, endOfHistory: false, cutoffMs: next.cutoffMs, oldestMs: next.oldestMs, nowMs: NOW });
  assert.equal(capped.state, "partial");
  assert.ok(capped.coveredFromMs > secondGap, "coverage starts after the unrepaired gap");
});

test("remarkGapCursor: no readable cursor → a fresh gap cursor down to the gap − 60 s", () => {
  const from = NOW - 2 * HOUR_MS;
  const c = remarkGapCursor(null, from, NOW);
  assert.equal(c.mode, "gap");
  assert.equal(c.cutoffMs, from - GAP_MARGIN_MS);
  assert.equal(c.processed, 0);
  assert.equal(c.oldestMs, null);
  assert.equal(c.path, null);
});
