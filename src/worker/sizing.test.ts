// Run: npx tsx --test src/worker/sizing.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyBuy, applySell, sizeBuy, sizeSell, usdToSol, type SizingSettings } from "./sizing";

const base: SizingSettings = { sizingMode: "mirror", fixedSol: 0.1, maxPerTradeSol: 1, minReserveSol: 0.02 };
const HARD = 25;
const big = (n: number | string) => BigInt(n);

test("mirror copies the trader's SOL size", () => {
  assert.deepEqual(sizeBuy(base, { solAmount: 0.37, buyFraction: 0.1 }, 5, HARD), { sol: 0.37 });
});

test("mirror is capped by maxPerTradeSol and the hard max", () => {
  assert.deepEqual(sizeBuy(base, { solAmount: 12, buyFraction: 0.5 }, 50, HARD), { sol: 1 });
  const loose = { ...base, maxPerTradeSol: 100 };
  assert.deepEqual(sizeBuy(loose, { solAmount: 40, buyFraction: 0.5 }, 100, HARD), { sol: 25 });
});

test("fixed ignores the trader's size", () => {
  const s = { ...base, sizingMode: "fixed", fixedSol: 0.25 };
  assert.deepEqual(sizeBuy(s, { solAmount: 9, buyFraction: 0.9 }, 5, HARD), { sol: 0.25 });
});

test("proportional uses buyFraction × balance", () => {
  const s = { ...base, sizingMode: "proportional" };
  assert.deepEqual(sizeBuy(s, { solAmount: 3, buyFraction: 0.1 }, 4, HARD), { sol: 0.4 });
  const r = sizeBuy(s, { solAmount: 3, buyFraction: null }, 4, HARD);
  assert.ok("skip" in r);
});

test("spendable = balance − reserve caps the size", () => {
  assert.deepEqual(sizeBuy(base, { solAmount: 0.5, buyFraction: 0.1 }, 0.3, HARD), { sol: 0.28 });
});

test("below 0.001 SOL after the reserve → insufficient balance", () => {
  const r = sizeBuy(base, { solAmount: 0.5, buyFraction: 0.1 }, 0.0205, HARD);
  assert.ok("skip" in r);
  assert.equal(r.skip, "insufficient balance");
  assert.equal(r.intendedSol, 0.5);
});

test("a tiny original trade is skipped as below the minimum", () => {
  const r = sizeBuy(base, { solAmount: 0.0004, buyFraction: 0.001 }, 5, HARD);
  assert.ok("skip" in r && r.skip === "below 0.001 SOL minimum");
});

test("sizes are rounded down to whole lamports", () => {
  const r = sizeBuy(base, { solAmount: 0.1234567891234, buyFraction: 0.1 }, 5, HARD);
  assert.deepEqual(r, { sol: 0.123456789 });
});

test("usdToSol: USD value at the SOL price, sign kept; no usable price → null", () => {
  assert.equal(usdToSol(50, 200), 0.25);
  assert.equal(usdToSol(-50, 200), -0.25);
  assert.equal(usdToSol(0, 200), 0);
  for (const bad of [null, undefined, 0, -150, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(usdToSol(50, bad), null, `price ${String(bad)}`);
  }
  assert.equal(usdToSol(Number.NaN, 200), null);
});

test("FOMO (USDC-quoted) buy: 1:1 mirror = same USD value converted at the current SOL price", () => {
  // Trader spent $50 of USDC; SOL at $200 → the agent buys 0.25 SOL worth.
  const sol = usdToSol(50, 200);
  assert.ok(sol !== null);
  assert.deepEqual(sizeBuy(base, { solAmount: sol, buyFraction: 0.1 }, 5, HARD), { sol: 0.25 });
  // Same $50 when SOL is $125 → 0.4 SOL.
  assert.deepEqual(sizeBuy(base, { solAmount: usdToSol(50, 125)!, buyFraction: 0.1 }, 5, HARD), { sol: 0.4 });
  // A $10,000 whale buy is still capped by maxPerTradeSol.
  assert.deepEqual(sizeBuy(base, { solAmount: usdToSol(10_000, 200)!, buyFraction: 0.5 }, 100, HARD), { sol: 1 });
  // $0.10 at $200 = 0.0005 SOL: below the minimum, skipped.
  const tiny = sizeBuy(base, { solAmount: usdToSol(0.1, 200)!, buyFraction: 0.001 }, 5, HARD);
  assert.ok("skip" in tiny && tiny.skip === "below 0.001 SOL minimum");
  // fixed / proportional sizing ignore the USD value
  assert.deepEqual(sizeBuy({ ...base, sizingMode: "fixed", fixedSol: 0.2 }, { solAmount: sol, buyFraction: 0.1 }, 5, HARD), { sol: 0.2 });
  assert.deepEqual(sizeBuy({ ...base, sizingMode: "proportional" }, { solAmount: sol, buyFraction: 0.1 }, 5, HARD), { sol: 0.5 });
});

test("mirror with a zero or invalid trader size is skipped, never guessed", () => {
  for (const solAmount of [0, -1, Number.NaN]) {
    const r = sizeBuy(base, { solAmount, buyFraction: 0.1 }, 5, HARD);
    assert.ok("skip" in r && r.skip === "invalid trade size", `solAmount ${solAmount}`);
  }
});

test("unknown sizing mode is skipped, never guessed", () => {
  const r = sizeBuy({ ...base, sizingMode: "yolo" }, { solAmount: 1, buyFraction: 1 }, 5, HARD);
  assert.ok("skip" in r);
});

test("sizeSell: proportional floor, 0.98 full-exit rule, bounds", () => {
  assert.equal(sizeSell(big(1000), 0.25), big(250));
  assert.equal(sizeSell(big(999), 0.5), big(499)); // floor
  assert.equal(sizeSell(big(1000), 0.979), big(979));
  assert.equal(sizeSell(big(1000), 0.98), big(1000));
  assert.equal(sizeSell(big(1000), 1), big(1000));
  assert.equal(sizeSell(big(1000), 0), big(0));
  assert.equal(sizeSell(big(0), 0.5), big(0));
  assert.equal(sizeSell(big(1000), Number.NaN), big(0));
  // Large sleeves (pump.fun supply scale) keep integer precision.
  assert.equal(sizeSell(big("123456789012345678"), 0.5), big("61728394506172839"));
});

test("applyBuy opens and grows a sleeve", () => {
  const p1 = applyBuy(null, big(1000), 0.5);
  assert.deepEqual(p1, { rawAmount: big(1000), costSol: 0.5, realizedSol: 0 });
  const p2 = applyBuy(p1, big(500), 0.1);
  assert.equal(p2.rawAmount, big(1500));
  assert.ok(Math.abs(p2.costSol - 0.6) < 1e-12);
});

test("applySell reduces cost basis proportionally and books realized PnL", () => {
  const pos = { rawAmount: big(1000), costSol: 1, realizedSol: 0 };
  const half = applySell(pos, big(500), 0.8);
  assert.equal(half.rawAmount, big(500));
  assert.ok(Math.abs(half.costPart - 0.5) < 1e-12);
  assert.ok(Math.abs(half.costSol - 0.5) < 1e-12);
  assert.ok(Math.abs(half.realizedSol - 0.3) < 1e-12);

  const rest = applySell(half, big(500), 0.2);
  assert.equal(rest.rawAmount, big(0));
  assert.equal(rest.costSol, 0);
  assert.ok(Math.abs(rest.realizedSol - 0) < 1e-12); // +0.3 then −0.3
});

test("applySell clamps oversells to the sleeve", () => {
  const pos = { rawAmount: big(100), costSol: 0.2, realizedSol: 0.05 };
  const r = applySell(pos, big(1000), 0.1);
  assert.equal(r.rawAmount, big(0));
  assert.equal(r.costPart, 0.2);
  assert.ok(Math.abs(r.realizedSol - (0.05 + 0.1 - 0.2)) < 1e-12);
});
