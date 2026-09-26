// Run: npx tsx --test src/worker/executor.test.ts
// The live copy money path end to end (mocked Jupiter + in-memory chain + throwaway DB):
//   F4  a signed swap is journaled ("sending" + in-flight record) BEFORE its first broadcast;
//   F8  a buy's cost is measured from its own tx metadata (fees in, reclaimable rent out);
//   F2  an unconfirmed buy is never failed blindly: the reconciler records it from the chain;
//   F5  one empty token listing never deletes a sleeve; a recent sleeve is never cleared on "no tokens";
//   F6  a sell that fails while nothing landed is parked and retried to completion;
//   F22 a copy buy far worse than the trader's own fill is skipped;
//   fee a winning live sell accrues 5% of its profit as owed.
import "@/lib/__testing__/env"; // first: keeps the real .env (keys, RPC URLs) out of this test
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { createTestDatabase } from "@/lib/__testing__/db";
import { BLOCKHASH, FakeChain, testSealKeys, TOKEN, type Effect } from "./testkit";

const testDb = createTestDatabase();
const seal = testSealKeys();
Object.assign(process.env, {
  COPYFOMO_MODE: "live",
  COPY_VENUE: "all",
  JUPITER_API_URL: "https://jup.test",
  JUPITER_RPS: "1000",
  JUPITER_BURST: "1000",
  PLATFORM_FEE_BPS: "500",
  PLATFORM_FEE_WALLET: Keypair.generate().publicKey.toBase58(),
  MAX_PRIORITY_FEE_LAMPORTS: "2000000",
  WALLET_SEAL_PUBLIC_KEY: seal.publicKey,
  WALLET_SEAL_PRIVATE_KEY: seal.privateKey,
});
const chain = new FakeChain().install();

const SOL = "So11111111111111111111111111111111111111112";
const MINT = "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr";
const JUP6 = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const ATA = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const RENT = 2_039_280;
const PRIORITY = 300_000;

// ── Jupiter mock ────────────────────────────────────────────────────────────────────────────────────
const jup = { tokensPerLamport: 0.05, solPerToken: 30, failQuotes: 0, priceImpactPct: "0.01" };
const effectsByMessage = new Map<string, Effect[]>();
const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.origin !== "https://jup.test") throw new Error(`unexpected fetch ${url.origin}`);
  if (url.pathname === "/swap/v1/quote") {
    if (jup.failQuotes > 0) {
      jup.failQuotes--;
      return new Response("upstream error", { status: 500 });
    }
    const inputMint = url.searchParams.get("inputMint")!;
    const amount = BigInt(url.searchParams.get("amount")!);
    const slippageBps = Number(url.searchParams.get("slippageBps"));
    const out = inputMint === SOL ? BigInt(Math.floor(Number(amount) * jup.tokensPerLamport)) : amount * BigInt(jup.solPerToken);
    return Response.json({
      inputMint,
      outputMint: url.searchParams.get("outputMint"),
      inAmount: amount.toString(),
      outAmount: out.toString(),
      otherAmountThreshold: ((out * BigInt(10_000 - slippageBps)) / BigInt(10_000)).toString(),
      swapMode: "ExactIn",
      slippageBps,
      priceImpactPct: jup.priceImpactPct,
      routePlan: [{ percent: 100 }],
    });
  }
  if (url.pathname === "/swap/v1/swap") {
    const body = JSON.parse(String(init?.body)) as {
      quoteResponse: { inputMint: string; inAmount: string; outAmount: string };
      userPublicKey: string;
      prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: number } };
    };
    // Like Jupiter: the priority fee respects the cap we asked for.
    const priority = Math.min(PRIORITY, body.prioritizationFeeLamports.priorityLevelWithMaxLamports.maxLamports);
    const tx = swapTx(body.userPublicKey, body.quoteResponse, priority);
    return Response.json({ swapTransaction: b64(tx.serialize()), prioritizationFeeLamports: priority, computeUnitLimit: 300_000 });
  }
  return realFetch(input, init);
}) as typeof fetch;

function ataOf(owner: string, mint: string): string {
  return PublicKey.findProgramAddressSync([new PublicKey(owner).toBuffer(), new PublicKey(TOKEN).toBuffer(), new PublicKey(mint).toBuffer()], new PublicKey(ATA))[0].toBase58();
}

/** A Jupiter-shaped swap for `user`, and what it does when simulated / landed. */
function swapTx(user: string, q: { inputMint: string; inAmount: string; outAmount: string }, priority = PRIORITY): VersionedTransaction {
  const agent = new PublicKey(user);
  const wsol = new PublicKey(ataOf(user, SOL));
  const target = new PublicKey(ataOf(user, MINT));
  const ataIx = (mint: string, ata: PublicKey) =>
    new TransactionInstruction({
      programId: new PublicKey(ATA),
      keys: [
        { pubkey: agent, isSigner: true, isWritable: true },
        { pubkey: ata, isSigner: false, isWritable: true },
        { pubkey: agent, isSigner: false, isWritable: false },
        { pubkey: new PublicKey(mint), isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: new PublicKey(TOKEN), isSigner: false, isWritable: false },
      ],
      data: Buffer.from([1]),
    });
  const route = new TransactionInstruction({
    programId: new PublicKey(JUP6),
    keys: [agent, target, wsol].map((pubkey) => ({ pubkey, isSigner: pubkey.equals(agent), isWritable: true })),
    data: Buffer.from([229, 1]),
  });
  const closeWsol = new TransactionInstruction({
    programId: new PublicKey(TOKEN),
    keys: [
      { pubkey: wsol, isSigner: false, isWritable: true },
      { pubkey: agent, isSigner: false, isWritable: true },
      { pubkey: agent, isSigner: true, isWritable: false },
    ],
    data: Buffer.from([9]),
  });
  const buy = q.inputMint === SOL;
  const ixs = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: Math.floor((priority * 1_000_000) / 300_000) }),
    ataIx(SOL, wsol),
    ...(buy ? [SystemProgram.transfer({ fromPubkey: agent, toPubkey: wsol, lamports: BigInt(q.inAmount) })] : []),
    ...(buy ? [ataIx(MINT, target)] : []),
    route,
    closeWsol,
  ];
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: agent, recentBlockhash: BLOCKHASH, instructions: ixs }).compileToV0Message());
  const t = target.toBase58();
  const effects: Effect[] = buy
    ? [
        { kind: "lamports", address: user, delta: -(Number(q.inAmount) + RENT) },
        chain.accounts.has(t)
          ? { kind: "tokens", address: t, delta: BigInt(q.outAmount) }
          : { kind: "create_token", address: t, fields: { mint: MINT, owner: user, amount: BigInt(q.outAmount) }, lamports: RENT },
      ]
    : [
        { kind: "tokens", address: t, delta: -BigInt(q.inAmount) },
        { kind: "lamports", address: user, delta: Number(q.outAmount) },
      ];
  effectsByMessage.set(b64(tx.message.serialize()), effects);
  return tx;
}
chain.effects = (tx) => effectsByMessage.get(b64(tx.message.serialize())) ?? [];

// ── Modules / fixtures ──────────────────────────────────────────────────────────────────────────────
let prisma: typeof import("@/lib/db").prisma;
let exec: typeof import("./executor");
let inflight: typeof import("./inflight");
let queue: typeof import("./queue");
let retry: typeof import("./sellretry");
let sealSecret: typeof import("@/lib/crypto").sealSecret;

before(async () => {
  ({ prisma } = await import("@/lib/db"));
  ({ sealSecret } = await import("@/lib/crypto"));
  exec = await import("./executor");
  inflight = await import("./inflight");
  queue = await import("./queue");
  retry = await import("./sellretry");
  Object.assign((await import("./send")).sendTiming, { pollMs: 2, rebroadcastMs: 5, maxWaitMs: 300 });
});
after(async () => {
  globalThis.fetch = realFetch;
  await prisma.$disconnect();
  testDb.cleanup();
});
beforeEach(() => {
  chain.landing = () => "land";
  chain.onBroadcast = null;
  jup.tokensPerLamport = 0.05;
  jup.failQuotes = 0;
});

const handlers = () => ({
  copy_buy: exec.resolveCopyBuy,
  copy_sell: exec.resolveCopySell,
  fee_sweep: async () => undefined,
  withdraw: async () => undefined,
});

async function seedAgent() {
  const kp = Keypair.generate();
  const trader = await prisma.trader.create({ data: { wallet: Keypair.generate().publicKey.toBase58(), source: "custom" } });
  const agent = await prisma.agent.create({
    data: {
      name: "exec.test",
      slug: `exec-${Math.random().toString(36).slice(2, 8)}`,
      ownerKeyHash: "",
      ownerWallet: Keypair.generate().publicKey.toBase58(),
      payoutAddress: "",
      depositAddress: kp.publicKey.toBase58(),
      sealedSecret: sealSecret(kp.secretKey),
      mode: "live",
      status: "active",
      sizingMode: "fixed",
      fixedSol: 0.1,
      maxPerTradeSol: 1,
      follows: { create: [{ traderId: trader.id }] },
    },
  });
  chain.setWallet(agent.depositAddress, 2_000_000_000);
  return { agent, trader };
}

let eventSeq = 0;
async function event(traderId: string, side: "buy" | "sell", over: { solAmount?: number; tokenRaw?: string; sellFraction?: number } = {}) {
  return prisma.traderEvent.create({
    data: {
      traderId,
      signature: `ev${++eventSeq}${Math.random().toString(36).slice(2)}`,
      side,
      mint: MINT,
      solAmount: over.solAmount ?? 0.1,
      tokenRaw: over.tokenRaw ?? "5000000",
      decimals: 6,
      sellFraction: side === "sell" ? (over.sellFraction ?? 1) : null,
      buyFraction: null,
      venue: "fomo",
      blockTime: new Date(),
    },
  });
}

async function copy(ev: Awaited<ReturnType<typeof event>>) {
  await exec.dispatchEvent(ev);
  assert.ok(await queue.drainQueues(20_000));
  return prisma.copyTrade.findFirstOrThrow({ where: { eventId: ev.id } });
}

test("live buy: journaled before broadcast, cost measured from the tx (fees in, rent out)", async () => {
  const { agent, trader } = await seedAgent();
  const seen: { status: string; journal: boolean }[] = [];
  chain.onBroadcast = async (signature) => {
    const row = await prisma.copyTrade.findFirst({ where: { signature } });
    const journal = await prisma.kv.findUnique({ where: { key: inflight.inflightKey(signature) } });
    seen.push({ status: row?.status ?? "none", journal: journal !== null });
  };
  const row = await copy(await event(trader.id, "buy"));
  assert.deepEqual(seen, [{ status: "sending", journal: true }]);
  assert.equal(row.status, "filled", row.reason ?? "");
  const lamportsIn = 100_000_000;
  assert.equal(Math.round(row.solAmount * 1e9), lamportsIn + PRIORITY + 5_000); // no ATA rent in the cost
  assert.equal(row.tokenRaw, String(lamportsIn * jup.tokensPerLamport));
  const pos = await prisma.position.findFirstOrThrow({ where: { agentId: agent.id } });
  assert.equal(pos.rawAmount, row.tokenRaw);
  assert.equal((await inflight.readJournal()).length, 0);
});

test("F22: a copy buy filling far worse than the trader did is skipped, nothing is sent", async () => {
  const { trader } = await seedAgent();
  const sentBefore = chain.sent.length;
  // The trader got 3× more tokens per SOL than the quote offers now.
  const row = await copy(await event(trader.id, "buy", { tokenRaw: String(100_000_000 * 0.05 * 3) }));
  assert.equal(row.status, "skipped");
  assert.match(row.reason ?? "", /worse than the trader/);
  assert.equal(chain.sent.length, sentBefore);
});

test("F2/F4: an unconfirmed buy stays 'sending' and the reconciler records it from the chain", async () => {
  const { agent, trader } = await seedAgent();
  const orig = chain.getSignatureStatuses.bind(chain);
  chain.getSignatureStatuses = async () => {
    throw new Error("fetch failed");
  };
  let row;
  try {
    row = await copy(await event(trader.id, "buy"));
  } finally {
    chain.getSignatureStatuses = orig;
  }
  assert.equal(row.status, "sending");
  assert.ok(row.signature);
  assert.equal(await prisma.position.count({ where: { agentId: agent.id } }), 0);

  // A restart would find it in the journal; the reconciler settles it from the chain.
  const resolved = await inflight.reconcileInflight(handlers(), Date.now() + 60_000);
  assert.equal(resolved, 1);
  const after = await prisma.copyTrade.findUniqueOrThrow({ where: { id: row.id } });
  assert.equal(after.status, "filled");
  assert.equal((await prisma.position.findFirstOrThrow({ where: { agentId: agent.id } })).rawAmount, after.tokenRaw);
});

test("F5: an empty token listing does not delete the sleeve (direct account read); a winning sell accrues the fee", async () => {
  const { agent, trader } = await seedAgent();
  await copy(await event(trader.id, "buy"));
  chain.tokenListEmpty = 2; // the owner index lags: both program listings come back empty once
  const sell = await copy(await event(trader.id, "sell"));
  assert.equal(sell.status, "filled", sell.reason ?? "");
  assert.equal(await prisma.position.count({ where: { agentId: agent.id } }), 0);
  const a = await prisma.agent.findUniqueOrThrow({ where: { id: agent.id } });
  // proceeds 5M tokens × 30k = 0.15 SOL (less the network fee) vs cost ≈ 0.1003 → 5% of the profit is owed
  assert.ok(a.feeOwedSol > 0.002 && a.feeOwedSol < 0.003, String(a.feeOwedSol));
  assert.equal(sell.feeSol, a.feeOwedSol);
});

test("F5: a recent sleeve whose tokens are not visible is parked for a retry, never cleared", async () => {
  const { agent, trader } = await seedAgent();
  await copy(await event(trader.id, "buy"));
  chain.accounts.delete(ataOf(agent.depositAddress, MINT)); // every read now says zero
  const sell = await copy(await event(trader.id, "sell"));
  assert.equal(sell.status, "retrying");
  assert.equal(await prisma.position.count({ where: { agentId: agent.id } }), 1);
  await retry.dropSellRetry(sell.id);
});

test("F6: a sell whose quote fails is parked and retried to a fill", async () => {
  const { agent, trader } = await seedAgent();
  await copy(await event(trader.id, "buy"));
  jup.failQuotes = 1;
  const sell = await copy(await event(trader.id, "sell"));
  assert.equal(sell.status, "retrying");
  const [rec] = (await retry.loadSellRetries()).filter((r) => r.tradeId === sell.id);
  assert.ok(rec);
  assert.equal(rec.attempt, 1);
  await queue.enqueueForAgent(agent.id, () => exec.retryCopySell(rec));
  const done = await prisma.copyTrade.findUniqueOrThrow({ where: { id: sell.id } });
  assert.equal(done.status, "filled", done.reason ?? "");
  assert.equal((await retry.loadSellRetries()).filter((r) => r.tradeId === sell.id).length, 0);
  assert.equal(await prisma.position.count({ where: { agentId: agent.id } }), 0);
});

test("F6: retries stop after the window with a clear reason", async () => {
  const { agent, trader } = await seedAgent();
  await copy(await event(trader.id, "buy"));
  jup.failQuotes = 1;
  const sell = await copy(await event(trader.id, "sell"));
  const [rec] = (await retry.loadSellRetries()).filter((r) => r.tradeId === sell.id);
  await queue.enqueueForAgent(agent.id, () => exec.retryCopySell({ ...rec!, firstAt: Date.now() - retry.SELL_RETRY_WINDOW_MS - 1 }));
  const done = await prisma.copyTrade.findUniqueOrThrow({ where: { id: sell.id } });
  assert.equal(done.status, "failed");
  assert.match(done.reason ?? "", /exit failed after 1 attempt/);
  assert.equal(await prisma.position.count({ where: { agentId: agent.id } }), 1, "the sleeve stays for close-all");
});

test("F2: close-all adopts tokens the agent bought but never recorded, sells them, and leaves spam alone", async () => {
  const { agent, trader } = await seedAgent();
  const spamMint = Keypair.generate().publicKey.toBase58();
  chain.setToken(ataOf(agent.depositAddress, MINT), { mint: MINT, owner: agent.depositAddress, amount: BigInt(4_000) });
  chain.setToken(Keypair.generate().publicKey.toBase58(), { mint: spamMint, owner: agent.depositAddress, amount: BigInt(99) });
  // The agent's own buy of MINT landed but was never booked (no sleeve).
  await prisma.copyTrade.create({
    data: { agentId: agent.id, traderId: trader.id, side: "buy", mint: MINT, status: "failed", signature: "landedButUnrecordedSig", reason: "x" },
  });
  const result = await queue.enqueueForAgent(agent.id, () => exec.sellAllPositions(agent));
  assert.equal(result.sold, 1, JSON.stringify(result));
  assert.equal(chain.tokenAmount(ataOf(agent.depositAddress, MINT)), BigInt(0));
  const adopted = await prisma.copyTrade.findFirstOrThrow({ where: { agentId: agent.id, reason: { startsWith: "adopted" } } });
  assert.equal(adopted.tokenRaw, "4000");
  assert.ok(adopted.solAmount > 0, "valued at market, so its later sale is not all 'profit'");
  const report = await prisma.kv.findUniqueOrThrow({ where: { key: `holdings:${agent.id}` } });
  assert.match(report.value, new RegExp(spamMint));
});
