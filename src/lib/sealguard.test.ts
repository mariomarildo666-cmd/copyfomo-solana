// Run: npx tsx --test src/lib/sealguard.test.ts
// Live funding guard (F12): no live agent is created or funded unless a fresh LIVE worker publishes the web's seal
// public key; an agent the worker can't open is never funded or activated.
import "./__testing__/env"; // first: keeps the real .env (keys, RPC URLs) out of this test
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createTestDatabase } from "./__testing__/db";
import { generateKeyPairSync } from "node:crypto";

// No static import of ./crypto (or anything that loads ./config) above: config reads COPYFOMO_MODE at import.
function generateSealKeypair(): { publicKey: string } {
  const der = generateKeyPairSync("x25519").publicKey.export({ format: "der", type: "spki" });
  return { publicKey: Buffer.from(der.subarray(der.length - 32)).toString("base64") };
}

const testDb = createTestDatabase();
const seal = generateSealKeypair();
process.env.COPYFOMO_MODE = "live";
process.env.WALLET_SEAL_PUBLIC_KEY = seal.publicKey;
process.env.PLATFORM_FEE_WALLET = "";

let prisma: typeof import("./db").prisma;
let kvSet: typeof import("./db").kvSet;
let guard: typeof import("./sealguard");
before(async () => {
  ({ prisma, kvSet } = await import("./db"));
  guard = await import("./sealguard");
});

after(async () => {
  await prisma.$disconnect();
  testDb.cleanup();
});

const status = async (p: Promise<unknown>): Promise<number | "ok"> => {
  try {
    await p;
    return "ok";
  } catch (err) {
    return (err as { status?: number }).status ?? -1;
  }
};

test("base64 and base64url spellings of one key compare equal; other keys don't", () => {
  const url = Buffer.from(seal.publicKey, "base64").toString("base64url");
  assert.ok(guard.sameSealPublicKey(seal.publicKey, url));
  assert.ok(!guard.sameSealPublicKey(seal.publicKey, generateSealKeypair().publicKey));
  assert.ok(!guard.sameSealPublicKey(seal.publicKey, "not-a-key"));
});

test("live: 503 without a heartbeat, with a stale one, a paper one or another seal key; ok with the matching key", async () => {
  assert.equal(await status(guard.assertWorkerCanOpenNewKeys()), 503, "no heartbeat");

  await kvSet("worker:heartbeat", { at: new Date().toISOString(), mode: "live", sealPublicKey: generateSealKeypair().publicKey });
  assert.equal(await status(guard.assertWorkerCanOpenNewKeys()), 503, "mismatched seal key");

  await kvSet("worker:heartbeat", { at: new Date().toISOString(), mode: "paper" });
  assert.equal(await status(guard.assertWorkerCanOpenNewKeys()), 503, "paper worker");

  await kvSet("worker:heartbeat", { at: new Date().toISOString(), mode: "live", sealPublicKey: Buffer.from(seal.publicKey, "base64").toString("base64url") });
  assert.equal(await status(guard.assertWorkerCanOpenNewKeys()), "ok");
  assert.equal(await status(guard.assertWorkerCanOpenNewKeys(Date.now() + 61_000)), 503, "stale heartbeat");
});

test("an agent key the worker could not open is never funded or activated", async () => {
  assert.equal(await status(guard.assertAgentKeyNotBroken("a1")), "ok", "not checked yet");
  assert.equal(await guard.agentKeyVerified("a1"), false, "activation waits for the worker's check");
  await kvSet("sealcheck:a1", { ok: false, error: "openSecret: authentication failed", at: new Date().toISOString() });
  assert.equal(await status(guard.assertAgentKeyNotBroken("a1")), 503);
  assert.equal(await guard.agentKeyVerified("a1"), false);
  await kvSet("sealcheck:a2", { ok: true, at: new Date().toISOString() });
  assert.equal(await guard.agentKeyVerified("a2"), true);
});
