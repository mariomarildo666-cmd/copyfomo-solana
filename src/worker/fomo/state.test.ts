// Run: npx tsx --test src/worker/fomo/state.test.ts
// refreshTracked (findings F13 / F14) against a throwaway SQLite DB: only FUNDED agents' wallets are indexed,
// infrastructure never is (and is swept to excluded), user promotions are capped per day, and a user wallet nobody
// funded follows any more is demoted at once when it never ranked.
import "@/lib/__testing__/env"; // first: keeps the real .env out of this test
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { createTestDatabase } from "@/lib/__testing__/db";

const testDb = createTestDatabase();
process.env.FOMO_MAX_TRACKED = "40"; // user cap 20 total, 10 per day
process.env.HELIUS_API_KEY = "";

const RELAYER = "AgmLJBMDCqWynYnQiPCuj9ewsNNsBJXyzoUhD9LJzN51";
const addr = () => Keypair.generate().publicKey.toBase58();

let prisma: typeof import("@/lib/db").prisma;
let st: typeof import("./state");

before(async () => {
  ({ prisma } = await import("@/lib/db"));
  st = await import("./state");
});
after(async () => {
  await prisma.$disconnect();
  testDb.cleanup();
});

let n = 0;
async function agentFollowing(status: string, wallets: string[]): Promise<string> {
  n++;
  const a = await prisma.agent.create({
    data: {
      name: `t${n}.copy`,
      slug: `t${n}-copy`,
      ownerKeyHash: "",
      ownerWallet: addr(),
      payoutAddress: addr(),
      depositAddress: addr(),
      sealedSecret: "x",
      mode: "paper",
      status,
      follows: {
        create: await Promise.all(
          wallets.map(async (wallet) => ({
            trader: { connectOrCreate: { where: { wallet }, create: { wallet } } },
          })),
        ),
      },
    },
  });
  return a.id;
}

test("only funded agents' wallets are indexed; infrastructure never is; user promotions are capped per day", async () => {
  const unfunded = addr();
  await agentFollowing("awaiting_deposit", [unfunded]);
  const users = Array.from({ length: 12 }, addr);
  await agentFollowing("active", [...users.slice(0, 6), RELAYER]);
  await agentFollowing("paused", users.slice(6));
  // A relayer row created by something older must be swept to excluded.
  await prisma.fomoWallet.create({ data: { wallet: RELAYER, origin: "user", status: "tracked", trackedAt: new Date() } });

  await st.refreshTracked();
  assert.ok(!st.state.followed.has(unfunded), "an unfunded agent's wallet is not 'followed'");
  assert.ok(!st.state.tracked.has(unfunded));
  assert.ok(!st.state.followed.has(RELAYER) && !st.state.tracked.has(RELAYER), "infrastructure is never followed or tracked");
  assert.equal((await prisma.fomoWallet.findUniqueOrThrow({ where: { wallet: RELAYER } })).status, "excluded");
  const trackedUsers = users.filter((w) => st.state.tracked.has(w));
  assert.equal(trackedUsers.length, st.userPromotionsPerDay(), "at most the daily user allowance is promoted");
  assert.equal(await prisma.fomoWallet.count({ where: { origin: "user", status: "tracked" } }), st.userPromotionsPerDay());
});

test("a user wallet no funded agent follows any more is demoted at once unless it ever ranked", async () => {
  const [a, b] = [addr(), addr()];
  const now = new Date();
  await prisma.fomoWallet.createMany({
    data: [
      { wallet: a, origin: "user", status: "tracked", trackedAt: now },
      { wallet: b, origin: "user", status: "tracked", trackedAt: now },
    ],
  });
  // b was eligible once (stats.ts records that in the Kv "last eligible" map).
  await prisma.kv.upsert({
    where: { key: "fomo:lastEligibleAt" },
    create: { key: "fomo:lastEligibleAt", value: JSON.stringify({ [b]: now.toISOString() }) },
    update: { value: JSON.stringify({ [b]: now.toISOString() }) },
  });
  await st.refreshTracked();
  assert.equal((await prisma.fomoWallet.findUniqueOrThrow({ where: { wallet: a } })).status, "candidate");
  assert.ok(!st.state.tracked.has(a));
  assert.equal((await prisma.fomoWallet.findUniqueOrThrow({ where: { wallet: b } })).status, "tracked", "a wallet that ranked keeps the 14-day rule");
});
