// Run: npx tsx --test src/worker/fomo/classify.test.ts
// Ingest classification on the verified mainnet fixtures (src/lib/__fixtures__/fomo, 0 RPC calls), the Binance
// klines parser and the backfill cursor parser.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { FOMO_MARKERS, normalizeTx, type MiniTx } from "@/lib/fomo-chain";
import { SOL_MINT, USDC_MINT } from "@/lib/solana";
import { classifyForIngest, traderOf } from "./classify";
import { newCursor, parseCursor } from "./gaps";
import { parseBinanceKlines } from "./solprice";

const FIXTURES = path.join(__dirname, "..", "..", "lib", "__fixtures__", "fomo");
const BEQV = "Beqv6dzTcjV2eodo8RRXCiCcnSYrS1vkQKhfqwHXqeit";
const CPKU = "CpKuhcFHogvrq7Fx3enu57xTRkh1WyzER1TVVBimC5mo";

function mini(sig: string): MiniTx {
  const tx = normalizeTx(JSON.parse(readFileSync(path.join(FIXTURES, `${sig}.json`), "utf8")));
  assert.ok(tx, `fixture ${sig} did not normalize`);
  return tx;
}

const BUY = "GoatANeFK8BEG3kvkhxC8f9uZFj5f1UXRNzdzdbvQE7cXwxDaZ9FDWsn27bmJMXYiBGY2xx8ZwxVNiwcXfrfgbX";
const CONVERT = "2xqnNYnC5jg299t6RSDCxpBkTabbnqZ47pej2N9RjEfYJN6bDCJGmh45jwHJs2RutsF8xhWdvvhNzWD2XSP8uMxm";
const XCHAIN = "3v41JNt8H4sUFrdFv9hSmm6oBokxp8ebw6vcpeWvopB8Zj1wFM6H4X7YbzrZ5QAfV42mLZriZGB9AwPR6MLEciew";
const COPYCAT = "q5tNbFWdV5oerqEcgAQaLjTa1p2yH6SrL5Cc1iC58VRna4AN1pzKUa1NsBpRoE2NPo6rctEALZyxADCt3jkHUX1";
const FAILED = "4em96ZVVf3oNqYTgB4qx1QR2U6uJ3dtRvXJz8YxVAGB3x5JpNHDPudrXM52wzH5djp31NbCX1drNBiyLS4KuQrN6";

const all = () => true;
const none = () => false;
const RECEIVED = Date.parse("2026-09-26T12:00:00Z");

test("trade of a tracked trader → buy row (blockTime from the tx); untracked → no row, flagged", () => {
  const tx = mini(BUY);
  assert.equal(traderOf(tx), BEQV);
  const c = classifyForIngest(tx, "stream", all, { receivedAtMs: RECEIVED, solUsd: 150 });
  assert.equal(c.cls.kind, "trade");
  assert.equal(c.user, BEQV);
  assert.ok(c.row);
  assert.equal(c.row.kind, "buy");
  assert.equal(c.row.wallet, BEQV);
  assert.equal(c.row.source, "stream");
  assert.equal(c.row.solUsd, 150);
  assert.equal(c.row.router, "dflow");
  assert.equal(c.row.blockTime.getTime(), tx.blockTimeMs);
  assert.deepEqual(c.drift, { trade: true, unknownRouter: false, unmarkedSwap: false });

  const u = classifyForIngest(tx, "stream", none, { receivedAtMs: RECEIVED });
  assert.equal(u.row, null);
  assert.equal(u.untrackedUser, true);
  assert.equal(u.user, BEQV);
});

test("transactionSubscribe payloads have no blockTime → the receive time is used", () => {
  const tx = { ...mini(BUY), blockTimeMs: null };
  const c = classifyForIngest(tx, "stream", all, { receivedAtMs: RECEIVED });
  assert.equal(c.row?.blockTime.getTime(), RECEIVED);
});

test("conversions and cross-chain orders are stored with their own kinds (never trades)", () => {
  const conv = classifyForIngest(mini(CONVERT), "backfill", all, { receivedAtMs: RECEIVED });
  assert.equal(conv.row?.kind, "convert");
  assert.equal(conv.row?.mint, SOL_MINT);
  assert.equal(conv.row?.direction, "sol_to_usdc");
  assert.equal(conv.drift.trade, false);

  const x = classifyForIngest(mini(XCHAIN), "backfill", all, { receivedAtMs: RECEIVED });
  assert.equal(x.row?.kind, "xchain");
  assert.equal(x.row?.wallet, CPKU);
  assert.equal(x.row?.mint, USDC_MINT);
  assert.equal(x.row?.router, "relay");
  assert.equal(x.row?.usd, 1_500);
});

test("not FOMO (copycat bot, failed tx) → no row and no drift", () => {
  for (const sig of [COPYCAT, FAILED]) {
    const c = classifyForIngest(mini(sig), "stream", all, { receivedAtMs: RECEIVED });
    assert.equal(c.cls.kind, "not_fomo");
    assert.equal(c.row, null);
    assert.equal(c.user, null);
    assert.deepEqual(c.drift, { trade: false, unknownRouter: false, unmarkedSwap: false });
  }
});

test("drift: a relayer-paid swap WITHOUT the marker counts as an unmarked FOMO swap (§2.7)", () => {
  const tx = mini(BUY);
  const keep = tx.keys.map((k) => !FOMO_MARKERS.includes(k.pubkey));
  assert.ok(keep.includes(false), "fixture carries the marker");
  const unmarked: MiniTx = {
    ...tx,
    keys: tx.keys.filter((_, i) => keep[i]),
    preLamports: tx.preLamports.filter((_, i) => keep[i]),
    postLamports: tx.postLamports.filter((_, i) => keep[i]),
  };
  const c = classifyForIngest(unmarked, "stream", all, { receivedAtMs: RECEIVED });
  assert.equal(c.cls.kind, "not_fomo");
  assert.equal(c.row, null);
  assert.equal(c.drift.unmarkedSwap, true);
});

test("parseBinanceKlines: [openTime, open, …] → hour start + open price; junk rows skipped", () => {
  const h = Date.parse("2026-09-26T10:00:00Z");
  const out = parseBinanceKlines([
    [h, "201.50", "203", "200", "202", "1000", h + 3_599_999],
    [h + 3_600_000, "202.00", "203", "200", "202", "1000", h + 7_199_999],
    ["bad", "1"],
    [h + 7_200_000, "0.0001"],
    [h + 10_800_000, "NaN"],
  ]);
  assert.deepEqual(out, [
    { hourMs: h, price: 201.5 },
    { hourMs: h + 3_600_000, price: 202 },
  ]);
  assert.deepEqual(parseBinanceKlines({ code: 0, msg: "Service unavailable from a restricted location" }), []);
});

test("backfill cursor round-trips through JSON; garbage reads as null", () => {
  const c = newCursor({ mode: "gap", cutoffMs: 123, prevState: "done", prevCoveredFromMs: 100 }, 1_000);
  assert.deepEqual(parseCursor(JSON.stringify(c)), c);
  assert.equal(parseCursor("not json"), null);
  assert.equal(parseCursor(JSON.stringify({ v: 2 })), null);
  assert.equal(parseCursor(null), null);
});
