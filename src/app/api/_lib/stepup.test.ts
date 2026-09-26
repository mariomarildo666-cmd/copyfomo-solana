// Run: npx tsx --test src/app/api/_lib/stepup.test.ts
// Finding F18: on a live agent, a session alone can't add a wallet to copy or raise sizing / slippage; the
// owner's wallet must sign exactly that change, once. Throwaway SQLite DB (nonces live in Kv).
import "../../../lib/__testing__/env"; // first: keeps the real .env (keys, RPC URLs) out of this test
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign as edSign, type KeyObject } from "node:crypto";
import bs58 from "bs58";
import { createTestDatabase } from "../../../lib/__testing__/db";

const testDb = createTestDatabase();

type S = typeof import("./stepup");
let s: S;
let prisma: typeof import("@/lib/db").prisma;
let HttpError: typeof import("@/lib/http").HttpError;

before(async () => {
  s = await import("./stepup");
  ({ prisma } = await import("@/lib/db"));
  ({ HttpError } = await import("@/lib/http"));
});

after(async () => {
  await prisma?.$disconnect();
  testDb.cleanup();
});

function wallet(): { address: string; key: KeyObject } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const der = publicKey.export({ format: "der", type: "spki" });
  return { address: bs58.encode(der.subarray(der.length - 32)), key: privateKey };
}
const signText = (message: string, key: KeyObject) => bs58.encode(edSign(null, Buffer.from(message, "utf8"), key));

const A = "7LoRpjZ1wS3dG1v3CUKi2mz5eB6sBy1SFFtBNGeBENhz";
const B = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const current = { sizingMode: "fixed", fixedSol: 0.1, maxPerTradeSol: 1, slippageBps: 300, traders: [A] };
const agent = { id: "agent1", name: "moon.copy", slug: "moon.copy-abcd" };
const DOMAIN = "copyfomo.test:3001";

function is401(err: unknown) {
  assert.ok(err instanceof HttpError, `expected HttpError, got ${String(err)}`);
  assert.equal(err.status, 401);
  return true;
}

test("riskRaisingChanges: adding a wallet or raising size / max / slippage / changing sizing needs a signature", () => {
  assert.deepEqual(s.riskRaisingChanges(current, {}), []);
  // Lowering risk, keeping the same list, dropping a trader: no signature.
  assert.deepEqual(s.riskRaisingChanges(current, { fixedSol: 0.05, maxPerTradeSol: 0.5, slippageBps: 100, traders: [] }), []);
  assert.deepEqual(s.riskRaisingChanges(current, { traders: [A], sizingMode: "fixed" }), []);

  const lines = s.riskRaisingChanges(current, { traders: [A, B], sizingMode: "mirror", fixedSol: 25, maxPerTradeSol: 25, slippageBps: 5000 });
  assert.equal(lines.length, 5);
  assert.match(lines[0]!, new RegExp(`start copying wallet ${B}`));
  assert.ok(lines.some((l) => /sizing: fixed → mirror/.test(l)));
  assert.ok(lines.some((l) => /max per copy: 1 SOL → 25 SOL/.test(l)));
  assert.ok(lines.some((l) => /max slippage: 3% → 50%/.test(l)));
});

test("a signed confirmation authorizes exactly that change, once", async () => {
  const owner = wallet();
  const lines = s.riskRaisingChanges(current, { traders: [A, B], maxPerTradeSol: 5 });
  const ch = await s.createStepUp({ domain: DOMAIN, wallet: owner.address, agent, lines });
  assert.ok(ch.message.includes(`start copying wallet ${B}`) && ch.message.includes(owner.address) && ch.message.includes(`Nonce: ${ch.nonce}`));
  const confirm = { nonce: ch.nonce, signature: signText(ch.message, owner.key) };

  await s.verifyStepUp({ domain: DOMAIN, wallet: owner.address, agent, lines, confirm });
  // Replay: the nonce is consumed.
  await assert.rejects(s.verifyStepUp({ domain: DOMAIN, wallet: owner.address, agent, lines, confirm }), is401);
});

test("a stolen session can't confirm: wrong signer, other change, other agent, other site, expired", async () => {
  const owner = wallet();
  const thief = wallet();
  const lines = s.riskRaisingChanges(current, { traders: [A, B] });
  const fresh = async () => s.createStepUp({ domain: DOMAIN, wallet: owner.address, agent, lines });

  let ch = await fresh();
  await assert.rejects(
    s.verifyStepUp({ domain: DOMAIN, wallet: owner.address, agent, lines, confirm: { nonce: ch.nonce, signature: signText(ch.message, thief.key) } }),
    is401,
  );

  ch = await fresh();
  const other = s.riskRaisingChanges(current, { traders: [A, B], maxPerTradeSol: 25 });
  await assert.rejects(
    s.verifyStepUp({ domain: DOMAIN, wallet: owner.address, agent, lines: other, confirm: { nonce: ch.nonce, signature: signText(ch.message, owner.key) } }),
    is401,
  );

  ch = await fresh();
  await assert.rejects(
    s.verifyStepUp({ domain: DOMAIN, wallet: owner.address, agent: { ...agent, id: "agent2" }, lines, confirm: { nonce: ch.nonce, signature: signText(ch.message, owner.key) } }),
    is401,
  );

  ch = await fresh();
  await assert.rejects(
    s.verifyStepUp({ domain: "evil.example", wallet: owner.address, agent, lines, confirm: { nonce: ch.nonce, signature: signText(ch.message, owner.key) } }),
    is401,
  );

  const old = await s.createStepUp({ domain: DOMAIN, wallet: owner.address, agent, lines, now: new Date(Date.now() - s.STEP_UP_TTL_MS - 1_000) });
  await assert.rejects(
    s.verifyStepUp({ domain: DOMAIN, wallet: owner.address, agent, lines, confirm: { nonce: old.nonce, signature: signText(old.message, owner.key) } }),
    is401,
  );
});
