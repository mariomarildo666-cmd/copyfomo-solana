// Run: npx tsx --test src/worker/ledger.test.ts
// The 5% performance fee in the copy ledger: charged only on the profit of FILLED sells, deducted from paperSol
// (paper) or accrued as feeOwedSol (live); buys and losing sells pay nothing. Throwaway SQLite DB.
import "@/lib/__testing__/env"; // first: keeps the real .env (keys, RPC URLs) out of this test
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { createTestDatabase } from "@/lib/__testing__/db";

const testDb = createTestDatabase();
process.env.PLATFORM_FEE_BPS = "500";
process.env.COPYFOMO_MODE = "live";

let prisma: typeof import("@/lib/db").prisma;
let ledger: typeof import("./ledger");
let inflight: typeof import("./inflight");

before(async () => {
  ({ prisma } = await import("@/lib/db"));
  ledger = await import("./ledger");
  inflight = await import("./inflight");
});
after(async () => {
  await prisma.$disconnect();
  testDb.cleanup();
});

const addr = () => Keypair.generate().publicKey.toBase58();
const MINT = "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr";
const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≉ ${b}`);

async function seed(mode: "paper" | "live", paperSol = 2) {
  const trader = await prisma.trader.create({ data: { wallet: addr(), source: "custom" } });
  const agent = await prisma.agent.create({
    data: {
      name: "fee.test",
      slug: `fee-${Math.random().toString(36).slice(2, 8)}`,
      ownerKeyHash: "",
      ownerWallet: null,
      payoutAddress: addr(),
      depositAddress: addr(),
      sealedSecret: "v1.x",
      mode,
      status: "active",
      paperSol,
    },
  });
  const position = await prisma.position.create({
    data: { agentId: agent.id, traderId: trader.id, mint: MINT, decimals: 6, rawAmount: "1000", costSol: 1, realizedSol: 0 },
  });
  const trade = await prisma.copyTrade.create({ data: { agentId: agent.id, traderId: trader.id, side: "sell", mint: MINT, status: "pending" } });
  return { agent, trader, position, trade };
}

const fill = (solAmount: number, tokenRaw: number, signature = `paper_${Math.random()}`) => ({
  solAmount,
  tokenRaw: BigInt(tokenRaw),
  decimals: 6,
  signature,
  venue: "paper" as const,
});

test("paper winning sell: 5% of the profit is deducted from paperSol and recorded", async () => {
  const { agent, position, trade } = await seed("paper");
  const { feeSol } = await ledger.recordSell(agent, trade.id, position.id, fill(1.5, 1000), 10, 6);
  close(feeSol, 0.025); // (1.5 − 1) × 5%
  const a = await prisma.agent.findUniqueOrThrow({ where: { id: agent.id } });
  close(a.paperSol, 2 + 1.5 - 0.025);
  close(a.feesPaidSol, 0.025);
  close(a.feeOwedSol, 0);
  const t = await prisma.copyTrade.findUniqueOrThrow({ where: { id: trade.id } });
  assert.equal(t.status, "filled");
  close(t.feeSol, 0.025);
  close(t.solAmount, 1.5); // gross proceeds stay on the row
  assert.equal(await prisma.position.count({ where: { id: position.id } }), 0);
});

test("paper partial winning sell: fee on the part sold; the sleeve's realized PnL is net of it", async () => {
  const { agent, position, trade } = await seed("paper");
  const { feeSol } = await ledger.recordSell(agent, trade.id, position.id, fill(0.7, 500), 10, 6); // cost part 0.5
  close(feeSol, 0.01);
  const p = await prisma.position.findUniqueOrThrow({ where: { id: position.id } });
  assert.equal(p.rawAmount, "500");
  close(p.costSol, 0.5);
  close(p.realizedSol, 0.2 - 0.01);
});

test("losing and break-even sells pay nothing", async () => {
  for (const proceeds of [0.8, 1]) {
    const { agent, position, trade } = await seed("paper");
    const { feeSol } = await ledger.recordSell(agent, trade.id, position.id, fill(proceeds, 1000), 10, 6);
    assert.equal(feeSol, 0);
    const a = await prisma.agent.findUniqueOrThrow({ where: { id: agent.id } });
    close(a.paperSol, 2 + proceeds);
    close(a.feesPaidSol, 0);
    close((await prisma.copyTrade.findUniqueOrThrow({ where: { id: trade.id } })).feeSol, 0);
  }
});

test("live winning sell: the fee is owed (never taken from paperSol) and the journal record is settled", async () => {
  const { agent, position, trade } = await seed("live", 0);
  const signature = addr() + "sig";
  await prisma.kv.create({ data: inflight.journalRow({ kind: "copy_sell", signature, agentId: agent.id, owner: agent.depositAddress, lastValidBlockHeight: 1, sentAt: 0 }) });
  const { feeSol } = await ledger.recordSell(agent, trade.id, position.id, { ...fill(3, 1000, signature), venue: "jupiter", exhausted: true }, 10, 6);
  close(feeSol, 0.1); // (3 − 1) × 5%
  const a = await prisma.agent.findUniqueOrThrow({ where: { id: agent.id } });
  close(a.feeOwedSol, 0.1);
  close(a.feesPaidSol, 0);
  close(a.paperSol, 0);
  assert.equal(await prisma.kv.count({ where: { key: inflight.inflightKey(signature) } }), 0);
});

test("buys pay no fee; a sell with no sleeve left books proceeds without a fee", async () => {
  const { agent, trader, trade } = await seed("paper", 5);
  const buy = await prisma.copyTrade.create({ data: { agentId: agent.id, traderId: trader.id, side: "buy", mint: MINT, status: "pending" } });
  await ledger.recordBuy(agent, buy.id, { traderId: trader.id, mint: MINT, symbol: null, decimals: 6, latencyMs: 1 }, fill(0.5, 100));
  close((await prisma.copyTrade.findUniqueOrThrow({ where: { id: buy.id } })).feeSol, 0);
  const { feeSol } = await ledger.recordSell(agent, trade.id, null, fill(9, 1), 1, 6);
  assert.equal(feeSol, 0);
});
