// Run: npx tsx --test src/lib/fomo.test.ts
// fomo.ts against a throwaway SQLite DB: following never bypasses the tracked cap (F14), re-tracking resets
// the backfill (F32), and the trader detail reads the NEWEST swaps (F29).
import "./__testing__/env"; // first: keeps the real .env (keys, RPC URLs) out of this test
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { createTestDatabase } from "./__testing__/db";

const testDb = createTestDatabase();

type Fomo = typeof import("./fomo");
let fomo: Fomo;
let prisma: typeof import("./db").prisma;
let loadFomoSeed: typeof import("./fomo-seed").loadFomoSeed;

before(async () => {
  fomo = await import("./fomo");
  ({ prisma } = await import("./db"));
  ({ loadFomoSeed } = await import("./fomo-seed"));
});

after(async () => {
  await prisma?.$disconnect();
  testDb.cleanup();
});

const addr = () => Keypair.generate().publicKey.toBase58();
const DAY = 86_400_000;

test("F14: following a new wallet records a candidate — it is never marked tracked (no cap bypass)", async () => {
  const wallet = addr();
  const trader = await fomo.upsertTrader({ wallet, handle: "someone_famous", displayName: "Fake Label" });
  assert.equal(trader.wallet, wallet);
  assert.equal(trader.handle, null, "client labels are ignored");
  const w = await prisma.fomoWallet.findUniqueOrThrow({ where: { wallet } });
  assert.equal(w.status, "candidate");
  assert.equal(w.origin, "user");
  assert.equal(w.trackedAt, null);
});

test("F14/F32: following an existing (demoted) candidate leaves it a candidate with its state untouched", async () => {
  const wallet = addr();
  const coveredFrom = new Date(Date.now() - 50 * DAY);
  await prisma.fomoWallet.create({
    data: { wallet, origin: "discovered", status: "candidate", backfillState: "done", coveredFrom, trackedAt: new Date(Date.now() - 60 * DAY) },
  });
  await fomo.upsertTrader({ wallet });
  const w = await prisma.fomoWallet.findUniqueOrThrow({ where: { wallet } });
  assert.equal(w.status, "candidate", "the worker's refreshTracked promotes followed wallets (with the reset)");
  assert.equal(w.backfillState, "done");
});

test("F32: a seed wallet re-entering the tracked set gets a clean-slate backfill", async () => {
  const seed = loadFomoSeed().find((e) => !e.exclude);
  assert.ok(seed, "the seed file has a tracked wallet");
  const old = new Date(Date.now() - 50 * DAY);
  await prisma.fomoWallet.upsert({
    where: { wallet: seed.wallet },
    create: { wallet: seed.wallet, origin: "seed", status: "candidate", backfillState: "done", backfillCursor: "cursor", coveredFrom: old, gapFrom: old, trackedAt: old, statsDirty: false },
    update: { status: "candidate", backfillState: "done", backfillCursor: "cursor", coveredFrom: old, gapFrom: old, trackedAt: old, statsDirty: false },
  });
  const t0 = Date.now();
  await fomo.syncFomoSeed();
  const w = await prisma.fomoWallet.findUniqueOrThrow({ where: { wallet: seed.wallet } });
  assert.equal(w.status, "tracked");
  assert.equal(w.backfillState, "pending");
  assert.equal(w.backfillCursor, null);
  assert.equal(w.coveredFrom, null, "never claims full coverage over the time it wasn't indexed");
  assert.equal(w.gapFrom, null);
  assert.ok(w.trackedAt && w.trackedAt.getTime() >= t0 - 1000, "trackedAt restarts now");
  assert.equal(w.statsDirty, true);

  // Already tracked: a second sync must NOT reset an ongoing / finished backfill.
  await prisma.fomoWallet.update({ where: { wallet: seed.wallet }, data: { backfillState: "done", coveredFrom: old } });
  await fomo.syncFomoSeed();
  const again = await prisma.fomoWallet.findUniqueOrThrow({ where: { wallet: seed.wallet } });
  assert.equal(again.backfillState, "done");
  assert.equal(again.coveredFrom?.getTime(), old.getTime());
});

test("F29: trader detail shows the newest trades and per-mint PnL even past 20,000 stored swaps", async () => {
  const wallet = addr();
  const OLD = addr();
  const NEW = addr();
  const now = Date.now();
  await prisma.fomoWallet.create({
    data: { wallet, origin: "user", status: "tracked", backfillState: "done", coveredFrom: new Date(now - 60 * DAY), trackedAt: new Date(now - 60 * DAY) },
  });
  const OLD_ROWS = 20_020;
  const base = now - 45 * DAY;
  const rows = Array.from({ length: OLD_ROWS }, (_, i) => ({
    signature: `old${i}`,
    wallet,
    slot: 1_000 + i,
    txIndex: 0,
    blockTime: new Date(base + i * 60_000),
    kind: i % 2 === 0 ? "buy" : "sell",
    mint: OLD,
    tokenRaw: "1000000",
    decimals: 6,
    usd: 10,
    router: "dflow",
    source: "backfill",
  }));
  for (let i = 0; i < rows.length; i += 5_000) await prisma.fomoSwap.createMany({ data: rows.slice(i, i + 5_000) });
  // The newest trades: buy 100 USD of NEW, sell half for 80 USD (+30), sell the rest for 70 USD (+20).
  const newest = [
    { signature: "new-buy", kind: "buy", tokenRaw: "2000000", usd: 100, t: now - 3 * 3600_000, slot: 900_000 },
    { signature: "new-sell-1", kind: "sell", tokenRaw: "1000000", usd: 80, t: now - 2 * 3600_000, slot: 900_001 },
    { signature: "new-sell-2", kind: "sell", tokenRaw: "1000000", usd: 70, t: now - 3600_000, slot: 900_002 },
  ];
  await prisma.fomoSwap.createMany({
    data: newest.map((r) => ({
      signature: r.signature,
      wallet,
      slot: r.slot,
      txIndex: 0,
      blockTime: new Date(r.t),
      kind: r.kind,
      mint: NEW,
      tokenRaw: r.tokenRaw,
      decimals: 6,
      usd: r.usd,
      router: "dflow",
      source: "stream",
    })),
  });

  const detail = await fomo.getTraderDetail(wallet);
  assert.ok(detail);
  assert.equal(detail.recent.length, 50);
  assert.deepEqual(
    detail.recent.slice(0, 3).map((r) => r.signature),
    ["new-sell-2", "new-sell-1", "new-buy"],
    "latest trades are the newest, not the oldest 20k",
  );
  const newMint = detail.perMint.find((m) => m.mint === NEW);
  assert.ok(newMint, "a mint traded today is in the 30d per-mint breakdown");
  assert.ok(Math.abs(newMint.realizedPnlUsd - 50) < 1e-6, `realized +50 USD, got ${newMint.realizedPnlUsd}`);
  assert.ok(Math.abs((detail.recent[0]!.realizedPnlUsd ?? NaN) - 20) < 1e-6, "the newest sell carries its realized PnL");
});
