// Run: npx tsx --test src/worker/commands.test.ts
// Withdrawals: owed platform fees are swept BEFORE the owner's transfer and never withdrawn; the transfer goes only
// to the owner wallet; the sell reserve stays while tokens are held (F7); an empty wallet is drained to 0 (F47);
// a tampered payout is refused (F10); the agent is not "stopped" while it still holds tokens (F2).
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
  MAX_PRIORITY_FEE_LAMPORTS: "2000000",
});
const chain = new FakeChain().install();
chain.effects = systemTransferEffects;

let prisma: typeof import("@/lib/db").prisma;
let cmds: typeof import("./commands");
let sealSecret: typeof import("@/lib/crypto").sealSecret;
let sizing: typeof import("./sizing");

before(async () => {
  ({ prisma } = await import("@/lib/db"));
  ({ sealSecret } = await import("@/lib/crypto"));
  cmds = await import("./commands");
  sizing = await import("./sizing");
  Object.assign((await import("./send")).sendTiming, { pollMs: 2, rebroadcastMs: 5, maxWaitMs: 400 });
});
after(async () => {
  await prisma.$disconnect();
  testDb.cleanup();
});
beforeEach(() => {
  chain.sent = [];
  chain.landing = () => "land";
});

const SOL = 1_000_000_000;
const MINT = "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr";
const addr = () => Keypair.generate().publicKey.toBase58();
const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≉ ${b}`);

// ── Pure planning ───────────────────────────────────────────────────────────────────────────────────

test("planLiveWithdraw: owed fees and the reserve stay; tokens held → sell reserve; empty → drain to 0", () => {
  const base = { balanceLamports: BigInt(SOL), feeOwedSol: 0, holdsTokens: false, tokenAccountsLeft: 0, unsettledSweeps: 0, all: true, amountSol: null, sellReserveSol: 0.005 };
  const drain = cmds.planLiveWithdraw(base);
  assert.equal(drain.drain, true);
  assert.equal(drain.lamports, BigInt(SOL - 5_100));

  const owed = cmds.planLiveWithdraw({ ...base, feeOwedSol: 0.1 });
  assert.equal(owed.drain, false);
  assert.equal(owed.lamports, BigInt(SOL - 100_000_000 - 2_000_000));

  const holding = cmds.planLiveWithdraw({ ...base, holdsTokens: true });
  assert.equal(holding.lamports, BigInt(SOL - 5_000_000));

  const leftoverAccounts = cmds.planLiveWithdraw({ ...base, tokenAccountsLeft: 1 });
  assert.equal(leftoverAccounts.drain, false);
  const unsettled = cmds.planLiveWithdraw({ ...base, unsettledSweeps: 1 });
  assert.equal(unsettled.drain, false);

  const tooMuch = cmds.planLiveWithdraw({ ...base, all: false, amountSol: 0.95, feeOwedSol: 0.1 });
  assert.match(tooMuch.error ?? "", /insufficient balance.*platform fees owed/);
  const fits = cmds.planLiveWithdraw({ ...base, all: false, amountSol: 0.5, feeOwedSol: 0.1 });
  assert.equal(fits.lamports, BigInt(500_000_000));
});

test("sell reserve covers a WSOL account's rent, fees and the priority cap", () => {
  assert.ok(sizing.liveSellReserveSol(2_000_000) >= (2_039_280 + 5_000 + 2_000_000) / SOL);
  assert.equal(sizing.liveSellReserveSol(0), 0.005);
});

test("withdrawDestination: the owner wallet; a payout that disagrees with it is refused; legacy uses the payout", () => {
  const owner = addr();
  const dep = addr();
  assert.deepEqual(cmds.withdrawDestination({ ownerWallet: owner, payoutAddress: owner, depositAddress: dep }), { to: owner });
  assert.ok("error" in cmds.withdrawDestination({ ownerWallet: owner, payoutAddress: addr(), depositAddress: dep }));
  const legacy = addr();
  assert.deepEqual(cmds.withdrawDestination({ ownerWallet: null, payoutAddress: legacy, depositAddress: dep }), { to: legacy });
  assert.ok("error" in cmds.withdrawDestination({ ownerWallet: null, payoutAddress: dep, depositAddress: dep }));
  assert.ok("error" in cmds.withdrawDestination({ ownerWallet: FEE_WALLET, payoutAddress: FEE_WALLET, depositAddress: dep }));
});

// ── End to end through the command runner ───────────────────────────────────────────────────────────

async function liveAgent(balanceSol: number, feeOwedSol: number, over: { payoutAddress?: string } = {}) {
  const kp = Keypair.generate();
  const ownerWallet = addr();
  const agent = await prisma.agent.create({
    data: {
      name: "wd.test",
      slug: `wd-${Math.random().toString(36).slice(2, 8)}`,
      ownerKeyHash: "",
      ownerWallet,
      payoutAddress: over.payoutAddress ?? ownerWallet,
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

async function run(agentId: string, payload: unknown) {
  const cmd = await prisma.command.create({ data: { agentId, type: "withdraw", payload: JSON.stringify(payload), status: "running" } });
  await cmds.runCommand(cmd);
  const done = await prisma.command.findUniqueOrThrow({ where: { id: cmd.id } });
  return { status: done.status, result: JSON.parse(done.result ?? "{}") as Record<string, unknown> };
}

test("withdraw all: fees are swept to the platform FIRST, then everything else goes to the owner wallet", async () => {
  const agent = await liveAgent(1, 0.05);
  const { status, result } = await run(agent.id, { all: true, closePositions: true });
  assert.equal(status, "done", JSON.stringify(result));
  assert.equal(chain.sent.length, 2);
  assert.deepEqual(transfersIn(chain.sent[0]!.tx), [{ to: FEE_WALLET, lamports: 50_000_000 }]);
  const [payout] = transfersIn(chain.sent[1]!.tx);
  assert.equal(payout!.to, agent.ownerWallet);
  assert.equal(chain.lamportsOf(agent.depositAddress), 0, "an empty wallet is drained to 0 (F47)");
  const a = await prisma.agent.findUniqueOrThrow({ where: { id: agent.id } });
  close(a.feeOwedSol, 0);
  close(a.feesPaidSol, 0.05);
  assert.equal(a.status, "stopped");
  assert.equal(result.stopped, true);
});

test("withdraw while tokens are held: the sell reserve stays and the agent is not stopped", async () => {
  const agent = await liveAgent(1, 0);
  const ata = addr();
  chain.setToken(ata, { mint: MINT, owner: agent.depositAddress, amount: BigInt(1_000) });
  const { status, result } = await run(agent.id, { all: true });
  assert.equal(status, "done", JSON.stringify(result));
  const reserve = sizing.liveSellReserveSol(2_000_000);
  assert.ok(chain.lamportsOf(agent.depositAddress) >= reserve * SOL - 5_100, "enough SOL left to sell the position (F7)");
  assert.equal((await prisma.agent.findUniqueOrThrow({ where: { id: agent.id } })).status, "active");
});

test("a withdrawal of more than balance − owed − reserve is refused before anything but the fee sweep moves", async () => {
  const agent = await liveAgent(0.2, 0.05);
  chain.landing = () => "fail"; // the fee sweep fails on-chain: the fee stays owed
  const { status, result } = await run(agent.id, { amountSol: 0.19 });
  assert.equal(status, "failed");
  assert.match(String(result.error), /insufficient balance/);
  assert.equal(chain.sent.filter((s) => transfersIn(s.tx)[0]?.to !== FEE_WALLET).length, 0, "no transfer to the owner");
});

test("a tampered payout address is refused (no transaction)", async () => {
  const agent = await liveAgent(1, 0, { payoutAddress: addr() });
  const { status, result } = await run(agent.id, { all: true });
  assert.equal(status, "failed");
  assert.match(String(result.error), /does not match the owner wallet/);
  assert.equal(chain.sent.length, 0);
});

test("paper withdraw is simulated and addressed to the owner wallet", async () => {
  const owner = addr();
  const agent = await prisma.agent.create({
    data: {
      name: "wd.paper",
      slug: `wdp-${Math.random().toString(36).slice(2, 8)}`,
      ownerKeyHash: "",
      ownerWallet: owner,
      payoutAddress: owner,
      depositAddress: addr(),
      sealedSecret: "v1.x",
      mode: "paper",
      status: "active",
      paperSol: 3,
    },
  });
  const { status, result } = await run(agent.id, { amountSol: 1 });
  assert.equal(status, "done");
  assert.equal(result.to, owner);
  assert.equal(result.simulated, true);
  close((await prisma.agent.findUniqueOrThrow({ where: { id: agent.id } })).paperSol, 2);
  assert.equal(chain.sent.length, 0);
});

test("F15: a payout wallet that is not a plain wallet (token account, program-owned) is refused before anything moves", async () => {
  const agent = await liveAgent(1, 0);
  // The owner address is (now) a token account: SOL sent there would be stuck.
  chain.setToken(agent.ownerWallet!, { mint: MINT, owner: addr(), amount: BigInt(0) });
  const { status, result } = await run(agent.id, { all: true });
  assert.equal(status, "failed");
  assert.match(String(result.error), /not a plain wallet/);
  assert.equal(chain.sent.length, 0);
});

async function paperAgentWithPosition(paperSol: number) {
  const owner = addr();
  const trader = await prisma.trader.create({ data: { wallet: addr() } });
  return prisma.agent.create({
    data: {
      name: "wd.close",
      slug: `wdc-${Math.random().toString(36).slice(2, 8)}`,
      ownerKeyHash: "",
      ownerWallet: owner,
      payoutAddress: owner,
      depositAddress: addr(),
      sealedSecret: "v1.x",
      mode: "paper",
      status: "active",
      paperSol,
      // No Jupiter here (127.0.0.1:9): selling this position fails, like an unsellable token would.
      positions: { create: { traderId: trader.id, mint: MINT, decimals: 6, rawAmount: "1000000", costSol: 0.5 } },
    },
  });
}

test("F37/F38: close-first with a set amount sends nothing when a sell fails; Everything+close reports stopped:false", async () => {
  const a = await paperAgentWithPosition(3);
  const setAmount = await run(a.id, { amountSol: 1, closePositions: true });
  assert.equal(setAmount.status, "failed");
  assert.match(String(setAmount.result.error), /could not be sold — nothing was withdrawn/);
  assert.equal(setAmount.result.stopped, false);
  close((await prisma.agent.findUniqueOrThrow({ where: { id: a.id } })).paperSol, 3);

  const all = await run(a.id, { all: true, closePositions: true });
  assert.equal(all.result.stopped, false, JSON.stringify(all.result));
  assert.equal(all.result.positionsLeft, 1);
  assert.equal((await prisma.agent.findUniqueOrThrow({ where: { id: a.id } })).status, "active", "keeps copying exits");
});
