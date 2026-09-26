// Run: npx tsx --test src/lib/helius.test.ts
// Helius client without the network: fetch is mocked. A fake key is set before the module loads.
import "./__testing__/env"; // first: keeps the real .env (keys, RPC URLs) out of this test
import { test } from "node:test";
import assert from "node:assert/strict";

const FAKE_KEY = "test-key-0000-not-real";
process.env.HELIUS_API_KEY = FAKE_KEY;
process.env.HELIUS_PLAN = "free"; // cap 30,000/day, 8 rps, concurrency 4 (1 slot reserved for P0/P1)
process.env.HELIUS_RPS = "1000"; // keep the token bucket out of the way; concurrency is what we test
// Never let this test's fake usage reach a real HeliusUsage row: point Prisma at a path SQLite cannot open.
process.env.DATABASE_URL = "file:./__helius_test_no_such_dir__/none.db";

type Helius = typeof import("./helius");
let h: Helius;
const realFetch = globalThis.fetch;

async function load(): Promise<Helius> {
  h ??= await import("./helius");
  return h;
}

function mockFetch(fn: (url: string, init?: RequestInit) => Promise<Response>) {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    fn(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, init)) as typeof fetch;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean, timeoutMs = 3_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > end) throw new Error("condition not reached in time");
    await sleep(5);
  }
}

test.after(() => {
  globalThis.fetch = realFetch;
});

test("URLs carry the key; redaction removes it everywhere", async () => {
  const { heliusRpcUrl, heliusWsUrl, redactUrl, redactSecrets } = await load();
  assert.ok(heliusRpcUrl().includes(FAKE_KEY));
  assert.ok(heliusWsUrl().startsWith("wss://"));
  assert.equal(redactUrl(heliusRpcUrl()).includes(FAKE_KEY), false);
  assert.equal(redactSecrets(`failed ${heliusRpcUrl()} key=${FAKE_KEY}`).includes(FAKE_KEY), false);
  assert.equal(redactSecrets("https://x.y/?api-key=abc&x=1"), "https://x.y/?api-key=***&x=1");
});

test("method prices and the FOMO label parser", async () => {
  const { methodCredits, parseFomoHandleLabel } = await load();
  assert.equal(methodCredits("getTransaction"), 1);
  assert.equal(methodCredits("getTransactionsForAddress"), 10);
  assert.equal(methodCredits("getProgramAccounts"), 10);
  assert.equal(parseFomoHandleLabel('"SolSwizzle" on Fomo'), "SolSwizzle");
  assert.equal(parseFomoHandleLabel('"retardedgains" on Pump.fun'), null);
  assert.equal(parseFomoHandleLabel("Frank DeGods"), null);
  assert.equal(parseFomoHandleLabel(null), null);
});

test("rpc: JSON-RPC result, JSON-RPC error, HTTP error — errors never contain the key", async () => {
  const { rpc, HeliusError, HELIUS_PRIORITY } = await load();
  mockFetch(async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { method: string };
    if (body.method === "ok") return Response.json({ jsonrpc: "2.0", id: 1, result: 42 });
    if (body.method === "bad") return Response.json({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: `nope ${FAKE_KEY}` } });
    return new Response(`boom api-key=${FAKE_KEY}`, { status: 403 });
  });
  assert.equal(await rpc<number>("ok", [], { priority: HELIUS_PRIORITY.live }), 42);
  await assert.rejects(rpc("bad", [], { priority: HELIUS_PRIORITY.live }), (err: unknown) => {
    assert.ok(err instanceof HeliusError);
    assert.equal(err.kind, "rpc");
    assert.equal(err.code, -32601);
    assert.equal(err.message.includes(FAKE_KEY), false);
    return true;
  });
  await assert.rejects(rpc("forbidden", [], { priority: HELIUS_PRIORITY.live }), (err: unknown) => {
    assert.ok(err instanceof HeliusError);
    assert.equal(err.kind, "http");
    assert.equal(err.status, 403);
    assert.equal(err.message.includes(FAKE_KEY), false);
    return true;
  });
});

test("429 → shared backoff, then retry succeeds", async () => {
  const { rpc, HELIUS_PRIORITY, heliusBackoffMs } = await load();
  let calls = 0;
  mockFetch(async () => {
    calls++;
    return calls === 1 ? new Response("slow down", { status: 429 }) : Response.json({ jsonrpc: "2.0", id: 1, result: "ok" });
  });
  const started = Date.now();
  const p = rpc<string>("getSlot", [], { priority: HELIUS_PRIORITY.live });
  await until(() => calls >= 1);
  const hitAt = Date.now();
  assert.ok(heliusBackoffMs() > 0, "everyone is paused during the backoff");
  assert.equal(await p, "ok");
  assert.equal(calls, 2);
  assert.ok(Date.now() - hitAt >= 400 && Date.now() - started >= 450, "waited the 500 ms backoff");
});

test("concurrency gate: P2–P4 leave a slot for P0/P1; P0 jumps the queue", async () => {
  const { rpc, heliusFetch, heliusRpcUrl, HELIUS_PRIORITY } = await load();
  let active = 0;
  let maxActive = 0;
  const order: string[] = [];
  mockFetch(async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { method: string };
    active++;
    maxActive = Math.max(maxActive, active);
    order.push(body.method);
    await sleep(body.method === "slow" ? 150 : 10);
    active--;
    return Response.json({ jsonrpc: "2.0", id: 1, result: body.method });
  });
  // 6 slow backfill calls: at most concurrency − reserved = 3 run at once.
  const slow = Array.from({ length: 6 }, () => rpc("slow", [], { priority: HELIUS_PRIORITY.backfill }));
  await until(() => active === 3);
  await sleep(20);
  assert.equal(active, 3, "one slot stays free for P0/P1");
  // A copy-engine call gets the reserved slot immediately.
  const t0 = Date.now();
  const res = await heliusFetch(heliusRpcUrl(), { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "p0" }) });
  assert.equal(res.status, 200);
  assert.ok(Date.now() - t0 < 100, "P0 did not wait for the backfill");
  await Promise.all(slow);
  assert.ok(maxActive <= 4);
  assert.equal(order.indexOf("p0") < 4, true, "P0 ran before the queued backfill calls");
});

test("F25: a burst of concurrent P2 429s escalates the backoff once and never delays P0", async () => {
  const { rpc, heliusFetch, heliusRpcUrl, HELIUS_PRIORITY, heliusBackoffMs } = await load();
  await until(() => heliusBackoffMs() === 0, 5_000);
  let p2Hits = 0;
  mockFetch(async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { method: string };
    if (body.method === "p0") return Response.json({ jsonrpc: "2.0", id: 1, result: "p0" });
    p2Hits++;
    await sleep(20);
    return new Response("slow down", { status: 429 });
  });
  // 3 backfill calls in flight together (free plan: 4 slots, 1 reserved) all get a 429.
  await Promise.all(
    Array.from({ length: 3 }, () => rpc("bf", [], { priority: HELIUS_PRIORITY.backfill, retries: 0 }).catch(() => "rejected")),
  );
  assert.equal(p2Hits, 3);
  const p2 = heliusBackoffMs(HELIUS_PRIORITY.backfill);
  assert.ok(p2 > 0 && p2 <= 500, `one backoff step (500 ms), got ${p2} ms`);
  assert.equal(heliusBackoffMs(HELIUS_PRIORITY.copy), 0, "P0 is not paused by 429s other priorities saw");
  assert.equal(heliusBackoffMs(HELIUS_PRIORITY.live), 0, "nor is P1");
  const t0 = Date.now();
  const res = await heliusFetch(heliusRpcUrl(), { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "p0" }) });
  assert.equal(res.status, 200);
  assert.ok(Date.now() - t0 < 100, "P0 went straight through");
  await until(() => heliusBackoffMs() === 0, 5_000);
});

test("Gate: scoped pauses, one escalation per window, P0 429s pause everyone", async () => {
  const { Gate, HELIUS_PRIORITY } = await load();
  const g = new Gate(1_000, 4);
  for (let i = 0; i < 7; i++) g.rateLimited(HELIUS_PRIORITY.backfill);
  assert.equal(g.backoffStep(HELIUS_PRIORITY.backfill), 500, "7 simultaneous 429s = one step, not 30 s");
  assert.equal(g.backoff(HELIUS_PRIORITY.copy), 0);
  assert.equal(g.backoff(HELIUS_PRIORITY.live), 0);
  assert.ok(g.backoff(HELIUS_PRIORITY.discovery) > 0 && g.backoff(HELIUS_PRIORITY.identity) > 0, "lower priorities pause too");
  await sleep(520);
  g.rateLimited(HELIUS_PRIORITY.backfill);
  assert.equal(g.backoffStep(HELIUS_PRIORITY.backfill), 1_000, "a 429 after the window escalates");
  g.ok(HELIUS_PRIORITY.backfill);
  assert.equal(g.backoffStep(HELIUS_PRIORITY.backfill), 0);
  g.rateLimited(HELIUS_PRIORITY.copy);
  assert.ok(g.backoff(HELIUS_PRIORITY.copy) > 0 && g.backoff(HELIUS_PRIORITY.identity) > 0, "the key itself is saturated");
});

test("heliusFetch meters batch items individually; other hosts pass straight through", async () => {
  const { heliusFetch, heliusRpcUrl, meter } = await load();
  mockFetch(async () => Response.json([{ result: 1 }, { result: 2 }]));
  const before = meter.snapshot().local;
  await heliusFetch(heliusRpcUrl(), {
    method: "POST",
    body: JSON.stringify([
      { jsonrpc: "2.0", id: 1, method: "getTransaction" },
      { jsonrpc: "2.0", id: 2, method: "getProgramAccounts" },
    ]),
  });
  const after = meter.snapshot().local;
  assert.equal(after.credits - before.credits, 11);
  assert.equal(after.calls - before.calls, 2);
  assert.equal(after.byPriority[0] - before.byPriority[0], 11);
  await heliusFetch("https://api.mainnet-beta.solana.com", { method: "POST", body: "{}" });
  assert.equal(meter.snapshot().local.credits, after.credits, "non-Helius hosts are not metered");
});

test("WebSocket bytes and logs notifications are metered", async () => {
  const { meter, HELIUS_CREDITS } = await load();
  const before = meter.snapshot().local.credits;
  meter.recordWsBytes(100_000);
  meter.recordLogsNotification();
  const delta = meter.snapshot().local.credits - before;
  assert.ok(Math.abs(delta - (2 + HELIUS_CREDITS.logsNotificationBytes * HELIUS_CREDITS.wsPerByte)) < 1e-9);
});

test("daily cap: ≥70 % pauses P3/P4, ≥85 % pauses P2, P0/P1 always run", async () => {
  const { meter, canSpend, rpc, HELIUS_PRIORITY, HeliusError, throttleState } = await load();
  const cap = 30_000;
  meter.record(0.71 * cap - meter.creditsToday(), HELIUS_PRIORITY.live, 0);
  assert.equal(canSpend(HELIUS_PRIORITY.identity, 1), false);
  assert.equal(canSpend(HELIUS_PRIORITY.discovery, 1), false);
  assert.equal(canSpend(HELIUS_PRIORITY.backfill, 1), true);
  assert.deepEqual(throttleState().pausedPriorities, [3, 4]);
  await assert.rejects(rpc("x", [], { priority: HELIUS_PRIORITY.discovery }), (err: unknown) => err instanceof HeliusError && err.kind === "throttled");

  meter.record(0.86 * cap - meter.creditsToday(), HELIUS_PRIORITY.live, 0);
  assert.equal(canSpend(HELIUS_PRIORITY.backfill, 1), false);
  assert.equal(canSpend(HELIUS_PRIORITY.live, 1), true);

  meter.record(1.2 * cap - meter.creditsToday(), HELIUS_PRIORITY.live, 0);
  assert.equal(throttleState().throttled, true);
  assert.equal(canSpend(HELIUS_PRIORITY.copy, 1_000), true);
  assert.equal(canSpend(HELIUS_PRIORITY.live, 1_000), true);
});
