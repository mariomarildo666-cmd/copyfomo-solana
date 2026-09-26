// Run: npx tsx --test src/worker/parser.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Keypair, PublicKey, type ParsedTransactionWithMeta, type TokenBalance, type TransactionError } from "@solana/web3.js";
import { classifyFomoTx } from "@/lib/fomo-chain";
import { SOL_MINT, USDC_MINT } from "@/lib/solana";
import { venueOf } from "./copyrules";
import { analyzeSwap, parseSwap, toSwapTx, type SwapTx } from "./parser";

const LAMPORTS = 1_000_000_000;
const WALLET = Keypair.generate().publicKey.toBase58();
const RELAYER = Keypair.generate().publicKey.toBase58();
const POOL = Keypair.generate().publicKey.toBase58();
const MINT = "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr"; // any 32-byte base58
const MINT_PUMP = "9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump";
const FEE = 5_000;

interface Account {
  pubkey: string;
  signer?: boolean;
  pre: number;
  post: number;
}

function bal(accountIndex: number, mint: string, owner: string, amount: bigint | number, decimals = 6): TokenBalance {
  const raw = BigInt(amount);
  return {
    accountIndex,
    mint,
    owner,
    programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    uiTokenAmount: { amount: raw.toString(), decimals, uiAmount: Number(raw) / 10 ** decimals },
  };
}

function makeTx(p: {
  accounts: Account[];
  preTok?: TokenBalance[];
  postTok?: TokenBalance[];
  fee?: number;
  err?: TransactionError;
  blockTime?: number | null;
}): ParsedTransactionWithMeta {
  return {
    slot: 1,
    blockTime: p.blockTime === undefined ? 1_760_000_000 : p.blockTime,
    transaction: {
      signatures: ["sig111"],
      message: {
        accountKeys: p.accounts.map((a) => ({ pubkey: new PublicKey(a.pubkey), signer: a.signer ?? false, writable: true })),
        instructions: [],
        recentBlockhash: "11111111111111111111111111111111",
      },
    },
    meta: {
      fee: p.fee ?? FEE,
      err: p.err ?? null,
      preBalances: p.accounts.map((a) => a.pre),
      postBalances: p.accounts.map((a) => a.post),
      preTokenBalances: p.preTok ?? [],
      postTokenBalances: p.postTok ?? [],
    },
  };
}

/** web3.js ParsedTransactionWithMeta → the parser's normalized input. */
function sw(tx: unknown): SwapTx {
  const s = toSwapTx(tx);
  assert.ok(s, "toSwapTx returned null");
  return s;
}

test("toSwapTx: web3.js payload keeps signature, block time, signers and the fee", () => {
  const s = sw(makeTx({ fee: 7_777, accounts: [{ pubkey: WALLET, signer: true, pre: LAMPORTS, post: LAMPORTS }] }));
  assert.equal(s.signature, "sig111");
  assert.equal(s.blockTimeMs, 1_760_000_000_000);
  assert.equal(s.fee, 7_777);
  assert.deepEqual(s.keys, [{ pubkey: WALLET, signer: true }]);
  // meta null → not a usable transaction
  assert.equal(toSwapTx({ ...makeTx({ accounts: [{ pubkey: WALLET, signer: true, pre: 1, post: 1 }] }), meta: null }), null);
});

test("pump.fun-style buy: lamports out, token in (wallet pays fee)", () => {
  const spent = 0.5 * LAMPORTS;
  const tx = makeTx({
    accounts: [
      { pubkey: WALLET, signer: true, pre: 2 * LAMPORTS, post: 2 * LAMPORTS - spent - FEE },
      { pubkey: POOL, pre: 10 * LAMPORTS, post: 10 * LAMPORTS + spent },
    ],
    preTok: [],
    postTok: [bal(2, MINT_PUMP, WALLET, 1_000_000_000_000)],
  });
  const s = parseSwap(sw(tx), WALLET, null);
  assert.ok(s);
  assert.equal(s.side, "buy");
  assert.equal(s.mint, MINT_PUMP);
  assert.equal(s.tokenRaw, BigInt(1_000_000_000_000));
  assert.equal(s.decimals, 6);
  assert.equal(s.solAmount, 0.5); // fee added back
  assert.equal(s.buyFraction, 0.25); // 0.5 of 2 SOL
  assert.equal(s.sellFraction, null);
  assert.equal(s.signature, "sig111");
  assert.equal(s.blockTimeMs, 1_760_000_000_000);
  assert.equal(s.quote, "SOL");
  assert.equal(s.usdAmount, null);
});

test("Raydium/Jupiter buy paid from an existing WSOL account", () => {
  const tx = makeTx({
    accounts: [
      { pubkey: WALLET, signer: true, pre: 1 * LAMPORTS, post: 1 * LAMPORTS - FEE },
      { pubkey: POOL, pre: 0, post: 0 },
    ],
    preTok: [bal(1, SOL_MINT, WALLET, 3 * LAMPORTS, 9), bal(1, MINT, WALLET, 500)],
    postTok: [bal(1, SOL_MINT, WALLET, 2 * LAMPORTS, 9), bal(1, MINT, WALLET, 1500)],
  });
  const s = parseSwap(sw(tx), WALLET, null);
  assert.ok(s);
  assert.equal(s.side, "buy");
  assert.equal(s.solAmount, 1);
  assert.equal(s.tokenRaw, BigInt(1000));
  assert.equal(s.buyFraction, 0.25); // 1 SOL of (1 native + 3 WSOL)
});

test("buy with USDC is converted to SOL at the SOL/USD price (same USD value)", () => {
  const tx = makeTx({
    accounts: [{ pubkey: WALLET, signer: true, pre: 1 * LAMPORTS, post: 1 * LAMPORTS - FEE - 2_039_280 }], // + ATA rent
    preTok: [bal(0, USDC_MINT, WALLET, 1_000_000_000)], // 1000 USDC
    postTok: [bal(0, USDC_MINT, WALLET, 800_000_000), bal(0, MINT, WALLET, 42)],
  });
  const r = analyzeSwap(sw(tx), WALLET, null);
  assert.ok("skip" in r && r.needsSolUsd, "needs a price first");
  const s = parseSwap(sw(tx), WALLET, 200);
  assert.ok(s);
  assert.equal(s.side, "buy");
  assert.equal(s.quote, "STABLE");
  assert.ok(Math.abs(s.solAmount - 1) < 1e-9, `200 USDC at $200 = 1 SOL, got ${s.solAmount}`);
  assert.ok(Math.abs((s.usdAmount ?? 0) - 200) < 1e-9);
  assert.ok(Math.abs((s.buyFraction ?? 0) - 0.2) < 1e-9);
  // Same trade, SOL at $125 → 1.6 SOL: the mirror follows the USD value, not a fixed SOL amount.
  assert.ok(Math.abs((parseSwap(sw(tx), WALLET, 125)?.solAmount ?? 0) - 1.6) < 1e-9);
});

test("a stablecoin leg without a usable SOL/USD price is skipped (never guessed)", () => {
  const tx = sw(
    makeTx({
      accounts: [{ pubkey: WALLET, signer: true, pre: LAMPORTS, post: LAMPORTS - FEE }],
      preTok: [bal(0, USDC_MINT, WALLET, 50_000_000)],
      postTok: [bal(0, USDC_MINT, WALLET, 0), bal(0, MINT, WALLET, 9)],
    }),
  );
  for (const price of [null, 0, -3, Number.NaN, Number.POSITIVE_INFINITY]) {
    const r = analyzeSwap(tx, WALLET, price);
    assert.ok("skip" in r && r.needsSolUsd === true, `price ${price}`);
  }
});

test("partial sell: fraction of the pre-tx token balance", () => {
  const tx = makeTx({
    accounts: [{ pubkey: WALLET, signer: true, pre: 1 * LAMPORTS, post: 1 * LAMPORTS + 0.3 * LAMPORTS - FEE }],
    preTok: [bal(1, MINT, WALLET, 1_000_000)],
    postTok: [bal(1, MINT, WALLET, 750_000)],
  });
  const s = parseSwap(sw(tx), WALLET, null);
  assert.ok(s);
  assert.equal(s.side, "sell");
  assert.equal(s.tokenRaw, BigInt(250_000));
  assert.equal(s.sellFraction, 0.25);
  assert.equal(s.buyFraction, null);
  assert.ok(Math.abs(s.solAmount - 0.3) < 1e-12);
});

test("full sell with the token account closed (absent from postTokenBalances)", () => {
  const rent = 2_039_280;
  const tx = makeTx({
    accounts: [{ pubkey: WALLET, signer: true, pre: 1 * LAMPORTS, post: 1 * LAMPORTS + 2 * LAMPORTS + rent - FEE }],
    preTok: [bal(0, MINT, WALLET, 777)],
    postTok: [],
  });
  const s = parseSwap(sw(tx), WALLET, null);
  assert.ok(s);
  assert.equal(s.side, "sell");
  assert.equal(s.sellFraction, 1);
  assert.equal(s.tokenRaw, BigInt(777));
});

test("failed transaction → null", () => {
  const tx = makeTx({
    accounts: [{ pubkey: WALLET, signer: true, pre: 1 * LAMPORTS, post: 1 * LAMPORTS - FEE }],
    postTok: [bal(0, MINT, WALLET, 10)],
    err: { InstructionError: [0, "Custom"] },
  });
  assert.equal(parseSwap(sw(tx), WALLET, null), null);
  const r = analyzeSwap(sw(tx), WALLET, null);
  assert.ok("skip" in r && r.skip === "failed transaction");
});

test("plain SOL transfer → null", () => {
  const tx = makeTx({
    accounts: [
      { pubkey: WALLET, signer: true, pre: 5 * LAMPORTS, post: 4 * LAMPORTS - FEE },
      { pubkey: POOL, pre: 0, post: 1 * LAMPORTS },
    ],
  });
  assert.equal(parseSwap(sw(tx), WALLET, null), null);
});

test("incoming token transfer (not signed by the wallet) → null", () => {
  const tx = makeTx({
    accounts: [
      { pubkey: RELAYER, signer: true, pre: 1 * LAMPORTS, post: 1 * LAMPORTS - FEE },
      { pubkey: WALLET, signer: false, pre: 1 * LAMPORTS, post: 1 * LAMPORTS },
    ],
    postTok: [bal(1, MINT, WALLET, 1000)],
  });
  assert.equal(parseSwap(sw(tx), WALLET, null), null);
  const r = analyzeSwap(sw(tx), WALLET, null);
  assert.ok("skip" in r && r.skip === "wallet did not sign");
});

test("token → token swap → null", () => {
  const tx = makeTx({
    accounts: [{ pubkey: WALLET, signer: true, pre: 1 * LAMPORTS, post: 1 * LAMPORTS - FEE }],
    preTok: [bal(0, MINT, WALLET, 1000), bal(0, MINT_PUMP, WALLET, 0)],
    postTok: [bal(0, MINT, WALLET, 0), bal(0, MINT_PUMP, WALLET, 5000)],
  });
  const r = analyzeSwap(sw(tx), WALLET, 150);
  assert.ok("skip" in r && /2 tokens changed/.test(r.skip));
});

test("leftover dust of a second token is tolerated (rule R's 1e-5 ratio)", () => {
  const tx = makeTx({
    accounts: [{ pubkey: WALLET, signer: true, pre: 2 * LAMPORTS, post: 1 * LAMPORTS - FEE }],
    preTok: [bal(0, MINT_PUMP, WALLET, 1_000)],
    postTok: [bal(0, MINT, WALLET, 50_000_000_000), bal(0, MINT_PUMP, WALLET, 1_010)], // 50,000 vs 0.00001
  });
  const s = parseSwap(sw(tx), WALLET, null);
  assert.ok(s);
  assert.equal(s.side, "buy");
  assert.equal(s.mint, MINT);
  assert.equal(s.tokenRaw, BigInt(50_000_000_000));
});

test("fee is added back only when the wallet is the fee payer", () => {
  const spent = 0.01 * LAMPORTS;
  // Wallet at index 0 (fee payer): lamports drop by spent + fee, SOL amount is `spent`.
  const payer = makeTx({
    fee: 100_000,
    accounts: [{ pubkey: WALLET, signer: true, pre: LAMPORTS, post: LAMPORTS - spent - 100_000 }],
    postTok: [bal(0, MINT, WALLET, 1)],
  });
  assert.equal(parseSwap(sw(payer), WALLET, null)?.solAmount, 0.01);

  // Relayer pays the fee; the wallet (signer at index 1) only loses `spent`.
  const relayed = makeTx({
    fee: 100_000,
    accounts: [
      { pubkey: RELAYER, signer: true, pre: LAMPORTS, post: LAMPORTS - 100_000 },
      { pubkey: WALLET, signer: true, pre: LAMPORTS, post: LAMPORTS - spent },
    ],
    postTok: [bal(1, MINT, WALLET, 1)],
  });
  const s = parseSwap(sw(relayed), WALLET, null);
  assert.ok(s);
  assert.equal(s.solAmount, 0.01);
  assert.equal(s.side, "buy");
});

test("dust quote legs are ignored", () => {
  const tx = makeTx({
    accounts: [{ pubkey: WALLET, signer: true, pre: LAMPORTS, post: LAMPORTS - 50_000 - FEE }], // 0.00005 SOL
    postTok: [bal(0, MINT, WALLET, 1)],
  });
  const r = analyzeSwap(sw(tx), WALLET, null);
  assert.ok("skip" in r && r.skip === "quote leg is dust");
});

test("token-2022 balances are handled like SPL tokens", () => {
  const t22 = (i: number, amount: number): TokenBalance => ({
    ...bal(i, MINT, WALLET, amount, 9),
    programId: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  });
  const tx = makeTx({
    accounts: [{ pubkey: WALLET, signer: true, pre: LAMPORTS, post: LAMPORTS - 0.2 * LAMPORTS - FEE }],
    preTok: [t22(0, 1_000)],
    postTok: [t22(0, 3_000)],
  });
  const s = parseSwap(sw(tx), WALLET, null);
  assert.ok(s);
  assert.equal(s.decimals, 9);
  assert.equal(s.tokenRaw, BigInt(2_000));
});

test("wallet absent from the transaction → null; missing blockTime → null blockTimeMs", () => {
  const tx = makeTx({
    blockTime: null,
    accounts: [{ pubkey: RELAYER, signer: true, pre: LAMPORTS, post: LAMPORTS - FEE }],
  });
  assert.equal(parseSwap(sw(tx), WALLET, null), null);

  const buy = makeTx({
    blockTime: null,
    accounts: [{ pubkey: WALLET, signer: true, pre: LAMPORTS, post: LAMPORTS / 2 - FEE }],
    postTok: [bal(0, MINT, WALLET, 5)],
  });
  assert.equal(parseSwap(sw(buy), WALLET, null)?.blockTimeMs, null);
});

test("mixed SOL and stablecoin legs are ambiguous → null", () => {
  const tx = makeTx({
    accounts: [{ pubkey: WALLET, signer: true, pre: 2 * LAMPORTS, post: 1 * LAMPORTS - FEE }],
    preTok: [bal(0, USDC_MINT, WALLET, 500_000_000)],
    postTok: [bal(0, USDC_MINT, WALLET, 300_000_000), bal(0, MINT, WALLET, 10)],
  });
  const r = analyzeSwap(sw(tx), WALLET, 200);
  assert.ok("skip" in r && r.skip === "mixed SOL and stablecoin legs");
});

test("a small SOL refund next to a large USDC buy is not ambiguous (USDC is the quote)", () => {
  // Mainnet 3G8LV9…: $10,000 USDC FOMO buy that also returned 0.037 SOL of rent to the trader.
  const tx = makeTx({
    accounts: [
      { pubkey: RELAYER, signer: true, pre: LAMPORTS, post: LAMPORTS - FEE },
      { pubkey: WALLET, signer: true, pre: LAMPORTS, post: LAMPORTS + 37_193_166 },
    ],
    preTok: [bal(1, USDC_MINT, WALLET, 10_000_000_000)],
    postTok: [bal(1, USDC_MINT, WALLET, 0), bal(1, MINT, WALLET, 492_714_054_989)],
  });
  const s = parseSwap(sw(tx), WALLET, 200);
  assert.ok(s);
  assert.equal(s.side, "buy");
  assert.equal(s.quote, "STABLE");
  assert.ok(Math.abs(s.solAmount - 50) < 1e-9);
});

// ── Verified mainnet FOMO fixtures (src/lib/__fixtures__/fomo, design §2.6) ───────────────────────────────

const FIXTURE_DIR = path.join(__dirname, "..", "lib", "__fixtures__", "fomo");
type Raw = {
  slot: number;
  blockTime: number;
  transaction: { signatures: string[]; message: { accountKeys: unknown[] } };
  meta: Record<string, unknown>;
};
const load = (sig: string): Raw => JSON.parse(readFileSync(path.join(FIXTURE_DIR, `${sig}.json`), "utf8")) as Raw;

/** The same transaction as a Helius transactionSubscribe "accounts" notification (no blockTime). */
function asStreamNotification(raw: Raw): unknown {
  const m = raw.meta;
  return {
    jsonrpc: "2.0",
    method: "transactionNotification",
    params: {
      subscription: 1,
      result: {
        slot: raw.slot,
        signature: raw.transaction.signatures[0],
        transactionIndex: 3,
        transaction: {
          transaction: { signatures: raw.transaction.signatures, accountKeys: raw.transaction.message.accountKeys },
          meta: {
            err: m.err,
            fee: m.fee,
            preBalances: m.preBalances,
            postBalances: m.postBalances,
            preTokenBalances: m.preTokenBalances,
            postTokenBalances: m.postTokenBalances,
          },
          version: 0,
        },
      },
    },
  };
}

const SOL_USD = 200;
const FOMO_TRADES = [
  "j9bBAkSYECTUYdF67adCeeSfWBKUYPdTsAZ6n1UwvhVZuMXj9SAu6WaKkJNR8vJH5Xv97nipPh8pws32bTM9WKZ", // sell, dflow
  "GoatANeFK8BEG3kvkhxC8f9uZFj5f1UXRNzdzdbvQE7cXwxDaZ9FDWsn27bmJMXYiBGY2xx8ZwxVNiwcXfrfgbX", // buy, dflow
  "63szuHVMLm15dYbKCBoSkcjFHTGUknUAdLhyoVMAB85kF8em9DrdqMUkQpaJPdjUUZd2zYdPJ3bGTCmSAi92k8Lu", // buy, jupiter
  "2txvKPu4pK5munkQtkKVhHwP2rPPoZAbi5xLLjKHFV2GUkiDKMWfaLJrdek5QjSo6qb74dhPaGmLwFccK6DYwHCn", // sell, jupiter
  "5Qc75eARmBNy1JcEs7hhKrRjeffWdCG4oCXG5GhsPKzyj7pnHP7Tqb8CNJvwkWupH8BxjdGU5iWPgkPjHR5WQTGR", // sell, okx
  "5Mh5bDV9m7ZVPzqE5koxvwE8zJsgf2Uq6cFPJbS14c4MbfDc7Fhy8pKwEsxNJZq6EVBxVirGmHJXkT9K8Ru6tHxA", // buy, okx
  "2ZGbCbph1etfvnPu3oa3QpWUzhTyXA3wrou7ETm2vgcPJbd1agBpQwb1ES6AmZUbSCkAFQERnoWVs2r4zFXgwC4m", // buy
  "2tGxcY8TbnyRmALTin5GKShbkVwfyQRmP3bdExH2eCq3DpmPxS11cfUUnw97g5q3L3KUpeusFRFJaaw4HpPjratF", // buy + dust
  "2dsK8RtBnPxvnWEtRboUXrDQLWhSwABai7WJrpJyT3hNMA6dMXD1yRPqQxwkMAtQzo5PnnZDqa2QpfAFyagbxm7Z", // buy, fomo_legacy
];

for (const sig of FOMO_TRADES) {
  test(`FOMO trade ${sig.slice(0, 8)}: parser agrees with rule R, USD→SOL mirror, venue "fomo"`, () => {
    const raw = load(sig);
    for (const [shape, payload] of [
      ["getTransaction", raw],
      ["transactionSubscribe", asStreamNotification(raw)],
    ] as const) {
      const tx = sw(payload);
      const cls = classifyFomoTx(tx);
      assert.equal(cls.kind, "trade", shape);
      if (cls.kind !== "trade") return;
      const s = parseSwap(tx, cls.user, SOL_USD);
      assert.ok(s, `${shape}: parser found no swap`);
      assert.equal(s.side, cls.side, shape);
      assert.equal(s.mint, cls.mint, shape);
      assert.equal(s.tokenRaw, cls.tokenRaw, shape);
      assert.equal(s.quote, "STABLE", shape);
      const usd = Number(cls.usdcRaw) / 1e6;
      assert.ok(Math.abs((s.usdAmount ?? 0) - usd) < 1e-9, shape);
      assert.ok(Math.abs(s.solAmount - usd / SOL_USD) < 1e-12, `${shape}: ${s.solAmount} vs ${usd / SOL_USD}`);
      if (s.side === "sell") assert.ok(s.sellFraction !== null && s.sellFraction > 0 && s.sellFraction <= 1);
      else assert.ok(s.buyFraction !== null && s.buyFraction > 0 && s.buyFraction <= 1);
      assert.equal(venueOf(classifyFomoTx(tx, cls.user), s), "fomo", shape);
      assert.equal(s.blockTimeMs, shape === "getTransaction" ? raw.blockTime * 1000 : null);
    }
  });
}

test("FOMO conversions and cross-chain orders never become copyable swaps", () => {
  for (const sig of [
    "2xqnNYnC5jg299t6RSDCxpBkTabbnqZ47pej2N9RjEfYJN6bDCJGmh45jwHJs2RutsF8xhWdvvhNzWD2XSP8uMxm", // convert sol_to_usdc
    "5jAudDj4Jpy4hbtWifE7LEKJZ81noYrvTi8QGP5iz628z4f2HouxuxcMVHBJJcb6X7DeyHvXEcRehZi1KYAXee4X", // convert usdc_to_sol
    "2Y2QWbuGC2VQh1J6a7FHRhjPTSLvTVCFPXLvsmAZWeTH3h4wbZQLFj9Z8yFAVSUqC2MeWjsKWH5pHNwNXjwhLu5T", // convert usdc_to_sol
    "3v41JNt8H4sUFrdFv9hSmm6oBokxp8ebw6vcpeWvopB8Zj1wFM6H4X7YbzrZ5QAfV42mLZriZGB9AwPR6MLEciew", // xchain
    "3Br9ghWtYfq1Yg5AajuQQFH3mfxkoF18mh8METZhwwn9RkB4nfXGiFdn36VFPqcwUgqBa7tLHonuZsQ4w3M5N17a", // xchain
  ]) {
    const tx = sw(load(sig));
    const cls = classifyFomoTx(tx);
    assert.ok(cls.kind === "convert" || cls.kind === "xchain", sig);
    const r = analyzeSwap(tx, cls.user, SOL_USD);
    assert.ok("skip" in r && r.skip === "no token balance change", `${sig.slice(0, 8)}: ${"skip" in r ? r.skip : "swap!"}`);
  }
});

test("1,000 USDC into two tokens (rule R multi_token) is not copyable", () => {
  const tx = sw(load("4pKAEmV2b4QmWBbF5pQar3R9PGFNgdRi2KqYJrBdzCQHmxvo1U7WHNUVYtMyrpuDzDdcpMBToZ7oSpC4vKTcG3cE"));
  const trader = tx.keys.filter((k) => k.signer)[1]!.pubkey;
  const r = analyzeSwap(tx, trader, SOL_USD);
  assert.ok("skip" in r && /tokens changed/.test(r.skip));
});

test("a self-paid bot reusing FOMO's marker is venue \"other\"", () => {
  const tx = sw(load("q5tNbFWdV5oerqEcgAQaLjTa1p2yH6SrL5Cc1iC58VRna4AN1pzKUa1NsBpRoE2NPo6rctEALZyxADCt3jkHUX1"));
  const bot = tx.keys[0]!.pubkey;
  const s = parseSwap(tx, bot, SOL_USD);
  if (s) assert.equal(venueOf(classifyFomoTx(tx, bot), s), "other");
  assert.equal(classifyFomoTx(tx, bot).kind, "not_fomo");
});
