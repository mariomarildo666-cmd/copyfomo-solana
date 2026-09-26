// Run: npx tsx --test src/worker/fomo/stream.test.ts
// Live stream (logs mode) against a local mock JSON-RPC WebSocket server — no network, no Helius, no DB:
//  - a failed logsSubscribe is retried; until then the wallet has no live coverage (reads partial), and the
//    stretch since the failure is gap-filled once it succeeds; a subscribe ack after the timeout is unsubscribed;
//  - a server-side drop is part of the resume point while down and gap-filled after the reconnect; a stop is not;
//  - watched wallets are subscribed by the indexer itself; the restart stretch is gap-filled once subscribed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import { state } from "./state";
import { LogsStream, StreamController, type SocketEnv } from "./stream";

interface Mock {
  env: SocketEnv;
  subscribes: Map<string, number>;
  unsubscribes: number[];
  lateIds: number[];
  dropAll(): void;
  close(): Promise<void>;
}

async function startMock(opts: { rejectFirst?: string[]; slowFirstMs?: Record<string, number> } = {}): Promise<Mock> {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(wss, "listening");
  const url = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`;
  const sockets = new Set<WebSocket>();
  const reject = new Set(opts.rejectFirst ?? []);
  const slow = opts.slowFirstMs ?? {};
  let nextSub = 100;
  const m: Mock = {
    env: { url: () => url, onConnect: () => undefined, onBytes: () => undefined },
    subscribes: new Map(),
    unsubscribes: [],
    lateIds: [],
    dropAll: () => {
      for (const s of sockets) s.terminate();
    },
    close: async () => {
      for (const s of sockets) s.terminate();
      await new Promise<void>((r) => wss.close(() => r()));
    },
  };
  wss.on("connection", (ws) => {
    sockets.add(ws);
    ws.on("close", () => sockets.delete(ws));
    ws.on("message", (data) => {
      const msg = JSON.parse(String(data)) as { id: number; method: string; params: unknown[] };
      if (msg.method === "logsSubscribe") {
        const wallet = (msg.params[0] as { mentions: string[] }).mentions[0]!;
        const n = (m.subscribes.get(wallet) ?? 0) + 1;
        m.subscribes.set(wallet, n);
        if (n === 1 && reject.has(wallet)) {
          ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "subscription limit" } }));
          return;
        }
        const sub = nextSub++;
        const reply = () => ws.readyState === ws.OPEN && ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: sub }));
        const delay = n === 1 ? slow[wallet] : undefined;
        if (delay) {
          m.lateIds.push(sub);
          setTimeout(reply, delay);
        } else {
          reply();
        }
      } else if (msg.method === "logsUnsubscribe") {
        m.unsubscribes.push(msg.params[0] as number);
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: true }));
      }
    });
  });
  return m;
}

async function waitUntil(cond: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

function resetState(): void {
  state.stopping = false;
  state.connected = false;
  state.streamReady = false;
  state.lastMsgAt = null;
  state.tracked = new Map();
  state.followed = new Set();
  state.watched = new Set();
  state.covered = new Set();
  state.uncovered = new Map();
  state.subscribeFailed = new Map();
}

type Gap = { since: number; wallets: string[] | null; reason: string };

test("logs mode: a failed logsSubscribe is retried; no live coverage until then; its stretch is gap-filled after", async () => {
  resetState();
  const mock = await startMock({ rejectFirst: ["W_REJECT"], slowFirstMs: { W_SLOW: 400 } });
  const gaps: Gap[] = [];
  const stream = new LogsStream((since, wallets, reason) => gaps.push({ since, wallets, reason }), undefined, {
    env: mock.env,
    requestTimeoutMs: 150,
    retryBaseMs: 300,
    escalateMs: 60_000,
  });
  const t0 = Date.now();
  try {
    stream.start(["W_A", "W_B", "W_REJECT", "W_SLOW"]);
    // Both failed (one rejected, one timed out), the socket is up and the first retry has not run yet.
    await waitUntil(() => state.connected && state.subscribeFailed.has("W_REJECT") && state.subscribeFailed.has("W_SLOW"), "both failures");
    assert.equal(state.isLiveCovered("W_A"), true);
    assert.equal(state.isLiveCovered("W_REJECT"), false, "a failed wallet is not live-covered (its backfill must wait)");
    const lostAt = state.liveHoleSince("W_REJECT");
    assert.ok(lostAt !== null && lostAt >= t0, "stats read partial from the failure time");
    assert.ok(stream.openGapSince() !== null && stream.openGapSince()! <= lostAt, "an unescalated failure holds the resume point back");

    // The retry (not a reconnect) subscribes them.
    await waitUntil(() => state.subscribeFailed.size === 0 && state.covered.size === 4, "retry succeeded");
    assert.equal(mock.subscribes.get("W_REJECT"), 2);
    assert.equal(mock.subscribes.get("W_SLOW"), 2);
    assert.equal(mock.subscribes.get("W_A"), 1);
    const rejected = gaps.find((g) => g.wallets?.includes("W_REJECT"));
    assert.ok(rejected, "the stretch since the failure is handed to gap-fill");
    assert.equal(rejected.reason, "logs subscribe recovered");
    assert.equal(rejected.since, lostAt);
    assert.ok(gaps.some((g) => g.wallets?.includes("W_SLOW")));
    assert.equal(stream.openGapSince(), null);

    // The first W_SLOW ack arrives after its timeout: that orphan subscription is unsubscribed.
    await waitUntil(() => mock.unsubscribes.includes(mock.lateIds[0]!), "late ack unsubscribed");
  } finally {
    await stream.stop();
    await mock.close();
  }
});

test("logs mode: a dropped connection is part of the resume point, then gap-filled from its last frame; a stop is not an outage", async () => {
  resetState();
  const mock = await startMock();
  const gaps: Gap[] = [];
  const stream = new LogsStream((since, wallets, reason) => gaps.push({ since, wallets, reason }), undefined, { env: mock.env, requestTimeoutMs: 1_000 });
  try {
    stream.start(["W_A", "W_B"]);
    await waitUntil(() => state.connected && state.covered.size === 2, "subscribed");
    assert.equal(stream.openGapSince(), null);
    const beforeDrop = Date.now();
    mock.dropAll();
    await waitUntil(() => !state.connected, "disconnected");
    const open = stream.openGapSince();
    assert.ok(open !== null && open <= beforeDrop, "the outage start is part of the resume point while down");
    await waitUntil(() => gaps.some((g) => g.reason === "reconnect(logs)"), "reconnect gap-fill", 8_000);
    const g = gaps.find((x) => x.reason === "reconnect(logs)")!;
    assert.deepEqual([...(g.wallets ?? [])].sort(), ["W_A", "W_B"]);
    assert.equal(g.since, open);
    assert.equal(stream.openGapSince(), null);
  } finally {
    await stream.stop();
    await mock.close();
  }
  assert.equal(stream.openGapSince(), null, "a deliberate stop records no outage");
});

test("controller (logs mode): watched wallets are subscribed by the indexer; the restart stretch is gap-filled once subscribed", async () => {
  resetState();
  state.tracked = new Map([
    ["W_SEED", { origin: "seed", trackedAtMs: 1, lastTradeAtMs: null }],
    ["W_WATCHED", { origin: "discovered", trackedAtMs: 1, lastTradeAtMs: null }],
  ]);
  state.watched = new Set(["W_WATCHED"]);
  state.followed = new Set(["W_WATCHED"]);
  const mock = await startMock();
  const gaps: Gap[] = [];
  const resumeFrom = Date.now() - 5 * 60_000;
  const c = new StreamController((since, wallets, reason) => gaps.push({ since, wallets, reason }), { resumeFromMs: resumeFrom, logs: { env: mock.env } });
  assert.equal(c.openGapSince(), resumeFrom, "the previous run's resume point is kept until handed to gap-fill");
  try {
    c.start("logs");
    await waitUntil(() => state.connected && state.covered.has("W_WATCHED") && state.covered.has("W_SEED"), "subscribed");
    assert.equal(mock.subscribes.get("W_WATCHED"), 1, "the copy engine's watch is not a complete source: subscribe it too");
    assert.equal(state.streamReady, true);
    await waitUntil(() => gaps.length > 0, "restart gap-fill");
    assert.deepEqual(gaps, [{ since: resumeFrom, wallets: null, reason: "restart" }]);
    assert.equal(c.openGapSince(), null);
  } finally {
    await c.stop();
    await mock.close();
  }
});
