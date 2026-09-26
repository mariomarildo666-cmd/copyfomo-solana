// FOMO trader data computed by copyfomo from public Solana data (design §6.3). No FOMO API is used.
//   - Leaderboard, lookups and trader detail read ONLY our database (FomoWallet / FomoWalletStats /
//     FomoSwap / FomoPosition, filled by the worker indexer) plus the curated seed file.
//   - The one network path is checkFomoActivity (Helius, P4, metered and capped) for pasted wallets.
//   - Labels (handle, display name, X handle) come from the seed file or Helius labels — never from user input.
// Imported by the web process: never import `ws` or worker-only code here.

import type { FomoPosition, FomoSwap, FomoWallet, FomoWalletStats, Trader } from "@prisma/client";
import { z } from "zod";
import { config, type HeliusPlan } from "./config";
import { kvGet, prisma } from "./db";
import { checkFomoActivity } from "./fomo-chain";
import { fomoSeedByWallet, FOMO_HANDLE_RE, loadFomoSeed, type FomoSeedEntry } from "./fomo-seed";
import { computeWalletStats, RANKING_RULES, solUsdLookup } from "./fomo-stats";
import { meter } from "./helius";
import { HttpError } from "./http";
import { isValidSolanaAddress, SOL_MINT, USDC_MINT, USDT_MINT } from "./solana";
import type {
  Coverage,
  FomoTradeDTO,
  IndexerStatusDTO,
  LeaderboardDTO,
  LeaderboardWindow,
  TraderDetailDTO,
  TraderDTO,
  TraderLookupDTO,
  TraderSource,
  TraderWindowStatsDTO,
} from "./types";

export const LEADERBOARD_WINDOWS: readonly LeaderboardWindow[] = ["24h", "7d", "30d"];

const MAX_LIMIT = 150;
/** Below this many ranked rows the board is padded with partial-history rows (rank null). */
const MIN_RANKED_ROWS = 10;
const STALE_MS = 20 * 60_000;
const DETAIL_RECENT = 50;
/** Per-mint breakdown window (must match fomo-stats' perMint window). */
const DETAIL_PER_MINT_MS = 30 * 24 * 3600_000;
/** Trader detail is public and can load tens of thousands of rows for heavy wallets: cache it briefly. */
const DETAIL_CACHE_MS = 30_000;
const DETAIL_CACHE_MAX = 500;

/**
 * Fields that make a wallet (re-)enter the tracked set with a clean slate: a full backfill from scratch.
 * A wallet that was a candidate (demoted, excluded, or never tracked) has no indexed history for the time it
 * wasn't tracked, and retention deleted its old swaps: keeping backfillState "done" / the old coveredFrom
 * would rank it on a history with holes labelled "full" (finding F32). Same reset as promoteTick/refreshTracked.
 */
export function retrackReset(now: Date) {
  return {
    status: "tracked",
    trackedAt: now,
    backfillState: "pending",
    backfillCursor: null,
    coveredFrom: null,
    gapFrom: null,
    statsDirty: true,
  } as const;
}

// ── Labels ──────────────────────────────────────────────────────────────────────────────────────────

interface Labels {
  handle: string | null;
  displayName: string | null;
  xHandle: string | null;
  verified: boolean;
  source: TraderSource;
}

/**
 * Identity for a wallet from our own data only: the FomoWallet row (seed sync / Helius label / on-chain
 * evidence) with the seed file as a fallback before the worker has synced it. Excluded wallets (opt-outs,
 * bots) show no labels.
 */
function labelsFor(w: FomoWallet | null, seed: FomoSeedEntry | undefined): Labels {
  const excluded = w?.status === "excluded" || seed?.exclude === true;
  const fomo = !!(w?.evidenceSig || w?.origin === "seed" || seed);
  if (excluded) return { handle: null, displayName: null, xHandle: null, verified: false, source: fomo ? "fomo" : "custom" };
  const handle = w?.handle ?? seed?.handle ?? null;
  const verified = handle !== null && (w?.handle ? w.handleVerified : (seed?.handleVerified ?? false));
  return {
    handle,
    displayName: w?.displayName ?? seed?.name ?? null,
    xHandle: w?.xHandle ?? seed?.xHandle ?? null,
    verified,
    source: fomo ? "fomo" : "custom",
  };
}

// ── DTO mapping ─────────────────────────────────────────────────────────────────────────────────────

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);
const shortMint = (mint: string): string => `${mint.slice(0, 4)}…${mint.slice(-4)}`;

function topTokens(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const rows = JSON.parse(json) as unknown;
    if (!Array.isArray(rows)) return [];
    const out: string[] = [];
    for (const r of rows) {
      if (!r || typeof r !== "object") continue;
      const { mint, symbol } = r as { mint?: unknown; symbol?: unknown };
      if (typeof symbol === "string" && symbol.trim()) out.push(symbol.trim().slice(0, 16));
      else if (typeof mint === "string" && mint) out.push(shortMint(mint));
    }
    return out.slice(0, 3);
  } catch {
    return [];
  }
}

function latest(a: Date | null | undefined, b: Date | null | undefined): Date | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return a > b ? a : b;
}

function toTraderDTO(
  wallet: string,
  w: FomoWallet | null,
  stats: FomoWalletStats | null,
  copiers: number,
  seed: FomoSeedEntry | undefined = fomoSeedByWallet().get(wallet),
): TraderDTO {
  const l = labelsFor(w, seed);
  return {
    wallet,
    handle: l.handle,
    displayName: l.displayName,
    xHandle: l.xHandle,
    avatarUrl: null,
    source: l.source,
    verified: l.verified,
    rank: stats?.rank ?? null,
    pnlUsd: stats ? stats.realizedPnlUsd : null,
    pnlSol: stats?.realizedPnlSol ?? null,
    unrealizedUsd: stats?.unrealizedPnlUsd ?? null,
    volumeUsd: stats ? stats.volumeUsd : null,
    trades: stats ? stats.trades : null,
    winRate: stats?.winRate ?? null,
    lastTradeAt: iso(latest(w?.lastTradeAt, stats?.lastTradeAt)),
    coverage: stats ? (stats.coverage === "full" ? "full" : "partial") : null,
    xchainShare: stats?.xchainShare ?? null,
    topTokens: topTokens(stats?.topMints),
    copiers,
  };
}

function toWindowStatsDTO(s: FomoWalletStats, coveredFrom: Date | null): TraderWindowStatsDTO {
  return {
    window: s.window as LeaderboardWindow,
    rank: s.rank,
    eligible: s.eligible,
    coverage: (s.coverage === "full" ? "full" : "partial") as Coverage,
    coveredFrom: iso(coveredFrom),
    trades: s.trades,
    buys: s.buys,
    sells: s.sells,
    volumeUsd: s.volumeUsd,
    realizedPnlUsd: s.realizedPnlUsd,
    realizedPnlSol: s.realizedPnlSol,
    unrealizedPnlUsd: s.unrealizedPnlUsd,
    winRate: s.winRate,
    mintsTraded: s.mintsTraded,
    activeDays: s.activeDays,
    openPositions: s.openPositions,
    unmatchedSellUsd: s.unmatchedSellUsd,
    xchainUsd: s.xchainUsd,
    xchainShare: s.xchainShare,
    lastTradeAt: iso(s.lastTradeAt),
    computedAt: s.computedAt.toISOString(),
  };
}

// ── Copier counts ───────────────────────────────────────────────────────────────────────────────────

/** How many non-stopped agents follow each wallet (0 when unknown). Never throws. */
export async function copierCounts(wallets: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (wallets.length === 0) return out;
  try {
    const rows = await prisma.trader.findMany({
      where: { wallet: { in: wallets } },
      select: {
        wallet: true,
        _count: { select: { follows: { where: { agent: { status: { not: "stopped" } } } } } },
      },
    });
    for (const r of rows) out.set(r.wallet, r._count.follows);
  } catch (err) {
    console.warn(`[fomo] copier counts unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }
  return out;
}

// ── Leaderboard ─────────────────────────────────────────────────────────────────────────────────────

function clampLimit(limit: number): number {
  return Math.min(Math.max(Math.floor(Number.isFinite(limit) ? limit : 50), 1), MAX_LIMIT);
}

/** Before the first stats exist: the curated wallets, unranked, in file order. */
async function seedLeaderboard(window: LeaderboardWindow, n: number, tracked: number): Promise<LeaderboardDTO> {
  const seed = loadFomoSeed()
    .filter((e) => !e.exclude)
    .slice(0, n);
  const wallets = seed.map((e) => e.wallet);
  const [rows, counts] = await Promise.all([prisma.fomoWallet.findMany({ where: { wallet: { in: wallets } } }), copierCounts(wallets)]);
  const byWallet = new Map(rows.map((r) => [r.wallet, r]));
  const traders = seed
    .filter((e) => byWallet.get(e.wallet)?.status !== "excluded")
    .map((e) => toTraderDTO(e.wallet, byWallet.get(e.wallet) ?? null, null, counts.get(e.wallet) ?? 0, e));
  return {
    window,
    source: "seed",
    capturedAt: new Date().toISOString(),
    stale: false,
    universe: { tracked, ranked: 0 },
    rules: { ...RANKING_RULES[window] },
    traders,
  };
}

/**
 * Ranked FOMO traders for a window, from FomoWalletStats (computed by the worker). Fewer than 10 ranked →
 * padded with unranked rows (rank null, by realized PnL): partial history, or full history with trades that
 * miss the minimums. No stats at all → seed rows ("seed").
 */
export async function getLeaderboard(window: LeaderboardWindow, limit = 50): Promise<LeaderboardDTO> {
  if (!LEADERBOARD_WINDOWS.includes(window)) throw new HttpError(400, `unknown leaderboard window "${window}"`);
  const n = clampLimit(limit);

  const [tracked, anyStats] = await Promise.all([
    prisma.fomoWallet.count({ where: { status: "tracked" } }),
    prisma.fomoWalletStats.findFirst({ select: { wallet: true } }),
  ]);
  if (!anyStats) return seedLeaderboard(window, n, tracked);

  const rankedWhere = { window, rank: { not: null }, eligible: true, fomoWallet: { status: "tracked" } };
  const [ranked, rankedCount, newest] = await Promise.all([
    prisma.fomoWalletStats.findMany({ where: rankedWhere, orderBy: { rank: "asc" }, take: n, include: { fomoWallet: true } }),
    prisma.fomoWalletStats.count({ where: rankedWhere }),
    prisma.fomoWalletStats.aggregate({ where: { window }, _max: { computedAt: true } }),
  ]);

  let rows = ranked;
  if (rankedCount < MIN_RANKED_ROWS && rows.length < n) {
    // Unranked rows: partial history (still backfilling), or full history that misses the minimums but traded.
    const partial = await prisma.fomoWalletStats.findMany({
      where: { window, rank: null, fomoWallet: { status: "tracked" }, OR: [{ coverage: "partial" }, { trades: { gt: 0 } }] },
      orderBy: [{ realizedPnlUsd: "desc" }, { volumeUsd: "desc" }, { wallet: "asc" }],
      take: n - rows.length,
      include: { fomoWallet: true },
    });
    rows = rows.concat(partial);
  }

  const counts = await copierCounts(rows.map((r) => r.wallet));
  const capturedAt = newest._max.computedAt ?? new Date();
  return {
    window,
    source: "onchain",
    capturedAt: capturedAt.toISOString(),
    stale: Date.now() - capturedAt.getTime() > STALE_MS,
    universe: { tracked, ranked: rankedCount },
    rules: { ...RANKING_RULES[window] },
    traders: rows.map((r) => toTraderDTO(r.wallet, r.fomoWallet, r, counts.get(r.wallet) ?? 0)),
  };
}

// ── Lookup ──────────────────────────────────────────────────────────────────────────────────────────

async function traderWithStats(wallet: string, w: FomoWallet | null): Promise<TraderDTO> {
  const [stats, counts] = await Promise.all([
    w ? prisma.fomoWalletStats.findUnique({ where: { wallet_window: { wallet, window: "30d" } } }) : Promise.resolve(null),
    copierCounts([wallet]),
  ]);
  return toTraderDTO(wallet, w, stats, counts.get(wallet) ?? 0);
}

/**
 * Resolve a pasted Solana wallet or a known @handle.
 *  - Wallet on our list (seed / tracked / discovered / evidence) → its 30d stats, note null.
 *  - Other wallet → checkFomoActivity (Helius, cached 6 h, daily-capped): note null when a FOMO trade was
 *    found, "no_fomo_activity", or "check_unavailable". The trader row is returned either way (it can still be added).
 *  - Handle → case-insensitive match on labels we hold (FomoWallet.handleLower / seed file); else
 *    {trader:null, note:"unknown_handle"}. Never calls anything upstream.
 * `beforeCheck` runs right before an uncached on-chain check (e.g. a stricter per-IP rate limit that throws).
 */
export async function lookupTrader(q: string, opts: { beforeCheck?: () => void } = {}): Promise<TraderLookupDTO> {
  const query = q.trim();
  if (query && isValidSolanaAddress(query)) return lookupWallet(query, opts.beforeCheck);

  const handle = query.replace(/^@+/, "");
  if (!FOMO_HANDLE_RE.test(handle)) return { trader: null, note: "unknown_handle" };
  const lower = handle.toLowerCase();

  const row = await prisma.fomoWallet.findFirst({
    where: { handleLower: lower, status: { not: "excluded" } },
    orderBy: [{ handleVerified: "desc" }, { createdAt: "asc" }],
  });
  if (row) return { trader: await traderWithStats(row.wallet, row), note: null };

  const seed = loadFomoSeed().find((e) => !e.exclude && e.handle?.toLowerCase() === lower);
  if (seed) {
    const w = await prisma.fomoWallet.findUnique({ where: { wallet: seed.wallet } });
    if (w?.status !== "excluded") return { trader: await traderWithStats(seed.wallet, w), note: null };
  }
  return { trader: null, note: "unknown_handle" };
}

async function lookupWallet(wallet: string, beforeCheck?: () => void): Promise<TraderLookupDTO> {
  let w = await prisma.fomoWallet.findUnique({ where: { wallet } });
  const seed = fomoSeedByWallet().get(wallet);
  const known = !!seed || (w !== null && (w.origin !== "user" || w.status === "tracked" || w.evidenceSig !== null));
  if (known) return { trader: await traderWithStats(wallet, w), note: null };

  const res = await checkFomoActivity(wallet, { beforeNetwork: beforeCheck });
  if (!res.cached || res.status === "found") w = await prisma.fomoWallet.findUnique({ where: { wallet } });
  const note: TraderLookupDTO["note"] = res.status === "found" ? null : res.status === "none" ? "no_fomo_activity" : "check_unavailable";
  return { trader: await traderWithStats(wallet, w), note };
}

// ── Seed sync (worker startup) ──────────────────────────────────────────────────────────────────────

function seedCreateData(e: FomoSeedEntry, now: Date) {
  return {
    wallet: e.wallet,
    origin: "seed",
    status: e.exclude ? "excluded" : "tracked",
    trackedAt: e.exclude ? null : now,
    handle: e.handle,
    handleLower: e.handle?.toLowerCase() ?? null,
    handleSource: e.handle ? "seed" : null,
    handleVerified: e.handleVerified,
    displayName: e.name,
    xHandle: e.xHandle,
  };
}

/**
 * Upsert every seed wallet into FomoWallet (design §3.3): origin "seed", status "tracked" (or "excluded"
 * when the seed says so). The seed is authoritative for the labels it provides (non-null fields overwrite;
 * a Helius-verified identical handle stays verified); fields it leaves null keep what we have. Also refreshes
 * the labels of existing Trader rows for seed wallets. Idempotent; run once at worker startup.
 */
export async function syncFomoSeed(): Promise<{ created: number; updated: number; excluded: number }> {
  const now = new Date();
  const out = { created: 0, updated: 0, excluded: 0 };
  for (const e of loadFomoSeed()) {
    const existing = await prisma.fomoWallet.findUnique({ where: { wallet: e.wallet } });
    if (e.exclude) out.excluded++;
    if (!existing) {
      await prisma.fomoWallet.create({ data: seedCreateData(e, now) });
      out.created++;
    } else {
      const lower = e.handle?.toLowerCase() ?? null;
      const status = e.exclude ? "excluded" : "tracked";
      await prisma.fomoWallet.update({
        where: { wallet: e.wallet },
        data: {
          origin: "seed",
          status,
          ...(status === "tracked" && !existing.trackedAt ? { trackedAt: now } : {}),
          ...(status !== existing.status ? { statsDirty: true } : {}),
          // Entering the tracked set (from candidate / excluded): clean-slate backfill (F32).
          ...(status === "tracked" && existing.status !== "tracked" ? retrackReset(now) : {}),
          ...(e.handle
            ? {
                handle: e.handle,
                handleLower: lower,
                handleSource: "seed",
                handleVerified: e.handleVerified || (existing.handleVerified && existing.handleLower === lower),
              }
            : {}),
          ...(e.name ? { displayName: e.name } : {}),
          ...(e.xHandle ? { xHandle: e.xHandle } : {}),
        },
      });
      out.updated++;
    }
    const w = await prisma.fomoWallet.findUnique({ where: { wallet: e.wallet } });
    const l = labelsFor(w, e);
    await prisma.trader.updateMany({
      where: { wallet: e.wallet },
      data: { handle: l.handle, displayName: l.displayName, avatarUrl: null, source: l.source, verified: l.verified },
    });
  }
  return out;
}

// ── Follow (agent create / update) ──────────────────────────────────────────────────────────────────

/**
 * Create or refresh the Trader row for a followed wallet. The client's handle / display name / avatar are
 * IGNORED: labels are copied from FomoWallet (seed file or Helius label) so nobody can label a wallet
 * "@someone". `source` is "fomo" for seed wallets and wallets with an on-chain FOMO trade, else "custom".
 *
 * It NEVER marks a wallet tracked (finding F14): a new non-seed wallet is recorded as a "user" candidate, and
 * the worker's refreshTracked promotes wallets followed by funded (active/paused) agents — with the clean-slate
 * backfill reset. Following wallets from an unfunded agent therefore costs no Helius budget.
 */
export async function upsertTrader(t: {
  wallet: string;
  handle?: string | null;
  displayName?: string | null;
  avatarUrl?: string | null;
  source?: "fomo" | "custom";
}): Promise<Trader> {
  if (!isValidSolanaAddress(t.wallet)) throw new HttpError(400, "invalid trader wallet", { wallet: "not a Solana address" });
  const wallet = t.wallet;
  const seed = fomoSeedByWallet().get(wallet);
  const now = new Date();

  const w = await prisma.fomoWallet.upsert({
    where: { wallet },
    create: seed ? seedCreateData(seed, now) : { wallet, origin: "user", status: "candidate" },
    update: {},
  });

  const l = labelsFor(w, seed);
  const stats = await prisma.fomoWalletStats.findMany({ where: { wallet } });
  const pnl = (win: LeaderboardWindow) => stats.find((s) => s.window === win)?.realizedPnlUsd;
  const data = {
    handle: l.handle,
    displayName: l.displayName,
    avatarUrl: null,
    source: l.source,
    verified: l.verified,
    pnl24hUsd: pnl("24h"),
    pnl7dUsd: pnl("7d"),
    pnl30dUsd: pnl("30d"),
    volumeUsd: stats.find((s) => s.window === "30d")?.volumeUsd,
  };
  return prisma.trader.upsert({
    where: { wallet },
    create: { wallet, ...data },
    update: data,
  });
}

// ── Trader detail ───────────────────────────────────────────────────────────────────────────────────

const KNOWN_SYMBOLS: Record<string, string> = { [SOL_MINT]: "SOL", [USDC_MINT]: "USDC", [USDT_MINT]: "USDT" };

/** Token symbols from the Kv token cache only (tokens.ts fills it); never calls Jupiter. */
async function cachedSymbols(mints: string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const unknown = [...new Set(mints)].filter((m) => {
    const known = KNOWN_SYMBOLS[m];
    if (known) out.set(m, known);
    return !known;
  });
  if (unknown.length === 0) return out;
  const rows = await prisma.kv.findMany({ where: { key: { in: unknown.map((m) => `token:${m}`) } } }).catch(() => []);
  for (const r of rows) {
    try {
      const v = JSON.parse(r.value) as { symbol?: unknown };
      out.set(r.key.slice("token:".length), typeof v.symbol === "string" && v.symbol.trim() ? v.symbol.trim().slice(0, 16) : null);
    } catch {
      /* corrupt cache row: no symbol */
    }
  }
  return out;
}

const WINDOW_ORDER: Record<string, number> = { "24h": 0, "7d": 1, "30d": 2 };

function rawToAmount(raw: string, decimals: number): number {
  const n = Number(raw);
  return Number.isFinite(n) ? n / 10 ** decimals : 0;
}

const detailCache = new Map<string, { at: number; value: Promise<TraderDetailDTO | null> }>();

/**
 * Everything we know about one wallet: labels + 30d headline stats, every window's stats, open positions,
 * a 30d per-mint breakdown (computed on demand from FomoSwap) and the newest 50 FOMO trades.
 * null when the wallet is invalid, unknown to us, or excluded (opt-out). Cached 30 s per wallet.
 */
export async function getTraderDetail(wallet: string): Promise<TraderDetailDTO | null> {
  if (!isValidSolanaAddress(wallet)) return null;
  const now = Date.now();
  const hit = detailCache.get(wallet);
  if (hit && now - hit.at < DETAIL_CACHE_MS) return hit.value;
  if (detailCache.size >= DETAIL_CACHE_MAX) {
    for (const [k, v] of detailCache) if (now - v.at >= DETAIL_CACHE_MS) detailCache.delete(k);
    if (detailCache.size >= DETAIL_CACHE_MAX) detailCache.clear();
  }
  const value = loadTraderDetail(wallet, now);
  detailCache.set(wallet, { at: now, value });
  value.catch(() => detailCache.delete(wallet));
  return value;
}

/**
 * The swaps the detail needs, newest data first (finding F29: the old query kept the OLDEST 20,000 rows):
 *  - `recent`: the newest 50 buys/sells, from their own query;
 *  - FIFO input: EVERY row of each mint traded in the last 30 days or among the recent trades, oldest first,
 *    so per-mint realized PnL and the recent sells' PnL match their lots (retention bounds the row count).
 */
async function loadDetailSwaps(wallet: string, now: number): Promise<{ swaps: FomoSwap[]; recentSwaps: FomoSwap[] }> {
  const [recentSwaps, active] = await Promise.all([
    prisma.fomoSwap.findMany({
      where: { wallet, kind: { in: ["buy", "sell"] } },
      orderBy: [{ slot: "desc" }, { txIndex: "desc" }],
      take: DETAIL_RECENT,
    }),
    prisma.fomoSwap.findMany({
      where: { wallet, blockTime: { gte: new Date(now - DETAIL_PER_MINT_MS) } },
      select: { mint: true },
      distinct: ["mint"],
    }),
  ]);
  const mints = [...new Set([...active.map((r) => r.mint), ...recentSwaps.map((s) => s.mint)])];
  const swaps =
    mints.length === 0
      ? []
      : await prisma.fomoSwap.findMany({ where: { wallet, mint: { in: mints } }, orderBy: [{ slot: "asc" }, { txIndex: "asc" }] });
  return { swaps, recentSwaps };
}

async function loadTraderDetail(wallet: string, nowMs: number): Promise<TraderDetailDTO | null> {
  const seed = fomoSeedByWallet().get(wallet);
  const w = await prisma.fomoWallet.findUnique({ where: { wallet }, include: { stats: true, positions: true } });
  if (!w && !seed) return null;
  if (w?.status === "excluded" || seed?.exclude) return null;

  const { swaps, recentSwaps } = w ? await loadDetailSwaps(wallet, nowMs) : { swaps: [] as FomoSwap[], recentSwaps: [] as FomoSwap[] };
  const positions: FomoPosition[] = w?.positions ?? [];
  const stats: FomoWalletStats[] = w?.stats ?? [];

  let solUsdAt: ((t: number) => number | null) | undefined;
  if (swaps.length > 0) {
    const from = new Date(swaps[0]!.blockTime.getTime() - 6 * 3600_000);
    const to = new Date(swaps[swaps.length - 1]!.blockTime.getTime() + 6 * 3600_000);
    const hours = await prisma.solUsdHour.findMany({ where: { hour: { gte: from, lte: to } } });
    solUsdAt = solUsdLookup(hours);
  }
  const computed = computeWalletStats(swaps, { now: nowMs, coveredFrom: w?.coveredFrom ?? null, solUsdAt });
  const symbols = await cachedSymbols([
    ...computed.perMint.map((m) => m.mint),
    ...positions.map((p) => p.mint),
    ...recentSwaps.map((s) => s.mint),
  ]);
  const counts = await copierCounts([wallet]);
  const stats30d = stats.find((s) => s.window === "30d") ?? null;

  const recent: FomoTradeDTO[] = recentSwaps.map((s) => ({
    signature: s.signature,
    side: s.kind === "buy" ? "buy" : "sell",
    mint: s.mint,
    symbol: symbols.get(s.mint) ?? null,
    usd: s.usd,
    amount: rawToAmount(s.tokenRaw, s.decimals),
    router: s.router,
    blockTime: s.blockTime.toISOString(),
    realizedPnlUsd: s.kind === "sell" ? (computed.sells.get(s.signature)?.realizedUsd ?? null) : null,
  }));

  return {
    trader: toTraderDTO(wallet, w, stats30d, counts.get(wallet) ?? 0, seed),
    stats: [...stats]
      .sort((a, b) => (WINDOW_ORDER[a.window] ?? 9) - (WINDOW_ORDER[b.window] ?? 9))
      .map((s) => toWindowStatsDTO(s, w?.coveredFrom ?? null)),
    perMint: computed.perMint.map((m) => ({
      mint: m.mint,
      symbol: symbols.get(m.mint) ?? null,
      realizedPnlUsd: m.realizedPnlUsd,
      realizedPnlSol: m.realizedPnlSol,
      trades: m.trades,
    })),
    positions: positions
      .map((p) => ({
        mint: p.mint,
        symbol: symbols.get(p.mint) ?? null,
        amount: rawToAmount(p.rawAmount, p.decimals),
        costUsd: p.costUsd,
        valueUsd: p.valueUsd,
        openedAt: p.openedAt.toISOString(),
      }))
      .sort((a, b) => b.costUsd - a.costUsd),
    recent,
    evidenceSig: w?.evidenceSig ?? null,
  };
}

// ── Indexer status (Kv "fomo:indexer", written by the worker every 10 s) ────────────────────────────

export const FOMO_INDEXER_KV_KEY = "fomo:indexer";
/**
 * Kv "fomo:stream:lastMsgAt": ISO restart resume point written by the indexer: the last stream frame, or earlier
 * while any stretch is still unrepaired (open stream gap, queued gap-fill, unwritten live item).
 */
export const FOMO_STREAM_LAST_MSG_KV_KEY = "fomo:stream:lastMsgAt";

/** What the worker's status loop writes to Kv "fomo:indexer" (design §4.2). Never put keys or URLs here. */
export interface FomoIndexerKv {
  mode: "stream" | "logs" | "off";
  connected: boolean;
  lastMsgAt: string | null;
  lastFomoTradeAt: string | null;
  tracked: number;
  candidates: number;
  backfillQueue: number;
  creditsToday: number;
  capToday: number;
  pausedPriorities: number[];
  plan: HeliusPlan;
  caps: { ts: boolean; gtfa: boolean; identity: boolean } | null;
  /** Drift counters over the last hour (§2.7): relayer-paid 2-signer swap-shaped txs WITHOUT the marker, trades with an unknown router, and all trades. */
  noMarkerSwaps1h: number;
  unknownRouter1h: number;
  trades1h: number;
}

const indexerKvSchema = z
  .object({
    mode: z.enum(["stream", "logs", "off"]),
    connected: z.boolean(),
    lastFomoTradeAt: z.string().nullable().optional(),
    tracked: z.number().optional(),
    candidates: z.number().optional(),
    noMarkerSwaps1h: z.number().optional(),
    unknownRouter1h: z.number().optional(),
    trades1h: z.number().optional(),
  })
  .passthrough();

/** The worker writes the status every 10 s; older than this means the indexer is not running. */
const INDEXER_STATUS_STALE_MS = 60_000;
const NO_TRADE_WARN_MS = 15 * 60_000;
const DRIFT_SHARE = 0.05;

/** Public indexer status for GET /api/indexer: rounded credit %, never keys or URLs. */
export async function getIndexerStatus(): Promise<IndexerStatusDTO> {
  const enabled = config.heliusApiKey !== "" && config.fomoIndexer;
  const [row] = await Promise.all([kvGet<unknown>(FOMO_INDEXER_KV_KEY).catch(() => null), meter.sync()]);
  const now = Date.now();
  const parsed = row ? indexerKvSchema.safeParse(row.value) : null;
  const s = parsed?.success && now - row!.updatedAt.getTime() < INDEXER_STATUS_STALE_MS ? parsed.data : null;

  const [tracked, candidates] =
    s && s.tracked !== undefined && s.candidates !== undefined
      ? [s.tracked, s.candidates]
      : await Promise.all([
          prisma.fomoWallet.count({ where: { status: "tracked" } }),
          prisma.fomoWallet.count({ where: { status: "candidate" } }),
        ]);

  let driftWarning: string | null = null;
  if (s) {
    const trades = s.trades1h ?? 0;
    const lastTrade = s.lastFomoTradeAt ? Date.parse(s.lastFomoTradeAt) : NaN;
    if ((s.noMarkerSwaps1h ?? 0) > DRIFT_SHARE * trades) {
      driftWarning = "FOMO's trade marker may have changed: relayer-paid swaps without it were seen in the last hour.";
    } else if ((s.unknownRouter1h ?? 0) > DRIFT_SHARE * trades) {
      driftWarning = "FOMO trades are going through a swap router we don't know yet.";
    } else if (s.connected && Number.isFinite(lastTrade) && now - lastTrade > NO_TRADE_WARN_MS) {
      driftWarning = "No FOMO trade detected in the last 15 minutes.";
    }
  }

  const pct = meter.snapshot().pct;
  return {
    enabled,
    mode: enabled && s ? s.mode : "off",
    connected: enabled && !!s?.connected,
    lastFomoTradeAt: s?.lastFomoTradeAt ?? null,
    tracked,
    candidates,
    creditsTodayPct: Math.round(pct * 100),
    throttled: pct >= 1,
    driftWarning,
  };
}
