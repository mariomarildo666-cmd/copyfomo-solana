// Run: npx tsx --test src/lib/fomo-chain.test.ts
// Rule R over the 21 verified mainnet fixtures of design §2.6 (copied from the research caches, 0 RPC calls).
// Expected outcomes match scratchpad/design/fixtures.mjs; the full classifier also matched the reference
// on all 2,892 cached transactions of the investigation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  classifyFomoTx,
  FOMO_MARKER,
  FOMO_MARKER_SINCE,
  FOMO_RELAYER,
  hasFomoFingerprint,
  isUnmarkedFomoSwap,
  logsLookLikeFomoCandidate,
  normalizeTx,
  toFomoSwapRow,
  type FomoClass,
  type MiniTx,
} from "./fomo-chain";
import { SOL_MINT, USDC_MINT } from "./solana";

const FIXTURE_DIR = path.join(__dirname, "__fixtures__", "fomo");

type Raw = {
  blockTime: number;
  slot: number;
  transactionIndex?: number;
  version?: unknown;
  transaction: { signatures: string[]; message: { accountKeys: { pubkey: string; signer: boolean; writable: boolean; source?: string }[] } & Record<string, unknown> };
  meta: Record<string, unknown> & { logMessages?: string[] };
};

function load(sig: string): Raw {
  return JSON.parse(readFileSync(path.join(FIXTURE_DIR, `${sig}.json`), "utf8")) as Raw;
}

function mini(raw: unknown): MiniTx {
  const tx = normalizeTx(raw);
  assert.ok(tx, "normalizeTx returned null");
  return tx;
}

type Expect =
  | { kind: "trade"; side: "buy" | "sell"; router: string; user: string; mint: string; tokenRaw: string; decimals: number; usdcRaw: string }
  | { kind: "convert"; direction: "sol_to_usdc" | "usdc_to_sol"; router: string; user: string; usdcRaw: string; lamports: string }
  | { kind: "xchain"; user: string; usdcRaw: string }
  | { kind: "not_fomo"; reason: string };

const BEQV = "Beqv6dzTcjV2eodo8RRXCiCcnSYrS1vkQKhfqwHXqeit";
const EC2F = "EC2f5DnHzuNRit1ExqghSifDbp1wgrzktsRRZCtU92MJ";

const CASES: { sig: string; label: string; expect: Expect }[] = [
  {
    sig: "j9bBAkSYECTUYdF67adCeeSfWBKUYPdTsAZ6n1UwvhVZuMXj9SAu6WaKkJNR8vJH5Xv97nipPh8pws32bTM9WKZ",
    label: "trade sell, dflow",
    expect: { kind: "trade", side: "sell", router: "dflow", user: EC2F, mint: "DEW9dSN6QpWyNthphCpMmAbZP1Q4cEKR9xQXAri98WDP", tokenRaw: "827501409510", decimals: 6, usdcRaw: "11458066428" },
  },
  {
    sig: "GoatANeFK8BEG3kvkhxC8f9uZFj5f1UXRNzdzdbvQE7cXwxDaZ9FDWsn27bmJMXYiBGY2xx8ZwxVNiwcXfrfgbX",
    label: "trade buy, dflow",
    expect: { kind: "trade", side: "buy", router: "dflow", user: BEQV, mint: "6GmAFSYs4gk3FDao5FzzySQpPZaWsa4rUJHacpMpUNgx", tokenRaw: "57659698541", decimals: 9, usdcRaw: "15671430" },
  },
  {
    sig: "63szuHVMLm15dYbKCBoSkcjFHTGUknUAdLhyoVMAB85kF8em9DrdqMUkQpaJPdjUUZd2zYdPJ3bGTCmSAi92k8Lu",
    label: "trade buy, jupiter",
    expect: { kind: "trade", side: "buy", router: "jupiter", user: BEQV, mint: "6GmAFSYs4gk3FDao5FzzySQpPZaWsa4rUJHacpMpUNgx", tokenRaw: "3780142738939", decimals: 9, usdcRaw: "1031406057" },
  },
  {
    sig: "2txvKPu4pK5munkQtkKVhHwP2rPPoZAbi5xLLjKHFV2GUkiDKMWfaLJrdek5QjSo6qb74dhPaGmLwFccK6DYwHCn",
    label: "trade sell, jupiter",
    expect: { kind: "trade", side: "sell", router: "jupiter", user: BEQV, mint: "5rzMk1M2ayGPQ3zQLkWV6FMxvaLAXeXrAzotYLF5chcg", tokenRaw: "26961534800244", decimals: 6, usdcRaw: "210856127" },
  },
  {
    sig: "5Qc75eARmBNy1JcEs7hhKrRjeffWdCG4oCXG5GhsPKzyj7pnHP7Tqb8CNJvwkWupH8BxjdGU5iWPgkPjHR5WQTGR",
    label: "trade sell, okx",
    expect: { kind: "trade", side: "sell", router: "okx", user: EC2F, mint: "HTmQz7My6MehV7bjhJ6jde8nDND1yvsz68d24LP7YgUQ", tokenRaw: "918356604240", decimals: 6, usdcRaw: "9575736940" },
  },
  {
    sig: "5Mh5bDV9m7ZVPzqE5koxvwE8zJsgf2Uq6cFPJbS14c4MbfDc7Fhy8pKwEsxNJZq6EVBxVirGmHJXkT9K8Ru6tHxA",
    label: "trade buy, okx",
    expect: { kind: "trade", side: "buy", router: "okx", user: "5MfuqNSawthUL1qdJJTN8DauQvJYSUkuuZuySXuVc6Tz", mint: "HcRLc9VDgjLeK154xDawfb1dmVJ98DoSqcwTHGqiDeJR", tokenRaw: "132819009503044", decimals: 9, usdcRaw: "10000000000" },
  },
  {
    sig: "2ZGbCbph1etfvnPu3oa3QpWUzhTyXA3wrou7ETm2vgcPJbd1agBpQwb1ES6AmZUbSCkAFQERnoWVs2r4zFXgwC4m",
    label: "trade buy (fee not paid to HrTf9)",
    expect: { kind: "trade", side: "buy", router: "dflow", user: "DyXg3Xp6BoMq5K6Nmdb7hEzPMpkRWH2aXHHZhUgN1gd6", mint: "CvUX4G2tzq7J3ECmNvWZLayZYV6KpgQp6SJ5K8Uvsu5g", tokenRaw: "2310097411636", decimals: 6, usdcRaw: "5765322852" },
  },
  {
    sig: "2tGxcY8TbnyRmALTin5GKShbkVwfyQRmP3bdExH2eCq3DpmPxS11cfUUnw97g5q3L3KUpeusFRFJaaw4HpPjratF",
    label: "trade buy (second-token dust tolerated)",
    expect: { kind: "trade", side: "buy", router: "dflow", user: "4d1DygHccEYaiHqqbX22oU7sLt88apQecgnAJHXY59jS", mint: "pwfAeX3kpWpkuumA6iodJxtVcGAen6BkRPToR2VqLp9", tokenRaw: "53657553246", decimals: 6, usdcRaw: "15000000" },
  },
  {
    sig: "2dsK8RtBnPxvnWEtRboUXrDQLWhSwABai7WJrpJyT3hNMA6dMXD1yRPqQxwkMAtQzo5PnnZDqa2QpfAFyagbxm7Z",
    label: "trade buy, fomo_legacy router (2026-01-06)",
    expect: { kind: "trade", side: "buy", router: "fomo_legacy", user: "5qeQz8yDNob7qKpGWq9BpfMfmtyGhHKHqyVNQj5Thbik", mint: "2TsmuYUrsctE57VLckZBYEEzdokUF8j8e1GavekWBAGS", tokenRaw: "427231270494991", decimals: 9, usdcRaw: "250000000" },
  },
  {
    sig: "2xqnNYnC5jg299t6RSDCxpBkTabbnqZ47pej2N9RjEfYJN6bDCJGmh45jwHJs2RutsF8xhWdvvhNzWD2XSP8uMxm",
    label: "convert sol_to_usdc (deposit auto-convert)",
    expect: { kind: "convert", direction: "sol_to_usdc", router: "dflow", user: "8v45Gc95EXicMWkHLaRmMYB46BijLXGMn93XUg46kTh6", usdcRaw: "49894017", lamports: "414559323" },
  },
  {
    sig: "5jAudDj4Jpy4hbtWifE7LEKJZ81noYrvTi8QGP5iz628z4f2HouxuxcMVHBJJcb6X7DeyHvXEcRehZi1KYAXee4X",
    label: "convert usdc_to_sol (cash-out)",
    expect: { kind: "convert", direction: "usdc_to_sol", router: "dflow", user: "G2vhbPCG5jAbBjFCJnLBbGJco93r3iw1WuvmL8csvJMD", usdcRaw: "11997070520", lamports: "104267978006" },
  },
  {
    sig: "2Y2QWbuGC2VQh1J6a7FHRhjPTSLvTVCFPXLvsmAZWeTH3h4wbZQLFj9Z8yFAVSUqC2MeWjsKWH5pHNwNXjwhLu5T",
    label: "convert usdc_to_sol",
    expect: { kind: "convert", direction: "usdc_to_sol", router: "dflow", user: "8KUt1tvSxwQ9c7uWod8pkbboG2g2kAAyXGtgCSfsndMU", usdcRaw: "67245018", lamports: "557425679" },
  },
  {
    sig: "3v41JNt8H4sUFrdFv9hSmm6oBokxp8ebw6vcpeWvopB8Zj1wFM6H4X7YbzrZ5QAfV42mLZriZGB9AwPR6MLEciew",
    label: "xchain 1,500 USDC (Relay deposit)",
    expect: { kind: "xchain", user: "CpKuhcFHogvrq7Fx3enu57xTRkh1WyzER1TVVBimC5mo", usdcRaw: "1500000000" },
  },
  {
    sig: "3Br9ghWtYfq1Yg5AajuQQFH3mfxkoF18mh8METZhwwn9RkB4nfXGiFdn36VFPqcwUgqBa7tLHonuZsQ4w3M5N17a",
    label: "xchain 28.82 USDC",
    expect: { kind: "xchain", user: "BAS9JDmjte32ZSPZJKXcpexdoY54H5yyevZACjKf2bcs", usdcRaw: "28824825" },
  },
  {
    sig: "q5tNbFWdV5oerqEcgAQaLjTa1p2yH6SrL5Cc1iC58VRna4AN1pzKUa1NsBpRoE2NPo6rctEALZyxADCt3jkHUX1",
    label: "not_fomo fee_payer (self-paid copycat reusing the marker)",
    expect: { kind: "not_fomo", reason: "fee_payer" },
  },
  {
    sig: "2NihzoUogfL3MiKq9nT861gtEot4VuXXDHSduTZvguD5Nm2MBtcEdHCSHmm1ZMwkjdVS5jpbpZJDigZud5jSt9hD",
    label: "not_fomo fee_payer (Squads fee sweep)",
    expect: { kind: "not_fomo", reason: "fee_payer" },
  },
  {
    sig: "5Czr5XDGCo7rFsvkosM5q5aQr21G9f7yBSQnQ2x19neG2dUPjzfg3ordinbvACprA3bZnZJKS5zRf4coqScsQvpL",
    label: "not_fomo no_marker (withdrawal + fee)",
    expect: { kind: "not_fomo", reason: "no_marker" },
  },
  {
    sig: "54KoQECsLuA6m7LB7r3yX6exJxim1ZaCpteybAymujpELu5j6C9DeWYDKjEwR7u8KzLwsd9DaLxTRMZjx9ffwiKc",
    label: "not_fomo no_marker (token send)",
    expect: { kind: "not_fomo", reason: "no_marker" },
  },
  {
    sig: "5r88EeqNkbryiiJF4Z9UXvaTdriDMHYZeNMi8nNgR72hiq3RKJ5bnibkc4ssZ7Fo1b2cJP6GJThMF2wL68AqvVgT",
    label: "not_fomo no_marker (pre-2026-01-06 trade: documents the limit)",
    expect: { kind: "not_fomo", reason: "no_marker" },
  },
  {
    sig: "4em96ZVVf3oNqYTgB4qx1QR2U6uJ3dtRvXJz8YxVAGB3x5JpNHDPudrXM52wzH5djp31NbCX1drNBiyLS4KuQrN6",
    label: "not_fomo failed",
    expect: { kind: "not_fomo", reason: "failed" },
  },
  {
    sig: "4pKAEmV2b4QmWBbF5pQar3R9PGFNgdRi2KqYJrBdzCQHmxvo1U7WHNUVYtMyrpuDzDdcpMBToZ7oSpC4vKTcG3cE",
    label: "not_fomo multi_token (1,000 USDC bought two tokens)",
    expect: { kind: "not_fomo", reason: "multi_token" },
  },
  {
    sig: "4XuTyipsZE9SQPAF2njDcS8Rz8XsjCmmJnTDv7npeF9UPXay66pNQkpNbozpB6BmLVZkUzsZbwR7UnhBSKQvFn8x",
    label: "not_fomo no_token_leg (FOMO USDT→USDC stable conversion is not a token trade)",
    expect: { kind: "not_fomo", reason: "no_token_leg" },
  },
];

/** Comparable plain object (bigints as strings). */
function plain(c: FomoClass): Record<string, unknown> {
  return Object.fromEntries(Object.entries(c).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v]));
}

test("21 fixtures from design §2.6 (+1 stablecoin-conversion fixture) are all present", () => {
  assert.equal(CASES.length, 22);
  assert.equal(new Set(CASES.map((c) => c.sig)).size, 22);
});

for (const c of CASES) {
  test(`rule R: ${c.label} (${c.sig.slice(0, 10)})`, () => {
    const raw = load(c.sig);
    const tx = mini(raw);
    assert.equal(tx.signature, c.sig);
    assert.equal(tx.slot, raw.slot);
    assert.equal(tx.blockTimeMs, raw.blockTime * 1000);
    assert.deepEqual(plain(classifyFomoTx(tx)), c.expect);
  });
}

test("the trader filter: matching wallet keeps the class, any other wallet → other_user", () => {
  for (const c of CASES) {
    if (c.expect.kind === "not_fomo") continue;
    const tx = mini(load(c.sig));
    assert.deepEqual(plain(classifyFomoTx(tx, c.expect.user)), c.expect, c.sig);
    assert.deepEqual(classifyFomoTx(tx, FOMO_RELAYER), { kind: "not_fomo", reason: "other_user" }, c.sig);
  }
});

test("the marker is found among lookup-table keys (never whitelist tables)", () => {
  const raw = load(CASES[0]!.sig);
  const marker = raw.transaction.message.accountKeys.find((k) => k.pubkey === FOMO_MARKER);
  assert.equal(marker?.source, "lookupTable");
  // Dropping the lookup-table keys (and their balances) hides the marker → not a trade.
  const staticIdx = raw.transaction.message.accountKeys.map((k, i) => (k.source === "lookupTable" ? -1 : i)).filter((i) => i >= 0);
  const pick = <T>(arr: T[]) => staticIdx.map((i) => arr[i]!);
  const trimmed = {
    ...raw,
    transaction: { ...raw.transaction, message: { ...raw.transaction.message, accountKeys: pick(raw.transaction.message.accountKeys) } },
    meta: {
      ...raw.meta,
      preBalances: pick(raw.meta.preBalances as number[]),
      postBalances: pick(raw.meta.postBalances as number[]),
      preTokenBalances: [],
      postTokenBalances: [],
    },
  };
  assert.deepEqual(classifyFomoTx(mini(trimmed)), { kind: "not_fomo", reason: "no_marker" });
});

test("a pre-marker FOMO trade is before FOMO_MARKER_SINCE (never backfill earlier)", () => {
  const raw = load("5r88EeqNkbryiiJF4Z9UXvaTdriDMHYZeNMi8nNgR72hiq3RKJ5bnibkc4ssZ7Fo1b2cJP6GJThMF2wL68AqvVgT");
  assert.ok(raw.blockTime * 1000 < FOMO_MARKER_SINCE);
  const legacy = load("2dsK8RtBnPxvnWEtRboUXrDQLWhSwABai7WJrpJyT3hNMA6dMXD1yRPqQxwkMAtQzo5PnnZDqa2QpfAFyagbxm7Z");
  assert.ok(legacy.blockTime * 1000 >= FOMO_MARKER_SINCE);
});

// ── Payload shapes (§2.2) ───────────────────────────────────────────────────────────────────────────

const TRADE_SIG = CASES[1]!.sig; // GoatANe… buy
const XCHAIN_SIG = CASES[12]!.sig; // 3v41JN… xchain

function sameClass(raw: unknown, sig: string) {
  const expected = CASES.find((c) => c.sig === sig)!.expect;
  const tx = mini(raw);
  assert.equal(tx.signature, sig);
  assert.deepEqual(plain(classifyFomoTx(tx)), expected);
  return tx;
}

test("normalizeTx: JSON-RPC envelope {result}", () => {
  sameClass({ jsonrpc: "2.0", id: 1, result: load(TRADE_SIG) }, TRADE_SIG);
});

test("normalizeTx: transactionSubscribe notification, full details (no blockTime)", () => {
  for (const sig of [TRADE_SIG, XCHAIN_SIG]) {
    const raw = load(sig);
    const note = {
      jsonrpc: "2.0",
      method: "transactionNotification",
      params: {
        subscription: 1,
        result: {
          slot: raw.slot,
          signature: sig,
          transaction: { transaction: raw.transaction, meta: raw.meta, version: raw.version },
          transactionIndex: raw.transactionIndex,
        },
      },
    };
    const tx = sameClass(note, sig);
    assert.equal(tx.blockTimeMs, null);
    assert.equal(tx.txIndex, raw.transactionIndex ?? null);
    sameClass(note.params.result, sig); // params.result alone
  }
});

test("normalizeTx: transactionSubscribe 'accounts' details (transaction.transaction.accountKeys)", () => {
  const raw = load(TRADE_SIG);
  const accountKeys = raw.transaction.message.accountKeys;
  const result = {
    slot: raw.slot,
    signature: TRADE_SIG,
    transaction: { transaction: { signatures: raw.transaction.signatures, accountKeys }, meta: raw.meta, version: raw.version },
    transactionIndex: raw.transactionIndex,
  };
  sameClass(result, TRADE_SIG);
});

test("normalizeTx: web3.js ParsedTransactionWithMeta (PublicKey objects)", () => {
  const raw = load(TRADE_SIG);
  const asPk = (s: string) => ({ toBase58: () => s, toString: () => s });
  const web3 = {
    ...raw,
    transaction: {
      ...raw.transaction,
      message: { ...raw.transaction.message, accountKeys: raw.transaction.message.accountKeys.map((k) => ({ ...k, pubkey: asPk(k.pubkey) })) },
    },
  };
  sameClass(web3, TRADE_SIG);
});

test("normalizeTx: encoding 'json' (string keys + header + meta.loadedAddresses)", () => {
  const raw = load(TRADE_SIG);
  const keys = raw.transaction.message.accountKeys;
  const statics = keys.filter((k) => k.source !== "lookupTable");
  const loadedW = keys.filter((k) => k.source === "lookupTable" && k.writable).map((k) => k.pubkey);
  const loadedR = keys.filter((k) => k.source === "lookupTable" && !k.writable).map((k) => k.pubkey);
  // jsonParsed order is static, loaded writable, loaded readonly — the same order "json" balances use.
  assert.deepEqual([...statics.map((k) => k.pubkey), ...loadedW, ...loadedR], keys.map((k) => k.pubkey));
  const json = {
    ...raw,
    transaction: {
      signatures: raw.transaction.signatures,
      message: { header: { numRequiredSignatures: statics.filter((k) => k.signer).length }, accountKeys: statics.map((k) => k.pubkey) },
    },
    meta: { ...raw.meta, loadedAddresses: { writable: loadedW, readonly: loadedR } },
  };
  sameClass(json, TRADE_SIG);
});

test("normalizeTx rejects unusable payloads", () => {
  const raw = load(TRADE_SIG);
  assert.equal(normalizeTx(null), null);
  assert.equal(normalizeTx({}), null);
  assert.equal(normalizeTx({ ...raw, meta: null }), null);
  assert.equal(normalizeTx({ ...raw, meta: { ...raw.meta, preBalances: (raw.meta.preBalances as number[]).slice(1) } }), null);
  const badTok = [{ accountIndex: 1, mint: USDC_MINT, owner: "x", uiTokenAmount: { amount: "1.5", decimals: 6 } }];
  assert.equal(normalizeTx({ ...raw, meta: { ...raw.meta, preTokenBalances: badTok } }), null);
});

// ── Pre-filter, fingerprint, row mapping ────────────────────────────────────────────────────────────

test("logsLookLikeFomoCandidate: router or Relay invocations only", () => {
  for (const c of CASES) {
    const raw = load(c.sig);
    const logs = raw.meta.logMessages ?? [];
    if (c.expect.kind === "trade" || c.expect.kind === "convert" || c.expect.kind === "xchain") {
      assert.equal(logsLookLikeFomoCandidate(logs), true, c.sig);
    }
  }
  // Plain token send and the Squads sweep never invoke a router.
  assert.equal(logsLookLikeFomoCandidate(load(CASES[17]!.sig).meta.logMessages), false);
  assert.equal(logsLookLikeFomoCandidate(load(CASES[15]!.sig).meta.logMessages), false);
  assert.equal(logsLookLikeFomoCandidate([]), false);
  assert.equal(logsLookLikeFomoCandidate(null), false);
  assert.equal(logsLookLikeFomoCandidate(["Program log: DF1ow4tspfHX9JwWJsAb9epbkA8hmpSEAtxXy1V27QBH invoke [1]"]), false);
  assert.equal(logsLookLikeFomoCandidate(["Program JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4 invoke [2]"]), true);
});

test("hasFomoFingerprint: relayer-paid, 2 signers, marker present", () => {
  assert.equal(hasFomoFingerprint(mini(load(TRADE_SIG))), true);
  assert.equal(hasFomoFingerprint(mini(load(CASES[14]!.sig))), false); // self-paid copycat
  assert.equal(hasFomoFingerprint(mini(load(XCHAIN_SIG))), false); // Relay deposit: no marker
});

test("isUnmarkedFomoSwap (drift counter): swap-shaped relayer tx without the marker", () => {
  assert.equal(isUnmarkedFomoSwap(mini(load(CASES[18]!.sig))), true); // pre-2026-01-06 FOMO trade
  assert.equal(isUnmarkedFomoSwap(mini(load(CASES[16]!.sig))), false); // withdrawal + fee
  assert.equal(isUnmarkedFomoSwap(mini(load(CASES[17]!.sig))), false); // token send
  assert.equal(isUnmarkedFomoSwap(mini(load(TRADE_SIG))), false); // marked trade
  assert.equal(isUnmarkedFomoSwap(mini(load(XCHAIN_SIG))), false); // Relay deposit
  assert.equal(isUnmarkedFomoSwap(mini(load(CASES[14]!.sig))), false); // self-paid copycat
});

test("toFomoSwapRow maps trades, conversions and cross-chain orders", () => {
  const buyTx = mini(load(TRADE_SIG));
  const buy = toFomoSwapRow(buyTx, classifyFomoTx(buyTx), "backfill");
  assert.deepEqual(buy, {
    signature: TRADE_SIG,
    wallet: BEQV,
    slot: buyTx.slot,
    txIndex: buyTx.txIndex,
    blockTime: new Date(buyTx.blockTimeMs!),
    solUsd: null,
    source: "backfill",
    kind: "buy",
    mint: "6GmAFSYs4gk3FDao5FzzySQpPZaWsa4rUJHacpMpUNgx",
    tokenRaw: "57659698541",
    decimals: 9,
    usd: 15.67143,
    router: "dflow",
    direction: null,
  });

  const convTx = mini(load(CASES[9]!.sig));
  const conv = toFomoSwapRow(convTx, classifyFomoTx(convTx), "stream", { solUsd: 120 });
  assert.equal(conv?.kind, "convert");
  assert.equal(conv?.mint, SOL_MINT);
  assert.equal(conv?.tokenRaw, "414559323");
  assert.equal(conv?.decimals, 9);
  assert.equal(conv?.direction, "sol_to_usdc");
  assert.equal(conv?.solUsd, 120);

  const xTx = mini(load(XCHAIN_SIG));
  const x = toFomoSwapRow(xTx, classifyFomoTx(xTx), "watcher");
  assert.equal(x?.kind, "xchain");
  assert.equal(x?.mint, USDC_MINT);
  assert.equal(x?.usd, 1500);
  assert.equal(x?.router, "relay");

  // transactionSubscribe payloads have no blockTime → receive time.
  const noTime = { ...buyTx, blockTimeMs: null };
  assert.equal(toFomoSwapRow(noTime, classifyFomoTx(noTime), "stream", { receivedAtMs: 1_790_000_000_000 })?.blockTime.getTime(), 1_790_000_000_000);

  const failed = mini(load(CASES[19]!.sig));
  assert.equal(toFomoSwapRow(failed, classifyFomoTx(failed), "stream"), null);
});
