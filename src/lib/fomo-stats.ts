// FIFO PnL, eligibility and ranking for indexed FOMO trades (design §4.3 / §4.4). Pure: no I/O, no Prisma.
//
//  - Order: (slot, txIndex ?? 0, signature).
//  - Buy: push a lot {raw, costUsd = usd, costSol = usd / SOLUSD(t)}.
//  - Sell of q raw: consume lots FIFO. matchedShare = matched / q; realized = usd × matchedShare − matched cost.
//    The unmatched part (bought before our history, received by transfer, bought elsewhere) is EXCLUDED
//    from realized PnL and reported as unmatchedSellUsd — it never inflates PnL.
//  - `usd` is the trader's own USDC change, so PnL is net of FOMO's fee. convert / xchain never touch lots,
//    trade counts, volume or PnL (xchain only feeds xchainUsd / xchainShare).
//  - Rank = eligible rows by realized PnL desc, volume desc, wallet asc. Unrealized PnL never ranks.

import type { Coverage, LeaderboardWindow, RankingRulesDTO } from "./types";

export const STATS_WINDOWS: readonly LeaderboardWindow[] = ["24h", "7d", "30d"];

export const WINDOW_MS: Readonly<Record<LeaderboardWindow, number>> = Object.freeze({
  "24h": 24 * 3600_000,
  "7d": 7 * 24 * 3600_000,
  "30d": 30 * 24 * 3600_000,
});

/** Minimums a wallet needs in a window to be ranked (plus full coverage and not excluded). Sent in the DTO. */
export const RANKING_RULES: Readonly<Record<LeaderboardWindow, RankingRulesDTO>> = Object.freeze({
  "24h": Object.freeze({ minTrades: 3, minVolumeUsd: 250, minActiveDays: 1 }),
  "7d": Object.freeze({ minTrades: 10, minVolumeUsd: 1_000, minActiveDays: 2 }),
  "30d": Object.freeze({ minTrades: 20, minVolumeUsd: 5_000, minActiveDays: 3 }),
});

/** Open positions whose remaining cost is below this are dust and dropped. */
export const MIN_POSITION_COST_USD = 0.01;
/** solUsdLookup: nearest hourly SOL/USD within this distance, else null. */
export const SOL_PRICE_MAX_GAP_MS = 6 * 3600_000;

/** Structurally compatible with a Prisma FomoSwap row. */
export interface StatsSwap {
  signature: string;
  slot: number;
  txIndex: number | null;
  blockTime: Date | number;
  /** "buy" | "sell" | "convert" | "xchain" (anything else is ignored). */
  kind: string;
  mint: string;
  tokenRaw: string | bigint;
  decimals: number;
  /** |USDC change| in USD. */
  usd: number;
  /** SOL/USD at blockTime when the ingest knew it; else solUsdAt(t) is used. */
  solUsd?: number | null;
}

export interface StatsOptions {
  now: Date | number;
  /** Earliest time from which the wallet's history is complete (FomoWallet.coveredFrom). */
  coveredFrom: Date | number | null;
  /** SOL/USD at a time (ms), or null when unknown → SOL PnL becomes null. */
  solUsdAt?: (tMs: number) => number | null;
  rules?: Readonly<Record<LeaderboardWindow, RankingRulesDTO>>;
  /** Excluded wallets are never eligible. */
  excluded?: boolean;
  /** USD price per whole token, by mint (Jupiter). Missing → that position is unpriced. */
  prices?: Readonly<Record<string, number>> | ReadonlyMap<string, number>;
}

export interface TopMint {
  mint: string;
  pnlUsd: number;
}

export interface WindowStats {
  window: LeaderboardWindow;
  start: Date;
  trades: number;
  buys: number;
  sells: number;
  /** Buys + sells, USD. */
  volumeUsd: number;
  buyVolumeUsd: number;
  realizedPnlUsd: number;
  /** null when any sell in the window lacks a SOL price. */
  realizedPnlSol: number | null;
  /** Current open positions (same for every window); null when none is priced. */
  unrealizedPnlUsd: number | null;
  openPositions: number;
  /** Mints with Σ realized > 0 ÷ mints with any matched sell in the window; null when none. */
  winRate: number | null;
  mintsTraded: number;
  /** Distinct UTC dates with trades. */
  activeDays: number;
  unmatchedSellUsd: number;
  xchainUsd: number;
  /** xchainUsd / (xchainUsd + buyVolumeUsd); null when both are 0. */
  xchainShare: number | null;
  lastTradeAt: Date | null;
  coverage: Coverage;
  eligible: boolean;
  /** Top 3 mints traded in the window by |realized| (then volume). Symbols are added by the caller. */
  topMints: TopMint[];
}

export interface OpenPosition {
  mint: string;
  rawAmount: string;
  decimals: number;
  costUsd: number;
  costSol: number | null;
  openedAt: Date;
  /** amount × price when priced, else null. */
  valueUsd: number | null;
}

export interface MintPnl {
  mint: string;
  realizedPnlUsd: number;
  realizedPnlSol: number | null;
  trades: number;
  buys: number;
  sells: number;
  volumeUsd: number;
  unmatchedSellUsd: number;
}

export interface SellResult {
  realizedUsd: number;
  realizedSol: number | null;
  unmatchedUsd: number;
  /** matched raw / sold raw (0..1). */
  matchedShare: number;
}

export interface WalletStats {
  windows: Record<LeaderboardWindow, WindowStats>;
  positions: OpenPosition[];
  /** Per-mint breakdown over the 30d window, by |realized| desc. */
  perMint: MintPnl[];
  /** Per-sell results keyed by signature (all history given). */
  sells: Map<string, SellResult>;
  unrealizedPnlUsd: number | null;
}

interface Lot {
  raw: bigint;
  costUsd: number;
  costSol: number | null;
  t: number;
  decimals: number;
}

interface Event {
  t: number;
  kind: "buy" | "sell" | "convert" | "xchain";
  mint: string;
  usd: number;
  sell?: SellResult & { matched: boolean };
}

const ZERO = BigInt(0);
const RATIO_SCALE = BigInt(1_000_000_000_000);

const toMs = (d: Date | number): number => (typeof d === "number" ? d : d.getTime());

/** a / b as a float in [0, 1] for bigints of any size (b > 0). */
function ratio(a: bigint, b: bigint): number {
  if (b <= ZERO) return 0;
  return Number((a * RATIO_SCALE) / b) / 1e12;
}

function compareSwaps(a: StatsSwap, b: StatsSwap): number {
  return a.slot - b.slot || (a.txIndex ?? 0) - (b.txIndex ?? 0) || (a.signature < b.signature ? -1 : a.signature > b.signature ? 1 : 0);
}

function priceOf(prices: StatsOptions["prices"], mint: string): number | undefined {
  if (!prices) return undefined;
  const p = prices instanceof Map ? prices.get(mint) : (prices as Readonly<Record<string, number>>)[mint];
  return typeof p === "number" && Number.isFinite(p) && p > 0 ? p : undefined;
}

export function xchainShareOf(xchainUsd: number, buyVolumeUsd: number): number | null {
  const denom = xchainUsd + buyVolumeUsd;
  return denom > 0 ? xchainUsd / denom : null;
}

export function isEligible(
  w: Pick<WindowStats, "trades" | "volumeUsd" | "activeDays" | "coverage">,
  rules: RankingRulesDTO,
  excluded = false,
): boolean {
  return (
    !excluded &&
    w.coverage === "full" &&
    w.trades >= rules.minTrades &&
    w.volumeUsd >= rules.minVolumeUsd &&
    w.activeDays >= rules.minActiveDays
  );
}

/**
 * FIFO stats for one wallet: per-window aggregates (24h / 7d / 30d), open positions and a 30d per-mint
 * breakdown. `swaps` may be in any order; they are sorted by (slot, txIndex ?? 0, signature).
 */
export function computeWalletStats(swaps: readonly StatsSwap[], opts: StatsOptions): WalletStats {
  const now = toMs(opts.now);
  const coveredFrom = opts.coveredFrom === null ? null : toMs(opts.coveredFrom);
  const rules = opts.rules ?? RANKING_RULES;
  const excluded = opts.excluded ?? false;
  const solAt = (s: StatsSwap, t: number): number | null => {
    const p = s.solUsd ?? opts.solUsdAt?.(t) ?? null;
    return p !== null && Number.isFinite(p) && p > 0 ? p : null;
  };

  const lots = new Map<string, Lot[]>();
  const events: Event[] = [];
  const sells = new Map<string, SellResult>();

  for (const s of [...swaps].sort(compareSwaps)) {
    const t = toMs(s.blockTime);
    const usd = Number.isFinite(s.usd) ? Math.abs(s.usd) : 0;
    if (s.kind === "convert" || s.kind === "xchain") {
      events.push({ t, kind: s.kind, mint: s.mint, usd });
      continue;
    }
    if (s.kind !== "buy" && s.kind !== "sell") continue;
    let raw: bigint;
    try {
      raw = typeof s.tokenRaw === "bigint" ? s.tokenRaw : BigInt(s.tokenRaw);
    } catch {
      continue;
    }
    if (raw < ZERO) raw = -raw;
    if (raw === ZERO) continue;

    if (s.kind === "buy") {
      const price = solAt(s, t);
      const queue = lots.get(s.mint) ?? [];
      queue.push({ raw, costUsd: usd, costSol: price !== null ? usd / price : null, t, decimals: s.decimals });
      lots.set(s.mint, queue);
      events.push({ t, kind: "buy", mint: s.mint, usd });
      continue;
    }

    // Sell: consume lots FIFO.
    const queue = lots.get(s.mint) ?? [];
    let remaining = raw;
    let matchedRaw = ZERO;
    let matchedCostUsd = 0;
    let matchedCostSol: number | null = 0;
    while (remaining > ZERO && queue.length > 0) {
      const lot = queue[0]!;
      const take = lot.raw <= remaining ? lot.raw : remaining;
      const share = take === lot.raw ? 1 : ratio(take, lot.raw);
      const costUsd = share === 1 ? lot.costUsd : lot.costUsd * share;
      const costSol = lot.costSol === null ? null : share === 1 ? lot.costSol : lot.costSol * share;
      matchedCostUsd += costUsd;
      matchedCostSol = matchedCostSol === null || costSol === null ? null : matchedCostSol + costSol;
      matchedRaw += take;
      remaining -= take;
      if (take === lot.raw) {
        queue.shift();
      } else {
        lot.raw -= take;
        lot.costUsd -= costUsd;
        if (lot.costSol !== null && costSol !== null) lot.costSol -= costSol;
      }
    }
    if (queue.length === 0) lots.delete(s.mint);

    const matchedShare = matchedRaw === raw ? 1 : ratio(matchedRaw, raw);
    const proceedsMatched = usd * matchedShare;
    const realizedUsd = matchedRaw === ZERO ? 0 : proceedsMatched - matchedCostUsd;
    let realizedSol: number | null = 0;
    if (matchedRaw > ZERO) {
      const price = solAt(s, t);
      realizedSol = price !== null && matchedCostSol !== null ? proceedsMatched / price - matchedCostSol : null;
    }
    const result: SellResult = { realizedUsd, realizedSol, unmatchedUsd: usd * (1 - matchedShare), matchedShare };
    sells.set(s.signature, result);
    events.push({ t, kind: "sell", mint: s.mint, usd, sell: { ...result, matched: matchedRaw > ZERO } });
  }

  // Open positions (remaining lots per mint).
  const positions: OpenPosition[] = [];
  let unrealized = 0;
  let anyPriced = false;
  for (const [mint, queue] of lots) {
    let raw = ZERO;
    let costUsd = 0;
    let costSol: number | null = 0;
    let openedAt = Infinity;
    let decimals = 0;
    for (const lot of queue) {
      raw += lot.raw;
      costUsd += lot.costUsd;
      costSol = costSol === null || lot.costSol === null ? null : costSol + lot.costSol;
      openedAt = Math.min(openedAt, lot.t);
      decimals = lot.decimals;
    }
    if (raw <= ZERO || costUsd < MIN_POSITION_COST_USD) continue;
    const price = priceOf(opts.prices, mint);
    const valueUsd = price !== undefined ? (Number(raw) / 10 ** decimals) * price : null;
    if (valueUsd !== null) {
      anyPriced = true;
      unrealized += valueUsd - costUsd;
    }
    positions.push({ mint, rawAmount: raw.toString(), decimals, costUsd, costSol, openedAt: new Date(openedAt), valueUsd });
  }
  positions.sort((a, b) => b.costUsd - a.costUsd || (a.mint < b.mint ? -1 : 1));
  const unrealizedPnlUsd = anyPriced ? unrealized : null;

  const windows = {} as Record<LeaderboardWindow, WindowStats>;
  for (const window of STATS_WINDOWS) {
    const start = now - WINDOW_MS[window];
    let buys = 0;
    let sellsN = 0;
    let volumeUsd = 0;
    let buyVolumeUsd = 0;
    let realizedPnlUsd = 0;
    let realizedPnlSol: number | null = 0;
    let unmatchedSellUsd = 0;
    let xchainUsd = 0;
    let lastTradeAt: number | null = null;
    const days = new Set<string>();
    const mints = new Map<string, { realized: number; volume: number; matchedSell: boolean }>();

    for (const e of events) {
      if (e.t < start) continue;
      if (e.kind === "xchain") {
        xchainUsd += e.usd;
        continue;
      }
      if (e.kind === "convert") continue;
      const m = mints.get(e.mint) ?? { realized: 0, volume: 0, matchedSell: false };
      m.volume += e.usd;
      volumeUsd += e.usd;
      days.add(new Date(e.t).toISOString().slice(0, 10));
      if (lastTradeAt === null || e.t > lastTradeAt) lastTradeAt = e.t;
      if (e.kind === "buy") {
        buys++;
        buyVolumeUsd += e.usd;
      } else if (e.sell) {
        sellsN++;
        realizedPnlUsd += e.sell.realizedUsd;
        realizedPnlSol = realizedPnlSol === null || e.sell.realizedSol === null ? null : realizedPnlSol + e.sell.realizedSol;
        unmatchedSellUsd += e.sell.unmatchedUsd;
        m.realized += e.sell.realizedUsd;
        if (e.sell.matched) m.matchedSell = true;
      }
      mints.set(e.mint, m);
    }

    let withMatched = 0;
    let winners = 0;
    for (const m of mints.values()) {
      if (!m.matchedSell) continue;
      withMatched++;
      if (m.realized > 0) winners++;
    }
    const topMints = [...mints.entries()]
      .sort(([am, a], [bm, b]) => Math.abs(b.realized) - Math.abs(a.realized) || b.volume - a.volume || (am < bm ? -1 : 1))
      .slice(0, 3)
      .map(([mint, m]) => ({ mint, pnlUsd: m.realized }));

    const coverage: Coverage = coveredFrom !== null && coveredFrom <= start ? "full" : "partial";
    const w: WindowStats = {
      window,
      start: new Date(start),
      trades: buys + sellsN,
      buys,
      sells: sellsN,
      volumeUsd,
      buyVolumeUsd,
      realizedPnlUsd,
      realizedPnlSol,
      unrealizedPnlUsd,
      openPositions: positions.length,
      winRate: withMatched > 0 ? winners / withMatched : null,
      mintsTraded: mints.size,
      activeDays: days.size,
      unmatchedSellUsd,
      xchainUsd,
      xchainShare: xchainShareOf(xchainUsd, buyVolumeUsd),
      lastTradeAt: lastTradeAt !== null ? new Date(lastTradeAt) : null,
      coverage,
      eligible: false,
      topMints,
    };
    w.eligible = isEligible(w, rules[window], excluded);
    windows[window] = w;
  }

  // Per-mint breakdown over the 30d window.
  const perMintStart = now - WINDOW_MS["30d"];
  const perMintMap = new Map<string, MintPnl>();
  for (const e of events) {
    if (e.t < perMintStart || (e.kind !== "buy" && e.kind !== "sell")) continue;
    const m = perMintMap.get(e.mint) ?? {
      mint: e.mint,
      realizedPnlUsd: 0,
      realizedPnlSol: 0,
      trades: 0,
      buys: 0,
      sells: 0,
      volumeUsd: 0,
      unmatchedSellUsd: 0,
    };
    m.trades++;
    m.volumeUsd += e.usd;
    if (e.kind === "buy") m.buys++;
    else if (e.sell) {
      m.sells++;
      m.realizedPnlUsd += e.sell.realizedUsd;
      m.realizedPnlSol = m.realizedPnlSol === null || e.sell.realizedSol === null ? null : m.realizedPnlSol + e.sell.realizedSol;
      m.unmatchedSellUsd += e.sell.unmatchedUsd;
    }
    perMintMap.set(e.mint, m);
  }
  const perMint = [...perMintMap.values()].sort(
    (a, b) => Math.abs(b.realizedPnlUsd) - Math.abs(a.realizedPnlUsd) || b.volumeUsd - a.volumeUsd || (a.mint < b.mint ? -1 : 1),
  );

  return { windows, positions, perMint, sells, unrealizedPnlUsd };
}

/** Rank order: realized PnL desc, then volume desc, then wallet asc. */
export function compareForRank(
  a: { wallet: string; realizedPnlUsd: number; volumeUsd: number },
  b: { wallet: string; realizedPnlUsd: number; volumeUsd: number },
): number {
  return b.realizedPnlUsd - a.realizedPnlUsd || b.volumeUsd - a.volumeUsd || (a.wallet < b.wallet ? -1 : a.wallet > b.wallet ? 1 : 0);
}

/** 1-based ranks for the eligible rows of ONE window (ineligible rows get no rank). */
export function assignRanks(
  rows: readonly { wallet: string; eligible: boolean; realizedPnlUsd: number; volumeUsd: number }[],
): Map<string, number> {
  const ranked = rows.filter((r) => r.eligible).sort(compareForRank);
  return new Map(ranked.map((r, i) => [r.wallet, i + 1]));
}

/**
 * Build a solUsdAt(tMs) function from hourly SolUsdHour rows: the nearest hour within ±6 h, else null.
 */
export function solUsdLookup(rows: readonly { hour: Date | number; price: number }[]): (tMs: number) => number | null {
  const pts = rows
    .map((r) => ({ t: toMs(r.hour), p: r.price }))
    .filter((r) => Number.isFinite(r.t) && Number.isFinite(r.p) && r.p > 0)
    .sort((a, b) => a.t - b.t);
  return (tMs: number) => {
    if (pts.length === 0) return null;
    let lo = 0;
    let hi = pts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pts[mid]!.t < tMs) lo = mid + 1;
      else hi = mid;
    }
    let best = pts[lo]!;
    if (lo > 0 && Math.abs(pts[lo - 1]!.t - tMs) <= Math.abs(best.t - tMs)) best = pts[lo - 1]!;
    return Math.abs(best.t - tMs) <= SOL_PRICE_MAX_GAP_MS ? best.p : null;
  };
}
