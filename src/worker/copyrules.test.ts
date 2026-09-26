// Run: npx tsx --test src/worker/copyrules.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type { FomoClass } from "@/lib/fomo-chain";
import { copyVenueSkipReason, dispatchTargets, isFomoIngestible, NOT_FOMO_TRADE, venueOf } from "./copyrules";

const MINT = "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr";
const OTHER_MINT = "9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump";
const USER = "Beqv6dzTcjV2eodo8RRXCiCcnSYrS1vkQKhfqwHXqeit";

const trade = (side: "buy" | "sell", mint = MINT): FomoClass => ({
  kind: "trade",
  user: USER,
  side,
  mint,
  tokenRaw: BigInt(1000),
  decimals: 6,
  usdcRaw: BigInt(50_000_000),
  router: "dflow",
});

test("venue: fomo only when rule R says this wallet's trade of the same token and side", () => {
  assert.equal(venueOf(trade("buy"), { side: "buy", mint: MINT }), "fomo");
  assert.equal(venueOf(trade("sell"), { side: "sell", mint: MINT }), "fomo");
  // parser / rule disagreement is never promoted to "fomo"
  assert.equal(venueOf(trade("buy"), { side: "sell", mint: MINT }), "other");
  assert.equal(venueOf(trade("buy", OTHER_MINT), { side: "buy", mint: MINT }), "other");
  // everything rule R rejects
  for (const reason of ["failed", "fee_payer", "signers", "other_user", "no_marker", "multi_token", "no_usdc_leg", "same_direction", "no_token_leg"] as const) {
    assert.equal(venueOf({ kind: "not_fomo", reason }, { side: "buy", mint: MINT }), "other", reason);
  }
  // conversions / cross-chain orders are not trades
  assert.equal(venueOf({ kind: "xchain", user: USER, usdcRaw: BigInt(1) }, { side: "buy", mint: MINT }), "other");
  assert.equal(
    venueOf(
      { kind: "convert", user: USER, direction: "usdc_to_sol", usdcRaw: BigInt(1), lamports: BigInt(1), router: "dflow" },
      { side: "sell", mint: MINT },
    ),
    "other",
  );
});

test("COPY_VENUE=fomo: non-FOMO buys are skipped with a reason; sells from any venue are copied", () => {
  assert.equal(copyVenueSkipReason("buy", "other", "fomo"), NOT_FOMO_TRADE);
  assert.equal(NOT_FOMO_TRADE, "not a FOMO trade");
  assert.equal(copyVenueSkipReason("buy", "fomo", "fomo"), null);
  assert.equal(copyVenueSkipReason("sell", "other", "fomo"), null);
  assert.equal(copyVenueSkipReason("sell", "fomo", "fomo"), null);
  // unknown / legacy venue values are treated as not-FOMO for buys
  assert.equal(copyVenueSkipReason("buy", "", "fomo"), NOT_FOMO_TRADE);
});

test("COPY_VENUE=all: every buy and sell may be copied", () => {
  for (const side of ["buy", "sell"]) for (const venue of ["fomo", "other"]) assert.equal(copyVenueSkipReason(side, venue, "all"), null);
});

test("indexer hand-over: trades, conversions and cross-chain orders; nothing rule R rejects", () => {
  assert.equal(isFomoIngestible(trade("buy")), true);
  assert.equal(isFomoIngestible({ kind: "xchain", user: USER, usdcRaw: BigInt(5) }), true);
  assert.equal(
    isFomoIngestible({ kind: "convert", user: USER, direction: "sol_to_usdc", usdcRaw: BigInt(5), lamports: BigInt(9), router: "okx" }),
    true,
  );
  assert.equal(isFomoIngestible({ kind: "not_fomo", reason: "no_marker" }), false);
});

test("dispatch: buys reach followers only; sells also reach sleeve holders (deduplicated)", () => {
  const followers = [
    { agentId: "a1", mode: "paper" },
    { agentId: "a2", mode: "live" },
  ];
  const holders = [
    { agentId: "a2", mode: "live" }, // follows and holds: once
    { agentId: "a3", mode: "paper" }, // unfollowed the trader but still holds the sleeve
  ];
  assert.deepEqual(dispatchTargets("buy", followers, holders).map((a) => a.agentId), ["a1", "a2"]);
  assert.deepEqual(dispatchTargets("sell", followers, holders).map((a) => a.agentId), ["a1", "a2", "a3"]);
  assert.deepEqual(dispatchTargets("sell", [], holders).map((a) => a.agentId), ["a2", "a3"]);
  assert.deepEqual(dispatchTargets("buy", [], holders), []);
  assert.deepEqual(dispatchTargets("sell", followers, [{ agentId: "a1", mode: "paper" }, { agentId: "a1", mode: "paper" }]).length, 2);
});
