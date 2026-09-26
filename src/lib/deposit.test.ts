// Run: npx tsx --test src/lib/deposit.test.ts
// The deposit relay must only ever broadcast EXACTLY "owner → agent deposit address, N lamports, signed by the
// owner". No network: blockhashes are made up, getLatestBlockhash is stubbed for buildDepositTx.
import "./__testing__/env"; // first: keeps the real .env (keys, RPC URLs) out of this test
import { before, test } from "node:test";
import assert from "node:assert/strict";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type TransactionInstruction as Ix,
} from "@solana/web3.js";

// Never touch a real database from this file.
process.env.DATABASE_URL = "file:./__deposit_test_no_such_dir__/none.db";

type Deposit = typeof import("./deposit");
let d: Deposit;
let HttpError: typeof import("./http").HttpError;

before(async () => {
  d = await import("./deposit");
  ({ HttpError } = await import("./http"));
});

const owner = Keypair.generate();
const agentWallet = Keypair.generate().publicKey;
const attacker = Keypair.generate();
const BLOCKHASH = "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N";
const LAMPORTS = BigInt(1_500_000_000);

const expected = () => ({ from: owner.publicKey.toBase58(), to: agentWallet.toBase58(), lamports: LAMPORTS });

function v0(payer: PublicKey, instructions: Ix[], signers: Keypair[]): string {
  const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: BLOCKHASH, instructions }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  if (signers.length) tx.sign(signers);
  return Buffer.from(tx.serialize()).toString("base64");
}

function standardIxs(lamports = LAMPORTS, to = agentWallet): Ix[] {
  return [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }),
    SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: to, lamports }),
  ];
}

function rejects400(fn: () => unknown, match?: RegExp) {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof HttpError, `expected HttpError, got ${String(err)}`);
    assert.equal(err.status, 400);
    if (match) assert.match(err.message, match);
    return true;
  });
}

test("valid: the exact owner → deposit transfer passes and yields its signature", () => {
  const tx = v0(owner.publicKey, standardIxs(), [owner]);
  const v = d.validateSignedDeposit(tx, expected());
  assert.equal(v.from, owner.publicKey.toBase58());
  assert.equal(v.to, agentWallet.toBase58());
  assert.equal(v.lamports, LAMPORTS);
  assert.equal(v.blockhash, BLOCKHASH);
  assert.equal(v.signature.length > 80, true);
  // Without compute budget instructions, and as a legacy transaction, it is still exactly a transfer.
  d.validateSignedDeposit(v0(owner.publicKey, [SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: agentWallet, lamports: LAMPORTS })], [owner]), expected());
  const legacy = new Transaction({ feePayer: owner.publicKey, recentBlockhash: BLOCKHASH }).add(...standardIxs());
  legacy.sign(owner);
  d.validateSignedDeposit(legacy.serialize().toString("base64"), expected());
});

test("wrong recipient is rejected", () => {
  const tx = v0(owner.publicKey, standardIxs(LAMPORTS, attacker.publicKey), [owner]);
  rejects400(() => d.validateSignedDeposit(tx, expected()), /recipient/);
});

test("wrong amount is rejected", () => {
  rejects400(() => d.validateSignedDeposit(v0(owner.publicKey, standardIxs(LAMPORTS + BigInt(1)), [owner]), expected()), /amount/);
  rejects400(() => d.validateSignedDeposit(v0(owner.publicKey, standardIxs(LAMPORTS - BigInt(1)), [owner]), expected()), /amount/);
});

test("extra instruction is rejected (second transfer, memo, any other program)", () => {
  const second = SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: attacker.publicKey, lamports: 1 });
  rejects400(() => d.validateSignedDeposit(v0(owner.publicKey, [...standardIxs(), second], [owner]), expected()), /more than one transfer/);
  const memo = new TransactionInstruction({
    programId: new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"),
    keys: [],
    data: Buffer.from("hi"),
  });
  rejects400(() => d.validateSignedDeposit(v0(owner.publicKey, [...standardIxs(), memo], [owner]), expected()), /only a SOL transfer/);
  // A different System instruction (e.g. Assign) instead of Transfer.
  const assign = SystemProgram.assign({ accountPubkey: owner.publicKey, programId: attacker.publicKey });
  rejects400(() => d.validateSignedDeposit(v0(owner.publicKey, [assign], [owner]), expected()));
  // Duplicate compute budget instruction.
  const dupe = [...standardIxs(), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 })];
  rejects400(() => d.validateSignedDeposit(v0(owner.publicKey, dupe, [owner]), expected()), /compute budget/);
  // An absurd priority fee: 1M CU × 100 lamports/CU = 0.1 SOL (cap 0.01 SOL).
  const pricey = [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000_000 }), ...standardIxs().slice(2)];
  rejects400(() => d.validateSignedDeposit(v0(owner.publicKey, pricey, [owner]), expected()), /priority fee/);
});

test("extra signer is rejected", () => {
  // A transfer that also moves the attacker's funds needs the attacker's signature: two signers.
  const ixs = [...standardIxs().slice(0, 2), SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: agentWallet, lamports: LAMPORTS })];
  const withCosigner = [...ixs, SystemProgram.transfer({ fromPubkey: attacker.publicKey, toPubkey: attacker.publicKey, lamports: 1 })];
  rejects400(() => d.validateSignedDeposit(v0(owner.publicKey, withCosigner, [owner, attacker]), expected()), /one signer/);
});

test("wrong fee payer is rejected (even when the owner signed the transfer)", () => {
  // Fee payer = attacker; the owner co-signs the transfer.
  rejects400(() => d.validateSignedDeposit(v0(attacker.publicKey, standardIxs(), [attacker, owner]), expected()));
  // Fee payer = attacker alone, transferring from the owner (would need the owner's signature → 2 signers).
  const fromOther = [SystemProgram.transfer({ fromPubkey: attacker.publicKey, toPubkey: agentWallet, lamports: LAMPORTS })];
  rejects400(() => d.validateSignedDeposit(v0(attacker.publicKey, fromOther, [attacker]), expected()), /fee payer/);
});

test("unsigned, badly signed and malformed transactions are rejected", () => {
  rejects400(() => d.validateSignedDeposit(v0(owner.publicKey, standardIxs(), []), expected()), /not signed/);
  // Signed by the attacker's key in the owner's slot.
  const msg = new TransactionMessage({ payerKey: owner.publicKey, recentBlockhash: BLOCKHASH, instructions: standardIxs() }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.signatures[0] = new Uint8Array(Buffer.alloc(64, 7));
  rejects400(() => d.validateSignedDeposit(Buffer.from(tx.serialize()).toString("base64"), expected()), /signature/);
  rejects400(() => d.validateSignedDeposit("not base64!", expected()));
  rejects400(() => d.validateSignedDeposit(Buffer.from("hello").toString("base64"), expected()));
  // Trailing bytes after a valid transaction.
  const good = Buffer.from(v0(owner.publicKey, standardIxs(), [owner]), "base64");
  rejects400(() => d.validateSignedDeposit(Buffer.concat([good, Buffer.from([0])]).toString("base64"), expected()));
});

test("buildDepositTx output, once signed by the owner, is exactly what validateSignedDeposit accepts", async () => {
  const original = Connection.prototype.getLatestBlockhash;
  Connection.prototype.getLatestBlockhash = async () => ({ blockhash: BLOCKHASH, lastValidBlockHeight: 123 });
  try {
    const built = await d.buildDepositTx(expected());
    assert.equal(built.lastValidBlockHeight, 123);
    const tx = VersionedTransaction.deserialize(Buffer.from(built.txBase64, "base64"));
    assert.equal(tx.message.staticAccountKeys[0]!.toBase58(), owner.publicKey.toBase58(), "fee payer is the owner wallet");
    tx.sign([owner]);
    const v = d.validateSignedDeposit(Buffer.from(tx.serialize()).toString("base64"), expected());
    assert.equal(v.lamports, LAMPORTS);
  } finally {
    Connection.prototype.getLatestBlockhash = original;
  }
});

test("submitDeposit never broadcasts a transaction that fails the checks", async () => {
  const original = Connection.prototype.sendRawTransaction;
  let sent = 0;
  Connection.prototype.sendRawTransaction = async () => {
    sent++;
    return "x";
  };
  try {
    const bad = v0(owner.publicKey, [...standardIxs(), SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: attacker.publicKey, lamports: 5 })], [owner]);
    await assert.rejects(d.submitDeposit(bad), (err: unknown) => err instanceof HttpError && err.status === 400);
    await assert.rejects(d.submitDeposit(v0(owner.publicKey, standardIxs(LAMPORTS, attacker.publicKey), [owner]), expected()), (err: unknown) => err instanceof HttpError && err.status === 400);
    assert.equal(sent, 0);
  } finally {
    Connection.prototype.sendRawTransaction = original;
  }
});

test("solToLamports rejects nonsense amounts", () => {
  assert.equal(d.solToLamports(1.5), BigInt(1_500_000_000));
  assert.equal(d.solToLamports(0.000000001), BigInt(1));
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1e-12]) rejects400(() => d.solToLamports(bad));
});
