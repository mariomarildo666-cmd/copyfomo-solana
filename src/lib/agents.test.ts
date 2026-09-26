// Run: npx tsx --test src/lib/agents.test.ts
// Agent DTOs against a throwaway SQLite DB with Jupiter + RPC mocked:
//   owner-only fields (F31), no RPC on public reads (F26), unpriced positions (F19), fees + ROI (F44).
import "./__testing__/env"; // first: keeps the real .env (keys, RPC URLs) out of this test
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { createTestDatabase } from "./__testing__/db";

const testDb = createTestDatabase();
process.env.SOLANA_RPC_URL = "http://rpc.test/";
process.env.JUPITER_API_URL = "https://jup.test";
process.env.PLATFORM_FEE_BPS = "500";
// Set explicitly (even empty): Prisma loads the project .env for keys that are unset, and this test must never
// see a real Helius key or RPC URL.
process.env.HELIUS_API_KEY = "";
process.env.JUPITER_API_KEY = "";

const SOL = "So11111111111111111111111111111111111111112";
const addr = () => Keypair.generate().publicKey.toBase58();
const PRICED = addr();
const UNPRICED_OLD = addr();
const UNPRICED_YOUNG = addr();

let rpcCalls = 0;
let rpcBalanceLamports = 3_000_000_000;
let jupiterDown = false;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.startsWith("http://rpc.test")) {
    rpcCalls++;
    const body = JSON.parse(String(init?.body)) as { id: string | number };
    await new Promise((r) => setTimeout(r, 20));
    return Response.json({ jsonrpc: "2.0", id: body.id, result: { context: { slot: 1 }, value: rpcBalanceLamports } });
  }
  if (url.startsWith("https://jup.test/price/v3")) {
    if (jupiterDown) return new Response("down", { status: 500 });
    const ids = new URL(url).searchParams.get("ids")!.split(",");
    const table: Record<string, number> = { [SOL]: 200, [PRICED]: 2 };
    return Response.json(Object.fromEntries(ids.filter((id) => table[id] !== undefined).map((id) => [id, { usdPrice: table[id] }])));
  }
  throw new Error(`unexpected fetch ${url}`);
}) as typeof fetch;

type Agents = typeof import("./agents");
let agents: Agents;
let prisma: typeof import("./db").prisma;

before(async () => {
  agents = await import("./agents");
  ({ prisma } = await import("./db"));
});

after(async () => {
  globalThis.fetch = realFetch;
  await prisma?.$disconnect();
  testDb.cleanup();
});

const HOUR = 3600_000;
const close = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

async function seedAgent(p: { mode: "paper" | "live"; owner: string; paperSol?: number; lastBalanceSol?: number; feeOwedSol?: number; feesPaidSol?: number; balanceAt?: Date }) {
  const trader = await prisma.trader.create({ data: { wallet: addr() } });
  const agent = await prisma.agent.create({
    data: {
      name: "t.copy",
      slug: `t-copy-${Math.random().toString(36).slice(2, 8)}`,
      ownerKeyHash: "",
      ownerWallet: p.owner,
      payoutAddress: p.owner,
      depositAddress: addr(),
      sealedSecret: "v1.x",
      mode: p.mode,
      status: "active",
      paperSol: p.paperSol ?? 0,
      lastBalanceSol: p.lastBalanceSol ?? 0,
      balanceAt: p.balanceAt ?? null,
      feeOwedSol: p.feeOwedSol ?? 0,
      feesPaidSol: p.feesPaidSol ?? 0,
      follows: { create: [{ traderId: trader.id }] },
    },
  });
  const now = Date.now();
  await prisma.position.createMany({
    data: [
      // 50 tokens × $2 / $200 per SOL = 0.5 SOL, cost 0.4
      { agentId: agent.id, traderId: trader.id, mint: PRICED, decimals: 6, rawAmount: "50000000", costSol: 0.4, openedAt: new Date(now - 2 * HOUR) },
      // Jupiter has no price, opened 3 days ago: a dead token → 0
      { agentId: agent.id, traderId: trader.id, mint: UNPRICED_OLD, decimals: 6, rawAmount: "1000000", costSol: 0.3, openedAt: new Date(now - 72 * HOUR) },
      // No price yet, opened an hour ago → at cost
      { agentId: agent.id, traderId: trader.id, mint: UNPRICED_YOUNG, decimals: 6, rawAmount: "1000000", costSol: 0.2, openedAt: new Date(now - HOUR) },
    ],
  });
  const trade = (side: string, solAmount: number, feeSol = 0) => ({ agentId: agent.id, side, mint: PRICED, solAmount, status: "filled", feeSol });
  await prisma.copyTrade.createMany({
    data: [trade("buy", 0.4), trade("buy", 0.3), trade("buy", 0.2), trade("buy", 1.0), trade("sell", 1.2, 0.01)],
  });
  return agent;
}

test("paper: public vs owner view, net-of-fee PnL, unpriced positions, ROI on net capital, withdraw limits", async () => {
  const owner = addr();
  // paperSol = deposits 1.71 − bought 1.9 + sold 1.2 − fee 0.01 = 1.0
  const agent = await seedAgent({ mode: "paper", owner, paperSol: 1.0, feesPaidSol: 0.01 });

  const pub = await agents.getAgentDetail(agent.slug);
  assert.ok(pub);
  const a = pub.agent;
  assert.equal(a.isOwner, false);
  assert.equal("ownerWallet" in a, false, "owner wallet is never public");
  assert.equal("payoutAddress" in a, false, "payout wallet is never public");

  // open value = 0.5 (priced) + 0 (old unpriced) + 0.2 (young unpriced at cost) = 0.7
  close(a.equitySol, 1.7);
  close(a.pnlSol, 1.2 - 1.9 + 0.7 - 0.01, 1e-9);
  close(a.roiPct, (a.pnlSol / 1.71) * 100, 1e-4);
  assert.equal(a.unpricedCount, 2);
  close(a.unpricedCostSol, 0.5);
  assert.equal(a.valuationStale, false);
  close(a.feesPaidSol, 0.01);
  assert.equal(a.feeOwedSol, 0);
  close(a.withdrawableSol, 1.0);
  // + priced 0.5 × 0.95 − 5% of (0.475 − 0.4)
  close(a.withdrawAfterCloseSol, 1.0 + 0.475 - 0.00375, 1e-9);
  const sell = pub.trades.find((t) => t.side === "sell");
  close(sell!.feeSol, 0.01);

  const mine = await agents.getAgentDetail(agent.id, { isOwner: true });
  assert.equal(mine!.agent.isOwner, true);
  assert.equal(mine!.agent.ownerWallet, owner);
  assert.equal(mine!.agent.payoutAddress, owner);

  const listed = await agents.listMyAgents(owner);
  assert.deepEqual(listed.map((s) => s.id), [agent.id]);
  assert.equal("ownerWallet" in listed[0]!, false);
});

test("live: public reads never call RPC; owner reads refresh once (single-flight); fees owed are not equity", async () => {
  const owner = addr();
  const stale = new Date(Date.now() - 5 * 60_000);
  const agent = await seedAgent({ mode: "live", owner, lastBalanceSol: 2.0, balanceAt: stale, feeOwedSol: 0.05 });

  rpcCalls = 0;
  const views = await Promise.all(Array.from({ length: 20 }, () => agents.getAgentDetail(agent.slug)));
  assert.equal(rpcCalls, 0, "20 anonymous reads cost zero RPC calls");
  const a = views[0]!.agent;
  close(a.balanceSol, 2.0);
  close(a.equitySol, 2.0 - 0.05 + 0.7);
  close(a.feeOwedSol, 0.05);
  // It holds a position, so the live sell reserve stays behind (same ceiling as the worker, F7).
  const reserve = (await import("./fees")).liveSellReserveSol(2_000_000);
  assert.equal(reserve, 0.005);
  close(a.withdrawableSol, 2.0 - 0.05 - reserve);

  rpcCalls = 0;
  rpcBalanceLamports = 3_000_000_000;
  const owned = await Promise.all(Array.from({ length: 5 }, () => agents.getAgentDetail(agent.id, { isOwner: true })));
  assert.equal(rpcCalls, 1, "concurrent owner reads share one balance refresh");
  close(owned[0]!.agent.balanceSol, 3.0);
  const stored = await prisma.agent.findUniqueOrThrow({ where: { id: agent.id } });
  close(stored.lastBalanceSol, 3.0);

  const limits = await agents.withdrawLimits((await agents.findAgent(agent.id))!);
  close(limits.withdrawableSol, 3.0 - 0.05 - reserve);
  assert.equal(limits.reserveSol, reserve);
});

test("price outage: every position counts at cost and the valuation is flagged stale", async () => {
  jupiterDown = true;
  const owner = addr();
  const trader = await prisma.trader.create({ data: { wallet: addr() } });
  const mintA = addr();
  const mintB = addr();
  const agent = await prisma.agent.create({
    data: {
      name: "o.copy",
      slug: "o-copy-0001",
      ownerKeyHash: "",
      ownerWallet: owner,
      payoutAddress: owner,
      depositAddress: addr(),
      sealedSecret: "v1.x",
      mode: "paper",
      status: "active",
      paperSol: 1,
    },
  });
  await prisma.position.createMany({
    data: [
      { agentId: agent.id, traderId: trader.id, mint: mintA, decimals: 6, rawAmount: "1", costSol: 0.3, openedAt: new Date(Date.now() - 72 * HOUR) },
      { agentId: agent.id, traderId: trader.id, mint: mintB, decimals: 6, rawAmount: "1", costSol: 0.2, openedAt: new Date(Date.now() - 72 * HOUR) },
    ],
  });
  const d = await agents.getAgentDetail(agent.id);
  assert.equal(d!.agent.valuationStale, true);
  close(d!.agent.equitySol, 1.5, 1e-9);
  assert.equal(d!.agent.unpricedCount, 2);
  jupiterDown = false;
});
