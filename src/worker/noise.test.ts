// Run: npx tsx --test src/worker/noise.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { NoiseBreaker } from "./noise";
import { RpcLimiter, RpcQueueFullError } from "./util";

test("noise breaker: trips above the per-minute limit, stays tripped, then releases", () => {
  const b = new NoiseBreaker({ maxPerMin: 10, tripMs: 60_000 });
  const t0 = 1_000_000;
  for (let i = 0; i < 10; i++) assert.equal(b.record("busy", 1, t0 + i), false);
  assert.equal(b.record("busy", 1, t0 + 11), true, "the 11th notification in a minute trips it");
  assert.ok(b.isTripped("busy", t0 + 12));
  assert.deepEqual([...b.tripped(t0 + 12)], ["busy"]);
  assert.equal(b.record("busy", 50, t0 + 13), false, "already tripped: no second trip");
  assert.ok(!b.isTripped("busy", t0 + 11 + 60_000), "released after tripMs");
  // A quiet trader never trips: the window resets every minute.
  for (let m = 0; m < 5; m++) for (let i = 0; i < 10; i++) assert.equal(b.record("trader", 1, t0 + m * 60_000 + i), false);
  assert.ok(!b.isTripped("trader", t0 + 5 * 60_000));
});

test("noise breaker: memory stays bounded under a flood of distinct wallets", () => {
  const b = new NoiseBreaker({ maxPerMin: 5, tripMs: 60_000, maxEntries: 100 });
  for (let i = 0; i < 10_000; i++) b.record(`w${i}`, 1, 1_000 + i * 70_000);
  assert.ok((b as unknown as { entries: Map<string, unknown> }).entries.size <= 100);
});

test("RpcLimiter refuses callers beyond its wait queue instead of growing without bound", async () => {
  const limiter = new RpcLimiter(1, undefined, 2);
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const running = limiter.run(() => gate);
  const waiting = [limiter.run(async () => 1), limiter.run(async () => 2)];
  assert.equal(limiter.queued, 2);
  await assert.rejects(limiter.run(async () => 3), RpcQueueFullError);
  release();
  await running;
  assert.deepEqual(await Promise.all(waiting), [1, 2]);
});
