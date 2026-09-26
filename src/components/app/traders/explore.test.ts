// Explore / leaderboard list helpers: filter chips, sort orders, search, token labels.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { TraderDTO } from "@/lib/types";
import { applyFilter, isWalletLike, matchesQuery, namedTokens, sortTraders, tokenChip } from "./explore";

function trader(p: Partial<TraderDTO> & { wallet: string }): TraderDTO {
  return {
    handle: null,
    displayName: null,
    xHandle: null,
    avatarUrl: null,
    source: "fomo",
    verified: false,
    rank: null,
    pnlUsd: null,
    pnlSol: null,
    unrealizedUsd: null,
    volumeUsd: null,
    trades: null,
    winRate: null,
    lastTradeAt: null,
    coverage: null,
    xchainShare: null,
    topTokens: [],
    copiers: 0,
    ...p,
  };
}

const ROWS = [
  trader({ wallet: "A", rank: 1, pnlUsd: 900, trades: 10, winRate: 0.7, volumeUsd: 5, copiers: 0, displayName: "miau", topTokens: ["STONK"] }),
  trader({ wallet: "B", rank: 2, pnlUsd: 500, trades: 400, winRate: 0.2, volumeUsd: 50, copiers: 3, handle: "catsuki" }),
  trader({ wallet: "C", rank: 3, pnlUsd: 100, trades: 50, winRate: 0.5, volumeUsd: 9, copiers: 1 }),
  trader({ wallet: "D", rank: 4, pnlUsd: -50, trades: 20, winRate: null, volumeUsd: 1, copiers: 0 }),
  trader({ wallet: "E", rank: null, pnlUsd: null, trades: null, winRate: 0.9, volumeUsd: null, copiers: 0 }),
];

test("filters: all keeps everything; win rate is ≥ 50%; top PnL / most active are the top quarter", () => {
  assert.equal(applyFilter(ROWS, "all").length, 5);
  assert.deepEqual(applyFilter(ROWS, "win").map((t) => t.wallet), ["A", "C", "E"]);
  // three profitable rows → the top quarter is 1 row
  assert.deepEqual(applyFilter(ROWS, "top").map((t) => t.wallet), ["A"]);
  // four rows with trades → the top quarter is 1 row
  assert.deepEqual(applyFilter(ROWS, "active").map((t) => t.wallet), ["B"]);
  assert.deepEqual(applyFilter([], "top"), []);
});

test("sort: pnl keeps the server order; others descend with nulls last and ties by rank", () => {
  assert.equal(sortTraders(ROWS, "pnl"), ROWS);
  assert.deepEqual(sortTraders(ROWS, "trades").map((t) => t.wallet), ["B", "C", "D", "A", "E"]);
  assert.deepEqual(sortTraders(ROWS, "win").map((t) => t.wallet), ["E", "A", "C", "B", "D"]);
  assert.deepEqual(sortTraders(ROWS, "copiers").map((t) => t.wallet), ["B", "C", "A", "D", "E"]);
  assert.deepEqual(sortTraders(ROWS, "volume").map((t) => t.wallet), ["B", "C", "A", "D", "E"]);
});

test("search matches name, @handle, wallet and $token, case-insensitively", () => {
  assert.ok(matchesQuery(ROWS[0], "MIAU"));
  assert.ok(matchesQuery(ROWS[0], "$stonk"));
  assert.ok(matchesQuery(ROWS[1], "@CatSuki"));
  assert.ok(matchesQuery(ROWS[2], "c"));
  assert.ok(matchesQuery(ROWS[2], "  "));
  assert.ok(!matchesQuery(ROWS[3], "miau"));
});

test("wallet detection and token labels", () => {
  assert.ok(isWalletLike("7LoRpjZ1wS3dG1v3CUKi2mz5eB6sBy1SFFtBNGeBENhz"));
  assert.ok(!isWalletLike("miau"));
  assert.ok(!isWalletLike("0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl"));
  assert.equal(tokenChip("STONK"), "$STONK");
  assert.equal(tokenChip("pgtg…Wp3P"), "pgtg…Wp3P");
  assert.equal(tokenChip("7LoRpjZ1wS3dG1v3CUKi2mz5eB6sBy1SFFtBNGeBENhz"), "7LoR…ENhz");
  assert.deepEqual(namedTokens(["STONK", "pgtg…Wp3P", "CATE"]), ["$STONK", "$CATE"]);
  assert.deepEqual(namedTokens(["pgtg…Wp3P"]), ["pgtg…Wp3P"]);
});
