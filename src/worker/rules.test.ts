// Run: npx tsx --test src/worker/rules.test.ts
// Pure engine rules behind the money-path fixes: stale sells still copied (F20), sell retry backoff / slippage (F6),
// copy-buy price sanity (F22), PumpPortal order sizing under the cap (F8), seal-key pairing (F12), agent signer (F45).
import "@/lib/__testing__/env"; // first: keeps the real .env (keys, RPC URLs) out of this test
import { before, test } from "node:test";
import assert from "node:assert/strict";
import { verify } from "node:crypto";
import { Keypair } from "@solana/web3.js";
import { testSealKeys } from "./testkit";

process.env.DATABASE_URL = "file:./__rules_test_no_such_dir__/none.db";
// A throwaway seal pair for the worker-side key tests (config reads it when ./wallet is imported below).
const SEAL = testSealKeys();
process.env.WALLET_SEAL_PRIVATE_KEY = SEAL.privateKey;
process.env.WALLET_SEAL_PUBLIC_KEY = SEAL.publicKey;

let watcher: typeof import("./watcher");
let retry: typeof import("./sellretry");
let swap: typeof import("./swap");
let sealcheck: typeof import("./sealcheck");
let wallet: typeof import("./wallet");

before(async () => {
  watcher = await import("./watcher");
  retry = await import("./sellretry");
  swap = await import("./swap");
  sealcheck = await import("./sealcheck");
  wallet = await import("./wallet");
});

test("F20: stale buys are dropped, stale sells are still copied (up to MAX_SELL_AGE_MS)", () => {
  const maxEventAgeMs = 90_000;
  assert.equal(watcher.ageVerdict({ ageMs: 120_000, side: "buy", maxEventAgeMs }), "drop");
  assert.equal(watcher.ageVerdict({ ageMs: 60_000, side: "buy", maxEventAgeMs }), "ok");
  assert.equal(watcher.ageVerdict({ ageMs: 120_000, side: "sell", maxEventAgeMs }), "ok");
  assert.equal(watcher.ageVerdict({ ageMs: watcher.MAX_SELL_AGE_MS + 1, side: "sell", maxEventAgeMs }), "drop");
  // Before the tx is fetched the side is unknown: only older-than-any-sell is dropped.
  assert.equal(watcher.ageVerdict({ ageMs: 120_000, side: null, maxEventAgeMs }), "ok");
  assert.equal(watcher.ageVerdict({ ageMs: watcher.MAX_SELL_AGE_MS + 1, side: null, maxEventAgeMs }), "drop");
});

test("F6: retry backoff grows to a cap; slippage doubles per attempt up to max(own, 2500)", () => {
  assert.deepEqual([1, 2, 3, 4, 5, 9].map(retry.retryDelayMs), [5_000, 10_000, 20_000, 40_000, 60_000, 60_000]);
  assert.deepEqual([0, 1, 2, 3, 4].map((n) => retry.retrySlippageBps(300, n)), [300, 600, 1_200, 2_400, 2_500]);
  assert.equal(retry.retrySlippageBps(4_000, 3), 4_000, "never below the agent's own setting");
  assert.equal(retry.isRetryable(new swap.TradeError("quote failed", null, true)), true);
  assert.equal(retry.isRetryable(new swap.InFlightError("sent", "sig")), false, "an open send is never retried blindly");
  assert.equal(retry.isRetryable(new swap.TradeError("swap landed but no tokens arrived", "sig")), false);
});

test("F22: copy-buy price sanity against the trader's fill and the quote's price impact", () => {
  const ref = { tokenRaw: BigInt(1_000_000), lamports: BigInt(100_000_000) }; // trader: 0.01 token/lamport
  assert.equal(swap.buyPriceSkipReason(BigInt(900_000), BigInt(100_000_000), ref), null); // 10% worse: fine
  assert.match(swap.buyPriceSkipReason(BigInt(500_000), BigInt(100_000_000), ref) ?? "", /50% worse/);
  assert.match(swap.buyPriceSkipReason(BigInt(900_000), BigInt(100_000_000), ref, "0.35") ?? "", /impact 35\.0%/);
  assert.equal(swap.buyPriceSkipReason(BigInt(1), BigInt(100_000_000), null, "0.01"), null, "no reference: impact only");
});

test("F8: a PumpPortal order's worst-case cost (size × (1 + slippage) + its fee) stays within the budget", () => {
  for (const slippageBps of [300, 1_000, 5_000]) {
    const budget = BigInt(1_000_000_000);
    const order = swap.pumpPortalOrderSol(budget, slippageBps);
    const worst = order * (1 + slippageBps / 10_000 + 0.01) * 1e9;
    assert.ok(worst <= Number(budget), `${slippageBps}: ${worst}`);
    assert.ok(worst > Number(budget) * 0.999);
  }
});

test("F12: the worker derives the seal public key that pairs with its private key", () => {
  const pair = testSealKeys();
  assert.equal(sealcheck.sealPublicKeyFromPrivate(pair.privateKey), pair.publicKey);
  assert.ok(sealcheck.sameSealKey(pair.publicKey, Buffer.from(pair.publicKey, "base64").toString("base64url")));
  assert.equal(sealcheck.sameSealKey(pair.publicKey, testSealKeys().publicKey), false);
  assert.equal(sealcheck.sealPublicKeyFromPrivate("not a key"), null);
});

test("F45: the agent signer signs with the key and refuses an inconsistent secret", () => {
  const kp = Keypair.generate();
  const signer = wallet.signerFromSecret(kp.secretKey);
  assert.equal(signer.address, kp.publicKey.toBase58());
  const msg = new TextEncoder().encode("hello");
  const sig = signer.sign(msg);
  const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), kp.publicKey.toBuffer()]);
  assert.ok(verify(null, msg, { key: spki, format: "der", type: "spki" }, Buffer.from(sig)));
  const tampered = Uint8Array.from(kp.secretKey);
  tampered.set(Keypair.generate().publicKey.toBytes(), 32);
  assert.throws(() => wallet.signerFromSecret(tampered), /inconsistent/);
});

test("F23: PumpPortal priority fee scales with the trade (buys bps, sells twice), floor and caps", () => {
  const opts = { maxLamports: 2_000_000, bps: 500, floorLamports: 50_000 };
  assert.equal(swap.pumpPriorityLamports(BigInt(10_000_000), "buy", opts), 500_000); // 0.01 SOL × 5% = 500k lamports
  assert.equal(swap.pumpPriorityLamports(BigInt(2_000_000), "buy", opts), 100_000); // 0.002 SOL × 5%
  assert.equal(swap.pumpPriorityLamports(BigInt(200_000), "buy", opts), 50_000, "never below the floor");
  assert.equal(swap.pumpPriorityLamports(BigInt(2_000_000), "sell", opts), 200_000, "sells get twice the share");
  assert.equal(swap.pumpPriorityLamports(BigInt(5_000_000_000), "buy", opts), 500_000, "never above PumpPortal's 500k");
  assert.equal(swap.pumpPriorityLamports(BigInt(5_000_000_000), "buy", { ...opts, maxLamports: 100_000 }), 100_000, "never above MAX_PRIORITY_FEE_LAMPORTS");
  assert.equal(swap.pumpPriorityLamports(null, "sell", opts), 500_000, "unknown size: the cap");
});

test("F10: the worker opens v2 (owner-bound) keys only with the agent's own owner wallet", async () => {
  const { sealSecret, agentSealAad } = await import("@/lib/crypto");
  const kp = Keypair.generate();
  const owner = Keypair.generate().publicKey.toBase58();
  const depositAddress = kp.publicKey.toBase58();
  const sealed = sealSecret(kp.secretKey, SEAL.publicKey, agentSealAad(depositAddress, owner));
  const addr = await wallet.withAgentSigner({ sealedSecret: sealed, depositAddress, ownerWallet: owner }, async (s) => s.address);
  assert.equal(addr, depositAddress);
  await assert.rejects(
    wallet.withAgentSigner({ sealedSecret: sealed, depositAddress, ownerWallet: Keypair.generate().publicKey.toBase58() }, async () => "x"),
    /authentication failed/,
    "a rewritten owner wallet can't open the key",
  );
  await assert.rejects(wallet.withAgentSigner({ sealedSecret: sealed, depositAddress, ownerWallet: null }, async () => "x"), /bound to an owner wallet/);
});
