// Run: npx tsx --test src/lib/fomo-stats.test.ts
// FIFO PnL (design §4.3 required cases 1–7) + eligibility and rank ordering (§4.4).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assignRanks,
  compareForRank,
  computeWalletStats,
  isEligible,
  RANKING_RULES,
  solUsdLookup,
  type StatsSwap,
} from "./fomo-stats";

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-09-26T12:00:00Z");
const MINT = "MintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const MINT_B = "MintBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

let slot = 1_000;
function swap(kind: StatsSwap["kind"], tokenRaw: number | string, usd: number, agoMs: number, extra: Partial<StatsSwap> = {}): StatsSwap {
  slot += 1;
  return {
    signature: `sig${slot}`,
    slot,
    txIndex: 0,
    blockTime: new Date(NOW - agoMs),
    kind,
    mint: MINT,
    tokenRaw: String(tokenRaw),
    decimals: 0,
    usd,
    ...extra,
  };
}

const FULL = NOW - 40 * DAY; // history complete for every window

function near(actual: number | null | undefined, expected: number, msg?: string) {
  assert.ok(actual !== null && actual !== undefined, msg ?? "value is null");
  assert.ok(Math.abs(actual - expected) < 1e-9, `${msg ?? ""} expected ${expected}, got ${actual}`);
}

test("1. buy 100 for $10, sell 100 for $15 → +$5, a win", () => {
  const s = computeWalletStats([swap("buy", 100, 10, 3 * HOUR), swap("sell", 100, 15, 2 * HOUR)], { now: NOW, coveredFrom: FULL });
  const w = s.windows["24h"];
  near(w.realizedPnlUsd, 5);
  assert.equal(w.winRate, 1);
  assert.equal(w.trades, 2);
  near(w.volumeUsd, 25);
  near(w.unmatchedSellUsd, 0);
  assert.equal(s.positions.length, 0);
});

test("2. buy 100/$10, buy 100/$20, sell 150/$45 → cost $20, +$25; 50 remain costing $10", () => {
  const s = computeWalletStats(
    [swap("buy", 100, 10, 5 * HOUR), swap("buy", 100, 20, 4 * HOUR), swap("sell", 150, 45, 3 * HOUR)],
    { now: NOW, coveredFrom: FULL },
  );
  near(s.windows["24h"].realizedPnlUsd, 25);
  assert.equal(s.positions.length, 1);
  assert.equal(s.positions[0]!.rawAmount, "50");
  near(s.positions[0]!.costUsd, 10);
  assert.equal(s.windows["24h"].openPositions, 1);
});

test("3. sell with no lots → realized 0, unmatchedSellUsd $20", () => {
  const s = computeWalletStats([swap("sell", 100, 20, HOUR)], { now: NOW, coveredFrom: FULL });
  const w = s.windows["24h"];
  near(w.realizedPnlUsd, 0);
  near(w.unmatchedSellUsd, 20);
  assert.equal(w.winRate, null, "no matched sell → no win rate");
  near(w.realizedPnlSol, 0);
});

test("4. buy 50 for $5, sell 100 for $20 → +$5, unmatched $10", () => {
  const s = computeWalletStats([swap("buy", 50, 5, 2 * HOUR), swap("sell", 100, 20, HOUR)], { now: NOW, coveredFrom: FULL });
  near(s.windows["24h"].realizedPnlUsd, 5);
  near(s.windows["24h"].unmatchedSellUsd, 10);
  const sell = [...s.sells.values()][0]!;
  near(sell.matchedShare, 0.5);
});

test("5. buy 8 days ago, sell 2 days ago → realized counts in 7d, the buy is not in 7d volume", () => {
  const s = computeWalletStats([swap("buy", 100, 10, 8 * DAY), swap("sell", 100, 30, 2 * DAY)], { now: NOW, coveredFrom: FULL });
  const w7 = s.windows["7d"];
  near(w7.realizedPnlUsd, 20);
  near(w7.volumeUsd, 30);
  assert.equal(w7.buys, 0);
  assert.equal(w7.sells, 1);
  const w30 = s.windows["30d"];
  near(w30.volumeUsd, 40);
  assert.equal(w30.trades, 2);
  const w24 = s.windows["24h"];
  assert.equal(w24.trades, 0);
  near(w24.realizedPnlUsd, 0);
});

test("6. conversions and xchain are excluded; xchainShare is computed", () => {
  const s = computeWalletStats(
    [
      swap("buy", 100, 300, 5 * HOUR),
      swap("convert", 414_559_323, 50, 4 * HOUR, { mint: "So11111111111111111111111111111111111111112", decimals: 9 }),
      swap("xchain", 100_000_000, 100, 3 * HOUR, { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", decimals: 6 }),
      swap("sell", 100, 330, 2 * HOUR),
    ],
    { now: NOW, coveredFrom: FULL },
  );
  const w = s.windows["24h"];
  assert.equal(w.trades, 2);
  near(w.volumeUsd, 630);
  near(w.buyVolumeUsd, 300);
  near(w.realizedPnlUsd, 30);
  near(w.xchainUsd, 100);
  near(w.xchainShare, 0.25);
  assert.equal(w.mintsTraded, 1);
  assert.equal(s.positions.length, 0, "convert / xchain never open positions");
});

test("7. buy $100 at SOL=$100, sell $120 at SOL=$120 → +$20 and 0 SOL", () => {
  const buyT = 5 * HOUR;
  const sellT = 2 * HOUR;
  const prices = solUsdLookup([
    { hour: new Date(NOW - buyT), price: 100 },
    { hour: new Date(NOW - sellT), price: 120 },
  ]);
  const s = computeWalletStats([swap("buy", 100, 100, buyT), swap("sell", 100, 120, sellT)], {
    now: NOW,
    coveredFrom: FULL,
    solUsdAt: prices,
  });
  near(s.windows["24h"].realizedPnlUsd, 20);
  near(s.windows["24h"].realizedPnlSol, 0);
  // A swap-level solUsd wins over the lookup.
  const s2 = computeWalletStats(
    [swap("buy", 100, 100, buyT, { solUsd: 100 }), swap("sell", 100, 120, sellT, { solUsd: 100 })],
    { now: NOW, coveredFrom: FULL, solUsdAt: prices },
  );
  near(s2.windows["24h"].realizedPnlSol, 0.2);
  // No SOL price for the sell → SOL PnL unknown (null), USD PnL unaffected.
  const s3 = computeWalletStats([swap("buy", 100, 100, buyT), swap("sell", 100, 120, sellT)], {
    now: NOW,
    coveredFrom: FULL,
    solUsdAt: (t) => (t === NOW - buyT ? 100 : null),
  });
  near(s3.windows["24h"].realizedPnlUsd, 20);
  assert.equal(s3.windows["24h"].realizedPnlSol, null);
});

test("order is (slot, txIndex, signature), not array order or blockTime", () => {
  const buy = swap("buy", 100, 10, HOUR);
  const sell = swap("sell", 100, 15, 2 * HOUR); // later slot, earlier (skewed) blockTime
  const s = computeWalletStats([sell, buy], { now: NOW, coveredFrom: FULL });
  near(s.windows["24h"].realizedPnlUsd, 5);
  near(s.windows["24h"].unmatchedSellUsd, 0);
});

test("partial fills keep proportional cost; dust positions (< $0.01) are dropped", () => {
  const s = computeWalletStats(
    [
      swap("buy", 1_000_000, 100, 6 * HOUR),
      swap("sell", 250_000, 40, 5 * HOUR),
      swap("buy", 10, 0.001, 4 * HOUR, { mint: MINT_B }),
    ],
    { now: NOW, coveredFrom: FULL, prices: { [MINT]: 0.0002 } },
  );
  near(s.windows["24h"].realizedPnlUsd, 15);
  assert.equal(s.positions.length, 1);
  assert.equal(s.positions[0]!.rawAmount, "750000");
  near(s.positions[0]!.costUsd, 75);
  near(s.positions[0]!.valueUsd, 150);
  near(s.unrealizedPnlUsd, 75);
  near(s.windows["30d"].unrealizedPnlUsd, 75);
});

test("unrealized PnL is null (never 0) when no open position is priced", () => {
  const s = computeWalletStats([swap("buy", 100, 10, HOUR)], { now: NOW, coveredFrom: FULL });
  assert.equal(s.unrealizedPnlUsd, null);
  assert.equal(s.windows["24h"].unrealizedPnlUsd, null);
  assert.equal(s.positions[0]!.valueUsd, null);
});

test("win rate, active days, top mints and per-mint breakdown", () => {
  const s = computeWalletStats(
    [
      swap("buy", 100, 10, 3 * DAY),
      swap("sell", 100, 25, 2 * DAY), // +15 on MINT
      swap("buy", 100, 50, 2 * DAY, { mint: MINT_B }),
      swap("sell", 100, 20, 1 * DAY + HOUR, { mint: MINT_B }), // −30 on MINT_B
    ],
    { now: NOW, coveredFrom: FULL },
  );
  const w = s.windows["7d"];
  near(w.realizedPnlUsd, -15);
  near(w.winRate, 0.5);
  assert.equal(w.activeDays, 3);
  assert.equal(w.mintsTraded, 2);
  assert.deepEqual(
    w.topMints.map((m) => m.mint),
    [MINT_B, MINT],
  );
  assert.equal(w.lastTradeAt?.getTime(), NOW - DAY - HOUR);
  assert.deepEqual(
    s.perMint.map((m) => [m.mint, m.realizedPnlUsd, m.trades]),
    [
      [MINT_B, -30, 2],
      [MINT, 15, 2],
    ],
  );
});

// ── Eligibility & ranking (§4.4) ────────────────────────────────────────────────────────────────────

test("RANKING_RULES match the design table", () => {
  assert.deepEqual(RANKING_RULES, {
    "24h": { minTrades: 3, minVolumeUsd: 250, minActiveDays: 1 },
    "7d": { minTrades: 10, minVolumeUsd: 1_000, minActiveDays: 2 },
    "30d": { minTrades: 20, minVolumeUsd: 5_000, minActiveDays: 3 },
  });
});

test("eligibility needs every minimum, full coverage and not excluded", () => {
  const ok = { trades: 3, volumeUsd: 250, activeDays: 1, coverage: "full" as const };
  const r = RANKING_RULES["24h"];
  assert.equal(isEligible(ok, r), true);
  assert.equal(isEligible({ ...ok, trades: 2 }, r), false);
  assert.equal(isEligible({ ...ok, volumeUsd: 249.99 }, r), false);
  assert.equal(isEligible({ ...ok, activeDays: 0 }, r), false);
  assert.equal(isEligible({ ...ok, coverage: "partial" }, r), false);
  assert.equal(isEligible(ok, r, true), false);
});

test("computeWalletStats sets coverage and eligibility per window", () => {
  const trades = [
    swap("buy", 100, 100, 3 * HOUR),
    swap("sell", 50, 80, 2 * HOUR),
    swap("sell", 50, 90, 1 * HOUR),
  ];
  const full = computeWalletStats(trades, { now: NOW, coveredFrom: FULL });
  assert.equal(full.windows["24h"].coverage, "full");
  assert.equal(full.windows["24h"].eligible, true);
  assert.equal(full.windows["7d"].eligible, false, "7d needs 10 trades");

  const recent = computeWalletStats(trades, { now: NOW, coveredFrom: NOW - 2 * DAY });
  assert.equal(recent.windows["24h"].coverage, "full");
  assert.equal(recent.windows["7d"].coverage, "partial");
  assert.equal(recent.windows["30d"].coverage, "partial");

  const unknown = computeWalletStats(trades, { now: NOW, coveredFrom: null });
  assert.equal(unknown.windows["24h"].coverage, "partial");
  assert.equal(unknown.windows["24h"].eligible, false);

  const excluded = computeWalletStats(trades, { now: NOW, coveredFrom: FULL, excluded: true });
  assert.equal(excluded.windows["24h"].eligible, false);
});

test("rank = eligible rows by realized PnL desc, then volume desc, then wallet asc", () => {
  const rows = [
    { wallet: "Cwallet", eligible: true, realizedPnlUsd: 100, volumeUsd: 1_000 },
    { wallet: "Awallet", eligible: true, realizedPnlUsd: 100, volumeUsd: 1_000 },
    { wallet: "Bwallet", eligible: true, realizedPnlUsd: 100, volumeUsd: 5_000 },
    { wallet: "Dwallet", eligible: true, realizedPnlUsd: 500, volumeUsd: 10 },
    { wallet: "Ewallet", eligible: false, realizedPnlUsd: 9_999, volumeUsd: 99_999 },
    { wallet: "Fwallet", eligible: true, realizedPnlUsd: -50, volumeUsd: 100_000 },
  ];
  const ranks = assignRanks(rows);
  assert.deepEqual([...ranks.entries()], [
    ["Dwallet", 1],
    ["Bwallet", 2],
    ["Awallet", 3],
    ["Cwallet", 4],
    ["Fwallet", 5],
  ]);
  assert.equal(ranks.has("Ewallet"), false, "ineligible rows are never ranked");
  assert.ok(compareForRank(rows[1]!, rows[0]!) < 0);
});

test("solUsdLookup: nearest hour within ±6 h, else null", () => {
  const f = solUsdLookup([
    { hour: NOW, price: 150 },
    { hour: NOW + 10 * HOUR, price: 160 },
  ]);
  assert.equal(f(NOW + 2 * HOUR), 150);
  assert.equal(f(NOW + 6 * HOUR), 160);
  assert.equal(f(NOW - 6 * HOUR), 150);
  assert.equal(f(NOW - 7 * HOUR), null);
  assert.equal(f(NOW + 17 * HOUR), null);
  assert.equal(solUsdLookup([])(NOW), null);
});
