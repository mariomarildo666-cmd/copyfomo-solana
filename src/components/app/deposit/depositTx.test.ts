// The browser refuses to ask the wallet to sign anything but the exact deposit transfer.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { base64ToBytes, bytesToBase64, checkDepositTx, DepositTxMismatch, sameBytes, solToLamports } from "./depositTx";

const owner = Keypair.generate().publicKey;
const agent = Keypair.generate().publicKey;
const BLOCKHASH = "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi";

function build(instructions: TransactionInstruction[], payer: PublicKey = owner): VersionedTransaction {
  const message = new TransactionMessage({ payerKey: payer, recentBlockhash: BLOCKHASH, instructions }).compileToV0Message();
  return new VersionedTransaction(message);
}

/** Same shape as src/lib/deposit.ts buildDepositTx. */
function serverTx(lamports: bigint, to: PublicKey = agent): VersionedTransaction {
  return build([
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }),
    SystemProgram.transfer({ fromPubkey: owner, toPubkey: to, lamports }),
  ]);
}

const expected = (lamports: bigint) => ({ from: owner.toBase58(), to: agent.toBase58(), lamports });

test("accepts exactly the transfer the server builds", () => {
  const lamports = solToLamports(1.25);
  assert.equal(lamports, BigInt(1_250_000_000));
  assert.doesNotThrow(() => checkDepositTx(serverTx(lamports), expected(lamports)));
  // A bare transfer (no compute budget) is fine too.
  const bare = build([SystemProgram.transfer({ fromPubkey: owner, toPubkey: agent, lamports })]);
  assert.doesNotThrow(() => checkDepositTx(bare, expected(lamports)));
});

test("survives a base64 round trip (what travels over the API)", () => {
  const lamports = solToLamports(0.5);
  const b64 = bytesToBase64(serverTx(lamports).serialize());
  const back = VersionedTransaction.deserialize(base64ToBytes(b64));
  assert.doesNotThrow(() => checkDepositTx(back, expected(lamports)));
  assert.ok(sameBytes(back.message.serialize(), serverTx(lamports).message.serialize()));
});

test("rejects a different amount, recipient or fee payer", () => {
  const lamports = solToLamports(1);
  assert.throws(() => checkDepositTx(serverTx(lamports + BigInt(1)), expected(lamports)), DepositTxMismatch);
  const other = Keypair.generate().publicKey;
  assert.throws(() => checkDepositTx(serverTx(lamports, other), expected(lamports)), /recipient/);
  const stranger = Keypair.generate().publicKey;
  const paidByStranger = build([SystemProgram.transfer({ fromPubkey: owner, toPubkey: agent, lamports })], stranger);
  assert.throws(() => checkDepositTx(paidByStranger, expected(lamports)), DepositTxMismatch);
});

test("rejects extra transfers, other programs and extra accounts", () => {
  const lamports = solToLamports(1);
  const twice = build([
    SystemProgram.transfer({ fromPubkey: owner, toPubkey: agent, lamports }),
    SystemProgram.transfer({ fromPubkey: owner, toPubkey: agent, lamports }),
  ]);
  assert.throws(() => checkDepositTx(twice, expected(lamports)), /exactly one transfer/);

  const drain = build([
    SystemProgram.transfer({ fromPubkey: owner, toPubkey: agent, lamports }),
    SystemProgram.transfer({ fromPubkey: owner, toPubkey: Keypair.generate().publicKey, lamports }),
  ]);
  assert.throws(() => checkDepositTx(drain, expected(lamports)), DepositTxMismatch);

  const memo = new TransactionInstruction({
    programId: new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"),
    keys: [],
    data: Buffer.from("hi"),
  });
  const withMemo = build([SystemProgram.transfer({ fromPubkey: owner, toPubkey: agent, lamports }), memo]);
  assert.throws(() => checkDepositTx(withMemo, expected(lamports)), /other than the System/);

  const assign = build([SystemProgram.assign({ accountPubkey: owner, programId: agent })]);
  assert.throws(() => checkDepositTx(assign, expected(lamports)), /plain SOL transfer/);
});

test("rejects an outsized priority fee or repeated compute budget", () => {
  const lamports = solToLamports(1);
  const pricey = build([
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000_000 }),
    SystemProgram.transfer({ fromPubkey: owner, toPubkey: agent, lamports }),
  ]);
  assert.throws(() => checkDepositTx(pricey, expected(lamports)), /priority fee/);
  const repeated = build([
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
    SystemProgram.transfer({ fromPubkey: owner, toPubkey: agent, lamports }),
  ]);
  assert.throws(() => checkDepositTx(repeated, expected(lamports)), /repeats/);
});

test("solToLamports refuses nonsense amounts", () => {
  assert.throws(() => solToLamports(0));
  assert.throws(() => solToLamports(-1));
  assert.throws(() => solToLamports(Number.NaN));
  assert.equal(solToLamports(0.1), BigInt(100_000_000));
});
