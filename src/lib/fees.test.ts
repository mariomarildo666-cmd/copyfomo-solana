// Run: npx tsx --test src/lib/fees.test.ts
import "./__testing__/env"; // first: keeps the real .env (keys, RPC URLs) out of this test
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeSellFee,
  floorLamportsSol,
  formatFeePct,
  LIVE_WITHDRAW_BUFFER_SOL,
  planFeeSweep,
  withdrawableSol,
} from "./fees";

test("computeSellFee: 5% of the profit on a winning sell", () => {
  assert.equal(computeSellFee({ proceedsSol: 1.5, costPartSol: 1, bps: 500 }), 0.025);
  assert.equal(computeSellFee({ proceedsSol: 3, costPartSol: 1, bps: 500 }), 0.1);
  assert.equal(computeSellFee({ proceedsSol: 1.2, costPartSol: 0.2, bps: 1000 }), 0.1);
});

test("computeSellFee: losing, break-even and zero-bps sells pay nothing", () => {
  assert.equal(computeSellFee({ proceedsSol: 0.8, costPartSol: 1, bps: 500 }), 0);
  assert.equal(computeSellFee({ proceedsSol: 1, costPartSol: 1, bps: 500 }), 0);
  assert.equal(computeSellFee({ proceedsSol: 0, costPartSol: 0, bps: 500 }), 0);
  assert.equal(computeSellFee({ proceedsSol: 5, costPartSol: 1, bps: 0 }), 0);
});

test("computeSellFee: rounds DOWN to whole lamports and never exceeds proceeds or profit", () => {
  // profit 1e-9 × 5% = 5e-11 SOL → below one lamport → 0
  assert.equal(computeSellFee({ proceedsSol: 1.000000001, costPartSol: 1, bps: 500 }), 0);
  // profit 0.000000333 × 50% = 1.665e-7 → 166 lamports
  assert.equal(computeSellFee({ proceedsSol: 0.000000333, costPartSol: 0, bps: 5000 }), 0.000000166);
  const fee = computeSellFee({ proceedsSol: 2, costPartSol: 0, bps: 10_000 });
  assert.equal(fee, 2);
  // bps above 100% is clamped
  assert.equal(computeSellFee({ proceedsSol: 2, costPartSol: 1, bps: 50_000 }), 1);
});

test("computeSellFee: garbage inputs never produce a fee larger than the profit", () => {
  assert.equal(computeSellFee({ proceedsSol: Number.NaN, costPartSol: 1, bps: 500 }), 0);
  assert.equal(computeSellFee({ proceedsSol: 2, costPartSol: Number.NaN, bps: 500 }), 0, "unknown cost basis → no fee");
  assert.equal(computeSellFee({ proceedsSol: Number.POSITIVE_INFINITY, costPartSol: 1, bps: 500 }), 0);
  assert.equal(computeSellFee({ proceedsSol: 2, costPartSol: 1, bps: Number.NaN }), 0);
  assert.equal(computeSellFee({ proceedsSol: -1, costPartSol: -5, bps: 500 }), 0);
  // a negative cost (bug upstream) is treated as 0: fee on the whole proceeds, still ≤ proceeds
  assert.equal(computeSellFee({ proceedsSol: 1, costPartSol: -3, bps: 500 }), 0.05);
});

test("floorLamportsSol keeps float noise from costing a lamport", () => {
  assert.equal(floorLamportsSol(0.3), 0.3);
  assert.equal(floorLamportsSol(0.1 + 0.2), 0.3);
  assert.equal(floorLamportsSol(1.9999999999), 1.999999999);
  assert.equal(floorLamportsSol(-1), 0);
  assert.equal(floorLamportsSol(Number.NaN), 0);
});

test("withdrawableSol: paper = balance; live = balance − owed − buffer, never negative", () => {
  assert.equal(withdrawableSol({ mode: "paper", balanceSol: 1.25, feeOwedSol: 0.5 }), 1.25);
  assert.equal(withdrawableSol({ mode: "live", balanceSol: 1, feeOwedSol: 0.1 }), 1 - 0.1 - LIVE_WITHDRAW_BUFFER_SOL);
  assert.equal(withdrawableSol({ mode: "live", balanceSol: 0.05, feeOwedSol: 0.1 }), 0);
  assert.equal(withdrawableSol({ mode: "live", balanceSol: 0.001, feeOwedSol: 0 }), 0);
});

test("planFeeSweep: threshold, force before withdraw, and the rent/fee reserve", () => {
  assert.deepEqual(planFeeSweep({ balanceSol: 1, feeOwedSol: 0, minSweepSol: 0.01 }), { amountSol: 0, skip: "nothing_owed" });
  assert.deepEqual(planFeeSweep({ balanceSol: 1, feeOwedSol: 0.005, minSweepSol: 0.01 }), { amountSol: 0, skip: "below_minimum" });
  assert.deepEqual(planFeeSweep({ balanceSol: 1, feeOwedSol: 0.005, minSweepSol: 0.01, force: true }), { amountSol: 0.005, skip: null });
  assert.deepEqual(planFeeSweep({ balanceSol: 1, feeOwedSol: 0.02, minSweepSol: 0.01 }), { amountSol: 0.02, skip: null });
  // Balance can't cover everything owed: sweep what leaves the reserve, the rest stays owed.
  assert.deepEqual(planFeeSweep({ balanceSol: 0.012, feeOwedSol: 0.05, minSweepSol: 0.01 }), { amountSol: 0.01, skip: null });
  assert.deepEqual(planFeeSweep({ balanceSol: 0.002, feeOwedSol: 0.05, minSweepSol: 0.01 }), { amountSol: 0, skip: "insufficient_balance" });
});

test("formatFeePct", () => {
  assert.equal(formatFeePct(500), "5%");
  assert.equal(formatFeePct(250), "2.5%");
  assert.equal(formatFeePct(0), "0%");
});

test("live withdraw ceiling keeps the sell reserve while tokens are held (same rule as the worker, F7)", async () => {
  const fees = await import("./fees");
  assert.equal(fees.liveSellReserveSol(0), 0.005);
  assert.equal(fees.liveSellReserveSol(2_000_000), 0.005); // 2,039,280 + 10,000 + 2,000,000 lamports → 0.0041, floor 0.005
  assert.equal(fees.liveSellReserveSol(5_000_000), 0.0071); // rounded UP to 0.0001 SOL
  const base = { mode: "live" as const, balanceSol: 1, feeOwedSol: 0.1 };
  assert.equal(fees.withdrawableSol(base), 0.898);
  assert.equal(fees.withdrawableSol({ ...base, holdsTokens: true, maxPriorityFeeLamports: 2_000_000 }), 0.895);
  assert.equal(fees.withdrawableSol({ mode: "paper", balanceSol: 1, feeOwedSol: 0, holdsTokens: true }), 1);
  assert.equal(fees.liveWithdrawReserveSol({ holdsTokens: false, maxPriorityFeeLamports: 9_000_000 }), fees.LIVE_WITHDRAW_BUFFER_SOL);
});
