// Run: npx tsx --test src/app/api/_lib/traderGuard.test.ts
// Finding F13: infrastructure (FOMO relayer / marker, mints, programs, PDAs), agent deposit wallets and
// program-owned accounts can never be followed as a trader. Throwaway SQLite DB; the account probe is stubbed.
import "../../../lib/__testing__/env"; // first: keeps the real .env (keys, RPC URLs) out of this test
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { createTestDatabase } from "../../../lib/__testing__/db";

const testDb = createTestDatabase();

type Guard = typeof import("./traderGuard");
let g: Guard;
let prisma: typeof import("@/lib/db").prisma;
let HttpError: typeof import("@/lib/http").HttpError;
let seedWallet: string;
let excludedSeed: string | undefined;

before(async () => {
  g = await import("./traderGuard");
  ({ prisma } = await import("@/lib/db"));
  ({ HttpError } = await import("@/lib/http"));
  const { loadFomoSeed } = await import("@/lib/fomo-seed");
  const seed = loadFomoSeed();
  seedWallet = seed.find((e) => !e.exclude)!.wallet;
  excludedSeed = seed.find((e) => e.exclude)?.wallet;
});

after(async () => {
  await prisma?.$disconnect();
  testDb.cleanup();
});

beforeEach(() => g._resetTraderGuardCache());

const RELAYER = "AgmLJBMDCqWynYnQiPCuj9ewsNNsBJXyzoUhD9LJzN51";
const MARKER = "jitodontfront1111111111111111111TradeonFomo";
const TOKENKEG = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const JUP = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";

const freshWallet = () => Keypair.generate().publicKey.toBase58();
const pda = () => PublicKey.findProgramAddressSync([Buffer.from("bonding-curve"), Keypair.generate().publicKey.toBuffer()], new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"))[0].toBase58();

/** Probe stub: counts calls; answers from a table (default: account does not exist). */
function probe(table: Record<string, import("./traderGuard").AccountSnapshot | null | "error"> = {}) {
  const calls: string[] = [];
  const fn: import("./traderGuard").AccountProbe = async (a) => {
    calls.push(a);
    const v = table[a];
    if (v === "error") throw new Error("rpc down");
    return v ?? null;
  };
  return { fn, calls };
}

async function rejectsWith(p: Promise<unknown>, status: number, fields: Record<string, RegExp> = {}) {
  await assert.rejects(p, (err: unknown) => {
    assert.ok(err instanceof HttpError, `expected HttpError, got ${String(err)}`);
    assert.equal(err.status, status);
    for (const [k, re] of Object.entries(fields)) assert.match(err.fields?.[k] ?? "", re, `fields.${k}`);
    return true;
  });
}

test("every built-in denylist entry is a real 32-byte address", () => {
  for (const a of [...g.KNOWN_PROGRAMS, ...g.KNOWN_MINTS]) assert.equal(bs58.decode(a).length, 32, a);
});

test("F13: FOMO relayer / marker, programs, mints and routers are refused without any network call", async () => {
  const p = probe();
  await rejectsWith(g.assertFollowableTraders([RELAYER, MARKER, TOKENKEG, USDC, JUP], { probe: p.fn }), 400, {
    "traders.0.wallet": /relayer/,
    "traders.1.wallet": /marker/,
    "traders.2.wallet": /program/,
    "traders.3.wallet": /mint/,
    "traders.4.wallet": /router/,
  });
  assert.deepEqual(p.calls, []);
  assert.match(g.staticTraderRejection(RELAYER) ?? "", /relayer/);
});

test("F13: an off-curve address (PDA) can never trade, so it can't be followed", async () => {
  const p = probe();
  await rejectsWith(g.assertFollowableTraders([pda()], { probe: p.fn }), 400, { "traders.0.wallet": /program-owned address/ });
  assert.deepEqual(p.calls, []);
});

test("F13: another agent's deposit wallet is refused (no agents copying agents)", async () => {
  const deposit = freshWallet();
  await prisma.agent.create({
    data: { name: "a.copy", slug: `a.copy-${Date.now()}`, ownerKeyHash: "", payoutAddress: freshWallet(), depositAddress: deposit, sealedSecret: "x" },
  });
  await rejectsWith(g.assertFollowableTraders([freshWallet(), deposit], { probe: probe().fn }), 400, { "traders.1.wallet": /agent wallet/ });
});

test("wallets excluded from copyfomo (seed or indexer) are refused", async () => {
  const w = freshWallet();
  await prisma.fomoWallet.create({ data: { wallet: w, origin: "discovered", status: "excluded" } });
  await rejectsWith(g.assertFollowableTraders([w], { probe: probe().fn }), 400, { "traders.0.wallet": /excluded/ });
  if (excludedSeed) await rejectsWith(g.assertFollowableTraders([excludedSeed], { probe: probe().fn }), 400, { "traders.0.wallet": /excluded/ });
});

test("unknown wallets get one account check: token / program-owned / executable accounts are refused", async () => {
  const mint = freshWallet();
  const program = freshWallet();
  const pdaOwned = freshWallet();
  const p = probe({
    [mint]: { owner: TOKENKEG, executable: false, space: 82 },
    [program]: { owner: "BPFLoaderUpgradeab1e11111111111111111111111", executable: true, space: 36 },
    [pdaOwned]: { owner: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P", executable: false, space: 49 },
  });
  await rejectsWith(g.assertFollowableTraders([mint, program, pdaOwned], { probe: p.fn }), 400, {
    "traders.0.wallet": /token mint or token account/,
    "traders.1.wallet": /program/,
    "traders.2.wallet": /belongs to a program/,
  });
  assert.equal(p.calls.length, 3);
});

test("a fresh wallet (no account yet) or a System-owned wallet passes; the OK result is cached", async () => {
  const fresh = freshWallet();
  const used = freshWallet();
  const p = probe({ [used]: { owner: g.SYSTEM_PROGRAM, executable: false, space: 0 } });
  await g.assertFollowableTraders([fresh, used], { probe: p.fn });
  assert.deepEqual(p.calls.sort(), [fresh, used].sort());
  await g.assertFollowableTraders([fresh, used], { probe: p.fn });
  assert.equal(p.calls.length, 2, "second call answered from the cache");
});

test("known FOMO wallets (seed / evidence) and already-followed wallets skip the network check", async () => {
  const withEvidence = freshWallet();
  await prisma.fomoWallet.create({ data: { wallet: withEvidence, origin: "user", status: "candidate", evidenceSig: "sig" } });
  const followed = freshWallet();
  const p = probe({ [seedWallet]: "error", [withEvidence]: "error", [followed]: "error" });
  await g.assertFollowableTraders([seedWallet, withEvidence, followed], { probe: p.fn, alreadyFollowed: new Set([followed]) });
  assert.deepEqual(p.calls, []);
});

test("a wallet that can't be checked right now is a 503, never a silent pass", async () => {
  const w = freshWallet();
  await rejectsWith(g.assertFollowableTraders([w], { probe: probe({ [w]: "error" }).fn }), 503);
});
