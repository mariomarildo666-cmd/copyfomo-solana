// Run: npx tsx --test src/worker/feesweep.test.ts
// Live fee sweeps: threshold (FEE_SWEEP_MIN_SOL) unless forced, the wallet's reserve is respected, owed → paid only
// once the transfer landed, an unsettled sweep blocks a second one and is settled from the chain later, a failed
// sweep leaves the debt owed. Throwaway SQLite DB + in-memory chain.
import "@/lib/__testing__/env"; // first: keeps the real .env (keys, RPC URLs) out of this test
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { createTestDatabase } from "@/lib/__testing__/db";
import { FakeChain, systemTransferEffects, testSealKeys, transfersIn } from "./testkit";

const testDb = createTestDatabase();
const seal = testSealKeys();
const FEE_WALLET = Keypair.generate().publicKey.toBase58();
Object.assign(process.env, {
  COPYFOMO_MODE: "live",
  PLATFORM_FEE_BPS: "500",
  PLATFORM_FEE_WALLET: FEE_WALLET,
  FEE_SWEEP_MIN_SOL: "0.01",
  WALLET_SEAL_PUBLIC_KEY: seal.publicKey,
  WALLET_SEAL_PRIVATE_KEY: seal.privateKey,
});
const chain = new FakeChain().install();
chain.effects = systemTransferEffects;

let prisma: typeof import("@/lib/db").prisma;
let fees: typeof import("./feesweep");
let inflight: typeof import("./inflight");
let sealSecret: typeof import("@/lib/crypto").sealSecret;

before(async () => {
  ({ prisma } = await import("@/lib/db"));
  ({ sealSecret } = await import("@/lib/crypto"));
  fees = await import("./feesweep");
  inflight = await import("./inflight");
  Object.assign((await import("./send")).sendTiming, { pollMs: 2, rebroadcastMs: 5, maxWaitMs: 400 });
});
after(async () => {
  await prisma.$disconnect();
  testDb.cleanup();
});
beforeEach(() => {
  chain.sent = [];
  chain.landing = () => "land";
  chain.blockHeight = 1_000;
  chain.heightStep = 50;
});

const SOL = 1_000_000_000;
const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≉ ${b}`);

async function liveAgent(balanceSol: number, feeOwedSol: number) {
  const kp = Keypair.generate();
  const agent = await prisma.agent.create({
    data: {
      name: "sweep.test",
      slug: `sweep-${Math.random().toString(36).slice(2, 8)}`,
      ownerKeyHash: "",
      ownerWallet: Keypair.generate().publicKey.toBase58(),
      payoutAddress: "",
      depositAddress: kp.publicKey.toBase58(),
      sealedSecret: sealSecret(kp.secretKey),
      mode: "live",
      status: "active",
      feeOwedSol,
    },
  });
  chain.setWallet(agent.depositAddress, Math.round(balanceSol * SOL));
  return agent;
}

test("below FEE_SWEEP_MIN_SOL nothing moves unless forced; a forced sweep pays the platform wallet exactly", async () => {
  const agent = await liveAgent(1, 0.005);
  const routine = await fees.sweepFees(agent, { force: false, reserveSol: 0.02 });
  assert.deepEqual(routine, { swept: 0, skip: "below_minimum" });
  assert.equal(chain.sent.length, 0);

  const forced = await fees.sweepFees(agent, { force: true, reserveSol: 0.002 });
  assert.ok("signature" in forced && forced.status === "confirmed");
  assert.deepEqual(transfersIn(chain.sent[0]!.tx), [{ to: FEE_WALLET, lamports: 5_000_000 }]);
  const a = await prisma.agent.findUniqueOrThrow({ where: { id: agent.id } });
  close(a.feeOwedSol, 0);
  close(a.feesPaidSol, 0.005);
  const s = await prisma.feeSweep.findFirstOrThrow({ where: { agentId: agent.id } });
  assert.equal(s.status, "confirmed");
  assert.equal(s.signature, chain.sent[0]!.signature);
});

test("the reserve stays in the wallet: a short balance sweeps what it can, the rest stays owed", async () => {
  const agent = await liveAgent(0.03, 0.05);
  const r = await fees.sweepFees(agent, { force: false, reserveSol: 0.02 });
  assert.ok("signature" in r);
  close(r.swept, 0.01);
  const a = await prisma.agent.findUniqueOrThrow({ where: { id: agent.id } });
  close(a.feeOwedSol, 0.04);
  close(a.feesPaidSol, 0.01);
  assert.ok(chain.lamportsOf(agent.depositAddress) >= 0.02 * SOL - 5_100);
});

test("an unconfirmed sweep blocks another one, and is settled from the chain later", async () => {
  const agent = await liveAgent(1, 0.05);
  const orig = chain.getSignatureStatuses.bind(chain);
  chain.getSignatureStatuses = async () => {
    throw new Error("fetch failed");
  };
  let r: Awaited<ReturnType<typeof fees.sweepFees>>;
  try {
    r = await fees.sweepFees(agent, { force: false, reserveSol: 0.02 });
  } finally {
    chain.getSignatureStatuses = orig;
  }
  assert.ok("signature" in r && r.status === "sent");
  let a = await prisma.agent.findUniqueOrThrow({ where: { id: agent.id } });
  close(a.feeOwedSol, 0.05); // not paid until the chain says so
  assert.deepEqual(await fees.sweepFees(agent, { force: true, reserveSol: 0.002 }), { swept: 0, skip: "unsettled_sweep" });
  assert.equal(chain.sent.length, 1, "never two transfers for the same debt");

  const [rec] = (await inflight.readJournal()).filter((j) => j.agentId === agent.id);
  assert.ok(rec && rec.kind === "fee_sweep");
  await fees.resolveFeeSweep(rec, { state: "landed", slot: 1 });
  a = await prisma.agent.findUniqueOrThrow({ where: { id: agent.id } });
  close(a.feeOwedSol, 0);
  close(a.feesPaidSol, 0.05);
  assert.equal((await prisma.feeSweep.findFirstOrThrow({ where: { agentId: agent.id } })).status, "confirmed");
  assert.equal((await inflight.readJournal()).filter((j) => j.agentId === agent.id).length, 0);
});

test("a sweep that fails on-chain leaves the fee owed", async () => {
  const agent = await liveAgent(1, 0.05);
  chain.landing = () => "fail";
  const r = await fees.sweepFees(agent, { force: false, reserveSol: 0.02 });
  assert.equal("skip" in r && r.skip, "failed");
  const a = await prisma.agent.findUniqueOrThrow({ where: { id: agent.id } });
  close(a.feeOwedSol, 0.05);
  close(a.feesPaidSol, 0);
  assert.equal((await prisma.feeSweep.findFirstOrThrow({ where: { agentId: agent.id } })).status, "failed");
});

test("routine sweep reserve never starves exits", () => {
  assert.ok(fees.routineSweepReserveSol({ minReserveSol: 0 }) >= 0.005);
  assert.equal(fees.routineSweepReserveSol({ minReserveSol: 0.05 }), 0.05);
});
