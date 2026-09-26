// Stats job (design §4.3 / §4.4 / §4.5), DB only: every 5 min the wallets whose swaps changed (statsDirty),
// every hour all tracked wallets (the windows slide). One wallet at a time:
//   FomoSwap rows → computeWalletStats (FIFO, USDC, after FOMO's fees) → FomoWalletStats (24h / 7d / 30d),
//   FomoPosition (open lots, capped by the daily reconciliation), then ranks per window across wallets
//   (eligible rows by realized PnL desc, volume desc, wallet asc). Followed traders' Trader rows get the PnL.
// Coverage is "partial" while a wallet's history is incomplete (backfill pending / running, an unrepaired gap,
// or no live coverage in logs mode: overflow or a failing subscribe), so it is never ranked on incomplete data.
// With the S1 marker-filter fallback, live xchain orders are invisible: xchainShare is then reported null.
// FomoWallet.statsAt is taken BEFORE the swaps are read and written with the positions: every swap created
// before it is reflected in FomoPosition (retention relies on this to never delete an open lot).

import { Prisma } from "@prisma/client";
import { kvSet, prisma } from "@/lib/db";
import { FOMO_MARKER_SINCE } from "@/lib/fomo-chain";
import { assignRanks, computeWalletStats, solUsdLookup, STATS_WINDOWS } from "@/lib/fomo-stats";
import { getTokenMeta } from "@/lib/tokens";
import { logger } from "../log";
import { withTimeout } from "../util";
import { DAY_MS, HOUR_MS, applyReconcile, unrealizedOf } from "./policy";
import { knownPrices, priceAt } from "./prices";
import { LAST_ELIGIBLE_KV_KEY, lastEligibleMap } from "./promote";
import { loadReconcileOverrides } from "./reconcile";
import { safeErr, state } from "./state";

const log = logger("fomo-stats");

const FULL_EVERY_MS = HOUR_MS;
/**
 * Hourly SOL/USD rows are loaded back to FOMO_MARKER_SINCE (~24 rows a day): retention keeps the lots of open
 * positions indefinitely, and one unpriced old lot would null a whole window's SOL PnL.
 */
const solHistoryFromMs = (): number => FOMO_MARKER_SINCE - DAY_MS;
const SYMBOL_LOOKUPS_PER_TICK = 60;
const SYMBOL_TIMEOUT_MS = 1_500;
const SYMBOL_MISS_TTL_MS = 6 * HOUR_MS;
/** Forget last-eligible marks of wallets that stopped being tracked long ago. */
const LAST_ELIGIBLE_KEEP_MS = 30 * DAY_MS;

let lastFullAt = 0;
const symbols = new Map<string, { symbol: string | null; at: number }>();

interface Ctx {
  nowMs: number;
  solUsdAt: (tMs: number) => number | null;
  prices: Map<string, number>;
  overrides: Awaited<ReturnType<typeof loadReconcileOverrides>>;
  traderWallets: Set<string>;
  lastEligible: Record<string, string>;
  lookups: number;
}

async function symbolFor(mint: string, ctx: Ctx): Promise<string | null> {
  const hit = symbols.get(mint);
  if (hit && (hit.symbol !== null || ctx.nowMs - hit.at < SYMBOL_MISS_TTL_MS)) return hit.symbol;
  if (ctx.lookups >= SYMBOL_LOOKUPS_PER_TICK) return hit?.symbol ?? null;
  ctx.lookups++;
  const meta = await withTimeout(getTokenMeta(mint), SYMBOL_TIMEOUT_MS, null);
  const symbol = meta?.symbol ?? null;
  symbols.set(mint, { symbol, at: ctx.nowMs });
  return symbol;
}

export async function statsTick(): Promise<void> {
  const now = Date.now();
  const full = now - lastFullAt >= FULL_EVERY_MS;
  const rows = await prisma.fomoWallet.findMany({
    where: { status: "tracked", ...(full ? {} : { statsDirty: true }) },
    select: { wallet: true },
  });
  if (rows.length === 0 && !full) return;

  const [hours, overrides, traders, lastEligible] = await Promise.all([
    prisma.solUsdHour.findMany({ where: { hour: { gte: new Date(solHistoryFromMs()) } }, select: { hour: true, price: true } }),
    loadReconcileOverrides(),
    prisma.trader.findMany({ select: { wallet: true } }),
    lastEligibleMap(),
  ]);
  const ctx: Ctx = {
    nowMs: now,
    solUsdAt: solUsdLookup(hours),
    prices: knownPrices(),
    overrides,
    traderWallets: new Set(traders.map((t) => t.wallet)),
    lastEligible,
    lookups: 0,
  };

  let computed = 0;
  for (const r of rows) {
    if (state.stopping) break;
    if (await computeOne(r.wallet, ctx)) computed++;
  }
  await assignAllRanks();

  const keepAfter = now - LAST_ELIGIBLE_KEEP_MS;
  const pruned: Record<string, string> = {};
  for (const [w, iso] of Object.entries(ctx.lastEligible)) if (Date.parse(iso) >= keepAfter || state.tracked.has(w)) pruned[w] = iso;
  await kvSet(LAST_ELIGIBLE_KV_KEY, pruned);

  if (full) lastFullAt = now;
  log.info("stats computed", { wallets: computed, full });
}

async function computeOne(wallet: string, ctx: Ctx): Promise<boolean> {
  const w = await prisma.fomoWallet.findUnique({ where: { wallet }, select: { status: true, coveredFrom: true } });
  if (!w || w.status !== "tracked") return false;
  // Clear first: a swap ingested while we compute sets it again and the next tick picks it up.
  await prisma.fomoWallet.update({ where: { wallet }, data: { statsDirty: false } });
  // statsAt: every swap created before this instant is in the read below (or set statsDirty again).
  const readAt = Date.now();
  try {
    const swaps = await prisma.fomoSwap.findMany({
      where: { wallet },
      select: { signature: true, slot: true, txIndex: true, blockTime: true, kind: true, mint: true, tokenRaw: true, decimals: true, usd: true, solUsd: true },
    });
    const now = Date.now();
    const coveredFrom = state.liveHoleSince(wallet) !== null ? null : w.coveredFrom;
    const res = computeWalletStats(swaps, { now, coveredFrom, solUsdAt: ctx.solUsdAt, prices: ctx.prices });

    const lastSwap = new Map<string, number>();
    for (const s of swaps) {
      const t = s.blockTime.getTime();
      if ((lastSwap.get(s.mint) ?? 0) < t) lastSwap.set(s.mint, t);
    }
    const positions = applyReconcile(res.positions, ctx.overrides.get(wallet), lastSwap);
    const unrealized = unrealizedOf(positions);
    const at = new Date(now);
    const hideXchain = state.s1Filter === "marker";

    const ops: Prisma.PrismaPromise<unknown>[] = [];
    for (const window of STATS_WINDOWS) {
      const s = res.windows[window];
      const topMints = [];
      for (const m of s.topMints) topMints.push({ mint: m.mint, symbol: await symbolFor(m.mint, ctx), pnlUsd: m.pnlUsd });
      const data = {
        trades: s.trades,
        buys: s.buys,
        sells: s.sells,
        volumeUsd: s.volumeUsd,
        realizedPnlUsd: s.realizedPnlUsd,
        realizedPnlSol: s.realizedPnlSol,
        unrealizedPnlUsd: unrealized,
        openPositions: positions.length,
        winRate: s.winRate,
        mintsTraded: s.mintsTraded,
        activeDays: s.activeDays,
        unmatchedSellUsd: s.unmatchedSellUsd,
        xchainUsd: s.xchainUsd,
        xchainShare: hideXchain ? null : s.xchainShare,
        topMints: JSON.stringify(topMints),
        lastTradeAt: s.lastTradeAt,
        coverage: s.coverage,
        eligible: s.eligible,
        computedAt: at,
      };
      ops.push(
        prisma.fomoWalletStats.upsert({
          where: { wallet_window: { wallet, window } },
          create: { wallet, window, ...data },
          update: data,
        }),
      );
    }
    ops.push(prisma.fomoPosition.deleteMany({ where: { wallet } }));
    if (positions.length > 0) {
      ops.push(
        prisma.fomoPosition.createMany({
          data: positions.map((p) => ({
            wallet,
            mint: p.mint,
            rawAmount: p.rawAmount,
            decimals: p.decimals,
            costUsd: p.costUsd,
            costSol: p.costSol,
            openedAt: p.openedAt,
            valueUsd: p.valueUsd,
            pricedAt: p.valueUsd !== null ? priceAt(p.mint) : null,
          })),
        }),
      );
    }
    ops.push(prisma.fomoWallet.update({ where: { wallet }, data: { statsAt: new Date(readAt) } }));
    if (ctx.traderWallets.has(wallet)) {
      ops.push(
        prisma.trader.updateMany({
          where: { wallet },
          data: {
            pnl24hUsd: res.windows["24h"].realizedPnlUsd,
            pnl7dUsd: res.windows["7d"].realizedPnlUsd,
            pnl30dUsd: res.windows["30d"].realizedPnlUsd,
            volumeUsd: res.windows["30d"].volumeUsd,
          },
        }),
      );
    }
    await prisma.$transaction(ops);
    if (STATS_WINDOWS.some((win) => res.windows[win].eligible)) ctx.lastEligible[wallet] = at.toISOString();
    return true;
  } catch (err) {
    await prisma.fomoWallet.updateMany({ where: { wallet }, data: { statsDirty: true } }).catch(() => undefined);
    log.warn("stats failed for wallet", { wallet, err: safeErr(err) });
    return false;
  }
}

/** Rank eligible rows of tracked wallets per window; only changed ranks are written (one transaction per window). */
async function assignAllRanks(): Promise<void> {
  for (const window of STATS_WINDOWS) {
    const rows = await prisma.fomoWalletStats.findMany({
      where: { window },
      select: { wallet: true, eligible: true, realizedPnlUsd: true, volumeUsd: true, rank: true, fomoWallet: { select: { status: true } } },
    });
    const ranks = assignRanks(rows.filter((r) => r.fomoWallet.status === "tracked"));
    const changes = rows.filter((r) => (ranks.get(r.wallet) ?? null) !== r.rank);
    if (changes.length === 0) continue;
    await prisma.$transaction(
      changes.map((r) =>
        prisma.fomoWalletStats.update({ where: { wallet_window: { wallet: r.wallet, window } }, data: { rank: ranks.get(r.wallet) ?? null } }),
      ),
    );
  }
}
