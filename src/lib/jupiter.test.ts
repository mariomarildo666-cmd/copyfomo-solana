// Run: npx tsx --test src/lib/jupiter.test.ts
// Jupiter rate budget (F24) and the size-relative priority fee cap (F23). fetch is mocked: no network.
import "./__testing__/env"; // first: keeps the real .env (keys, RPC URLs) out of this test
import { after, test } from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL = "file:./__jupiter_test_no_such_dir__/none.db";
process.env.JUPITER_API_URL = "https://api.jup.ag";
process.env.JUPITER_API_KEY = "test-key-not-real";
process.env.JUPITER_RPS = "1000";
process.env.JUPITER_BURST = "1000";

const SOL = "So11111111111111111111111111111111111111112";
const MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const realFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = realFetch;
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function quoteBody(inputMint: string, outputMint: string, amount: string) {
  return {
    inputMint,
    outputMint,
    inAmount: amount,
    outAmount: "12345",
    otherAmountThreshold: "12000",
    swapMode: "ExactIn",
    slippageBps: 300,
    priceImpactPct: "0.01",
    routePlan: [{}],
  };
}

test("F23: priority fee cap scales with the trade size, with a floor and the absolute cap", async () => {
  const { priorityFeeCapLamports } = await import("./jupiter");
  const opts = { maxLamports: 2_000_000, bps: 500, floorLamports: 50_000 };
  // 0.004 SOL buy: 5% = 200,000 lamports (not the 2,000,000 absolute cap).
  assert.equal(priorityFeeCapLamports({ inputMint: SOL, outputMint: MINT, inAmount: "4000000", outAmount: "1" }, opts), 200_000);
  // 0.001 SOL buy: 5% = 50,000 = the floor.
  assert.equal(priorityFeeCapLamports({ inputMint: SOL, outputMint: MINT, inAmount: "1000000", outAmount: "1" }, opts), 50_000);
  // Tiny buy: the floor.
  assert.equal(priorityFeeCapLamports({ inputMint: SOL, outputMint: MINT, inAmount: "10000", outAmount: "1" }, opts), 50_000);
  // Big buy: the absolute cap.
  assert.equal(priorityFeeCapLamports({ inputMint: SOL, outputMint: MINT, inAmount: "5000000000", outAmount: "1" }, opts), 2_000_000);
  // Sell of ~0.004 SOL proceeds: twice the share (exits must land) = 400,000.
  assert.equal(priorityFeeCapLamports({ inputMint: MINT, outputMint: SOL, inAmount: "999", outAmount: "4000000" }, opts), 400_000);
  // No SOL leg: the absolute cap.
  assert.equal(priorityFeeCapLamports({ inputMint: MINT, outputMint: MINT, inAmount: "1", outAmount: "1" }, opts), 2_000_000);
});

test("F24: a 429 pauses the budget until x-ratelimit-reset and the quote is retried", async () => {
  const { getQuote } = await import("./jupiter");
  let calls = 0;
  const sentKeys: (string | null)[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls++;
    sentKeys.push(new Headers(init?.headers).get("x-api-key"));
    if (calls === 1) {
      return new Response('{"code":429,"message":"[API Gateway] Too many requests"}', {
        status: 429,
        headers: { "x-ratelimit-reset": String(Math.ceil((Date.now() + 700) / 1000)) },
      });
    }
    const url = new URL(String(input));
    return Response.json(quoteBody(url.searchParams.get("inputMint")!, url.searchParams.get("outputMint")!, url.searchParams.get("amount")!));
  }) as typeof fetch;
  const t0 = Date.now();
  const q = await getQuote({ inputMint: SOL, outputMint: MINT, amount: BigInt(4_000_000), slippageBps: 300 });
  assert.equal(q.outAmount, "12345");
  assert.equal(calls, 2);
  assert.ok(Date.now() - t0 >= 150, "waited for the reset instead of failing");
  assert.deepEqual(sentKeys, ["test-key-not-real", "test-key-not-real"]);
});

test("F24: the budget serves exits before entries before background calls", async () => {
  const { JupiterGate, JUP_PRIORITY } = await import("./jupiter");
  const gate = new JupiterGate(20, 1); // one token, then one every 50 ms
  const order: string[] = [];
  const far = Date.now() + 10_000;
  await gate.acquire(JUP_PRIORITY.background, far); // spend the burst
  const waits = [
    gate.acquire(JUP_PRIORITY.background, far).then(() => order.push("background")),
    gate.acquire(JUP_PRIORITY.entry, far).then(() => order.push("entry")),
    gate.acquire(JUP_PRIORITY.build, far).then(() => order.push("build")),
    gate.acquire(JUP_PRIORITY.exit, far).then(() => order.push("exit")),
  ];
  await Promise.all(waits);
  assert.deepEqual(order, ["exit", "build", "entry", "background"]);
});

test("F24: a call that can't get a slot before its deadline fails fast with a budget error", async () => {
  const { JupiterGate, JupiterBudgetError, JUP_PRIORITY } = await import("./jupiter");
  const gate = new JupiterGate(0.1, 1); // one token per 10 s
  await gate.acquire(JUP_PRIORITY.entry, Date.now() + 1_000);
  const t0 = Date.now();
  await assert.rejects(gate.acquire(JUP_PRIORITY.entry, Date.now() + 120, "jupiter quote"), (err: unknown) => err instanceof JupiterBudgetError);
  assert.ok(Date.now() - t0 < 1_000);
  gate.pause(Date.now() + 50);
  await sleep(1);
});

test("buildSwap asks for the size-relative cap and rejects a fee above it", async () => {
  const { buildSwap, getQuote } = await import("./jupiter");
  const { Keypair, TransactionMessage, VersionedTransaction, SystemProgram } = await import("@solana/web3.js");
  const agent = Keypair.generate();
  const tx = new VersionedTransaction(
    new TransactionMessage({
      payerKey: agent.publicKey,
      recentBlockhash: "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N",
      instructions: [SystemProgram.transfer({ fromPubkey: agent.publicKey, toPubkey: agent.publicKey, lamports: 1 })],
    }).compileToV0Message(),
  );
  let askedMax = -1;
  let reportFee = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/quote")) {
      return Response.json(quoteBody(url.searchParams.get("inputMint")!, url.searchParams.get("outputMint")!, url.searchParams.get("amount")!));
    }
    const body = JSON.parse(String(init?.body)) as { prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: number } } };
    askedMax = body.prioritizationFeeLamports.priorityLevelWithMaxLamports.maxLamports;
    return Response.json({ swapTransaction: Buffer.from(tx.serialize()).toString("base64"), prioritizationFeeLamports: reportFee });
  }) as typeof fetch;

  const q = await getQuote({ inputMint: SOL, outputMint: MINT, amount: BigInt(4_000_000), slippageBps: 300 });
  reportFee = 150_000;
  const built = await buildSwap(q, agent.publicKey.toBase58());
  assert.equal(askedMax, 200_000, "5% of a 0.004 SOL buy");
  assert.equal(built.priorityFeeLamports, 150_000);
  reportFee = 900_000;
  await assert.rejects(buildSwap(q, agent.publicKey.toBase58()), /exceeds the cap/);
});
