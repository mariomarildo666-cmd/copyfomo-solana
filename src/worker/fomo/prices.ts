// Unrealized value of open FOMO positions (design §4.2 prices, §5.7): every 15 min, Jupiter prices (0 Helius
// credits) for the open positions of wallets ranked ≤ 100 in any window plus followed wallets, ≤ 500 mints a tick.
// Updates FomoPosition.valueUsd / pricedAt and FomoWalletStats.unrealizedPnlUsd (null when nothing is priced —
// never zero). The stats job reuses the prices through knownPrices(). Unrealized PnL never ranks.
// At startup seedPriceCache() warms the cache from the stored valuations (priced within the last hour), so the
// first stats pass after a restart — it runs before the first pricesTick — does not null every valuation.

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { getUsdPrices } from "@/lib/prices";
import { logger } from "../log";
import { HOUR_MS, unitPriceOf, unrealizedOf } from "./policy";
import { state } from "./state";

const log = logger("fomo-prices");

const TOP_RANK = 100;
const MAX_MINTS = 500;

const cache = new Map<string, { price: number; at: number }>();

/** USD per whole token for mints priced within `maxAgeMs`. */
export function knownPrices(maxAgeMs = HOUR_MS): Map<string, number> {
  const now = Date.now();
  const out = new Map<string, number>();
  for (const [mint, p] of cache) if (now - p.at <= maxAgeMs) out.set(mint, p.price);
  return out;
}

export function priceAt(mint: string): Date | null {
  const p = cache.get(mint);
  return p ? new Date(p.at) : null;
}

/** Warm the cache from FomoPosition valuations priced within `maxAgeMs` (startup). Returns the mints seeded. */
export async function seedPriceCache(maxAgeMs = HOUR_MS): Promise<number> {
  const rows = await prisma.fomoPosition.findMany({
    where: { valueUsd: { not: null }, pricedAt: { gte: new Date(Date.now() - maxAgeMs) } },
    select: { mint: true, rawAmount: true, decimals: true, valueUsd: true, pricedAt: true },
  });
  let seeded = 0;
  for (const r of rows) {
    const price = unitPriceOf(r.valueUsd, r.rawAmount, r.decimals);
    const at = r.pricedAt?.getTime();
    if (price === null || at === undefined) continue;
    const prev = cache.get(r.mint);
    if (prev && prev.at >= at) continue;
    if (!prev) seeded++;
    cache.set(r.mint, { price, at });
  }
  if (seeded > 0) log.debug("price cache warmed from stored valuations", { mints: seeded });
  return seeded;
}

const amountOf = (raw: string, decimals: number): number => {
  const n = Number(raw);
  return Number.isFinite(n) ? n / 10 ** decimals : 0;
};

export async function pricesTick(): Promise<void> {
  const ranked = await prisma.fomoWalletStats.findMany({ where: { rank: { lte: TOP_RANK } }, select: { wallet: true }, distinct: ["wallet"] });
  const wallets = [...new Set([...ranked.map((r) => r.wallet), ...[...state.followed].filter((w) => state.tracked.has(w))])];
  if (wallets.length === 0) return;

  const positions: Awaited<ReturnType<typeof prisma.fomoPosition.findMany>> = [];
  for (let i = 0; i < wallets.length; i += 500) {
    positions.push(...(await prisma.fomoPosition.findMany({ where: { wallet: { in: wallets.slice(i, i + 500) } } })));
  }
  if (positions.length === 0) return;

  // Most valuable positions first when the 500-mint budget binds.
  const byCost = new Map<string, number>();
  for (const p of positions) byCost.set(p.mint, (byCost.get(p.mint) ?? 0) + p.costUsd);
  const mints = [...byCost.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_MINTS).map(([m]) => m);
  const prices = await getUsdPrices(mints);
  const now = Date.now();
  for (const [mint, price] of Object.entries(prices)) cache.set(mint, { price, at: now });
  const priced = new Set(mints);

  const at = new Date(now);
  const ops: Prisma.PrismaPromise<unknown>[] = [];
  const perWallet = new Map<string, { costUsd: number; valueUsd: number | null }[]>();
  for (const p of positions) {
    const price = prices[p.mint];
    const valueUsd = price !== undefined ? amountOf(p.rawAmount, p.decimals) * price : priced.has(p.mint) ? null : p.valueUsd;
    if (priced.has(p.mint) && valueUsd !== p.valueUsd) {
      ops.push(
        prisma.fomoPosition.updateMany({
          where: { wallet: p.wallet, mint: p.mint },
          data: { valueUsd, ...(price !== undefined ? { pricedAt: at } : {}) },
        }),
      );
    }
    perWallet.set(p.wallet, [...(perWallet.get(p.wallet) ?? []), { costUsd: p.costUsd, valueUsd }]);
  }
  for (const [wallet, list] of perWallet) {
    ops.push(prisma.fomoWalletStats.updateMany({ where: { wallet }, data: { unrealizedPnlUsd: unrealizedOf(list) } }));
  }
  for (let i = 0; i < ops.length; i += 500) await prisma.$transaction(ops.slice(i, i + 500));
  log.debug("positions priced", { wallets: perWallet.size, mints: mints.length, priced: Object.keys(prices).length });
}
