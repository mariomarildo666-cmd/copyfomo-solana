// Run: npx tsx --test src/worker/send.test.ts
// signAndSend: signature persisted before broadcast (F4), "expired" only when the chain really can't find it —
// a landed tx whose confirmation was missed is found by the history lookup (F3). In-memory chain, no network.
import "@/lib/__testing__/env"; // first: keeps the real .env (keys, RPC URLs) out of this test
import { before, test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { BLOCKHASH, FakeChain } from "./testkit";

process.env.DATABASE_URL = "file:./__send_test_no_such_dir__/none.db";
const chain = new FakeChain().install();

type Send = typeof import("./send");
let send: Send;
let signerFromSecret: typeof import("./wallet").signerFromSecret;

before(async () => {
  send = await import("./send");
  ({ signerFromSecret } = await import("./wallet"));
});

const agent = Keypair.generate();
const fast = { pollMs: 2, rebroadcastMs: 5, maxWaitMs: 5_000 };

function transferTx(): VersionedTransaction {
  const msg = new TransactionMessage({
    payerKey: agent.publicKey,
    recentBlockhash: BLOCKHASH,
    instructions: [SystemProgram.transfer({ fromPubkey: agent.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1_000 })],
  }).compileToV0Message();
  return new VersionedTransaction(msg);
}

function reset() {
  chain.sent = [];
  chain.broadcasts = 0;
  chain.statuses.clear();
  chain.blockHeight = 1_000;
  chain.heightStep = 50;
  chain.hideStatusesUntilHeight = null;
  chain.landing = () => "land";
  chain.onBroadcast = null;
  chain.setWallet(agent.publicKey.toBase58(), 1_000_000_000);
}

test("F3: a landed tx whose confirmation was missed is reported landed, not expired", async () => {
  reset();
  chain.hideStatusesUntilHeight = 1e9; // plain status polls never see it (dropped WS / lagging node)
  const signer = signerFromSecret(agent.secretKey);
  const landed = await send.signAndSend(transferTx(), signer, fast);
  assert.equal(landed.signature, chain.sent[0]!.signature);
  assert.ok(chain.blockHeight > landed.lastValidBlockHeight + send.EXPIRY_MARGIN_BLOCKS, "decided only after expiry");
  assert.ok(chain.broadcasts > 1, "the same bytes were rebroadcast while waiting");
});

test("expired only after the block height passed and history lookups can't find it", async () => {
  reset();
  chain.landing = () => "drop";
  const signer = signerFromSecret(agent.secretKey);
  await assert.rejects(send.signAndSend(transferTx(), signer, fast), (err: unknown) => {
    assert.ok(err instanceof send.SendError);
    assert.equal(err.outcome, "expired");
    assert.ok(err.signature);
    return true;
  });
  assert.ok(chain.blockHeight > 1_000 + 150 + send.EXPIRY_MARGIN_BLOCKS);
});

test("F4: onSigned runs with the signature BEFORE the first broadcast; a failing onSigned broadcasts nothing", async () => {
  reset();
  const signer = signerFromSecret(agent.secretKey);
  let seen: { signature: string; broadcastsThen: number } | null = null;
  const landed = await send.signAndSend(transferTx(), signer, {
    ...fast,
    onSigned: async ({ signature, lastValidBlockHeight }) => {
      assert.ok(lastValidBlockHeight >= 1_000);
      seen = { signature, broadcastsThen: chain.broadcasts };
    },
  });
  assert.deepEqual(seen, { signature: landed.signature, broadcastsThen: 0 });

  reset();
  await assert.rejects(
    send.signAndSend(transferTx(), signer, {
      ...fast,
      onSigned: async () => {
        throw new Error("db down");
      },
    }),
    (err: unknown) => err instanceof send.SendError && err.outcome === "rejected",
  );
  assert.equal(chain.broadcasts, 0);
});

test("preflight rejection → rejected (nothing broadcast); on-chain error → failed", async () => {
  reset();
  chain.landing = () => "reject";
  const signer = signerFromSecret(agent.secretKey);
  await assert.rejects(send.signAndSend(transferTx(), signer, fast), (err: unknown) => err instanceof send.SendError && err.outcome === "rejected");

  reset();
  chain.landing = () => "fail";
  await assert.rejects(send.signAndSend(transferTx(), signer, fast), (err: unknown) => err instanceof send.SendError && err.outcome === "failed");
});

test("RPC outage: unconfirmed (never 'expired'), with the signature", async () => {
  reset();
  const signer = signerFromSecret(agent.secretKey);
  const orig = { st: chain.getSignatureStatuses, bh: chain.getBlockHeight };
  chain.getSignatureStatuses = async () => {
    throw new Error("fetch failed");
  };
  chain.getBlockHeight = async () => {
    throw new Error("fetch failed");
  };
  try {
    await assert.rejects(send.signAndSend(transferTx(), signer, { ...fast, maxWaitMs: 60 }), (err: unknown) => {
      assert.ok(err instanceof send.SendError);
      assert.equal(err.outcome, "unconfirmed");
      assert.ok(err.signature);
      return true;
    });
  } finally {
    chain.getSignatureStatuses = orig.st;
    chain.getBlockHeight = orig.bh;
  }
});

test("refuses to sign for another fee payer", async () => {
  reset();
  const other = signerFromSecret(Keypair.generate().secretKey);
  await assert.rejects(send.signAndSend(transferTx(), other, fast), /fee payer/);
  assert.equal(chain.broadcasts, 0);
});

test("transfer tx: exact fee constant, v0, one signer", async () => {
  const tx = await send.buildTransferTx(agent.publicKey, Keypair.generate().publicKey.toBase58(), BigInt(123));
  assert.equal(tx.version, 0);
  assert.equal(tx.message.header.numRequiredSignatures, 1);
  assert.equal(send.TRANSFER_FEE_LAMPORTS, 5_100);
});
