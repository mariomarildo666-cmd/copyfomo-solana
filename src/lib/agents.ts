// DB → DTO mapping and shared agent queries (API routes + public floor/feed).
// Secrets (ownerKeyHash, sealedSecret) never leave this module: DTO mappers pick fields explicitly.
// Owner-only fields (ownerWallet, payoutAddress) appear only when the caller says the viewer is the owner
// (auth.isOwnerOf). Public reads never trigger RPC: they use the balance the worker stored (finding F26).

import { Prisma, type Agent, type Command, type Trader } from "@prisma/client";
import { isOwnerOf } from "./auth";
import { config } from "./config";
import { kvGet, prisma } from "./db";
import { computeSellFee, liveWithdrawReserveSol, withdrawableSol } from "./fees";
import { HELIUS_PRIORITY } from "./helius";
import { getSolUsd, getUsdPriceStatus } from "./prices";
import { getSolBalanceBudgeted } from "./solana";
import type {
  AgentDTO,
  AgentDetailDTO,
  AgentStatus,
  AgentSummaryDTO,
  CommandDTO,
  CommandStatus,
  CommandType,
  CopyStatus,
  CopyTradeDTO,
  FeedDTO,
  FeedItemDTO,
  FloorDTO,
  Mode,
  PositionDTO,
  Side,
  SizingMode,
  TraderDTO,
  TraderEventDTO,
  Venue,
} from "./types";

/** Relations every agent mapper needs. Fetch agents with `include: agentInclude`. */
export const agentInclude = {
  follows: { include: { trader: true }, orderBy: { createdAt: "asc" } },
  positions: { include: { trader: true }, orderBy: { openedAt: "asc" } },
} satisfies Prisma.AgentInclude;

export type AgentWithRelations = Prisma.AgentGetPayload<{ include: typeof agentInclude }>;

/** An owner-triggered balance read is reused for this long (per agent, single-flight). */
const BALANCE_FRESH_MS = 20_000;
const HEARTBEAT_FRESH_MS = 60_000;
const SPARK_LEN = 12;
/** Median latency is computed over each agent's most recent filled trades. */
const LATENCY_SAMPLE = 100;
const DETAIL_TRADES = 100;
/** An unpriced position counts at cost this long after it was opened (Jupiter may not index a new token yet). */
const UNPRICED_GRACE_MS = 24 * 3600_000;
/** "Close all first" estimates sell priced positions at this share of their value (slippage, fees). */
const CLOSE_ESTIMATE_HAIRCUT = 0.95;

// ── Small helpers ───────────────────────────────────────────────────────────────────────────────────

function asMode(s: string): Mode {
  return s === "live" ? "live" : "paper";
}
function asStatus(s: string): AgentStatus {
  return s === "active" || s === "paused" || s === "stopped" ? s : "awaiting_deposit";
}
function asSizing(s: string): SizingMode {
  return s === "fixed" || s === "proportional" ? s : "mirror";
}
function asSide(s: string): Side {
  return s === "sell" ? "sell" : "buy";
}
function asVenue(s: string): Venue {
  return s === "fomo" ? "fomo" : "other";
}
function asCopyStatus(s: string): CopyStatus {
  return s === "filled" || s === "failed" || s === "skipped" ? s : "pending";
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

/** raw base units → UI amount. Precision loss past 2^53 is fine for display/valuation. */
function uiAmount(raw: string, decimals: number): number {
  const n = Number(raw);
  return Number.isFinite(n) ? n / 10 ** decimals : 0;
}

function round(n: number, digits = 9): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function trimNum(n: number): string {
  return String(Number(n.toFixed(4)));
}

function traderPick(t: Trader): Pick<TraderDTO, "wallet" | "handle" | "displayName" | "avatarUrl"> {
  return { wallet: t.wallet, handle: t.handle, displayName: t.displayName, avatarUrl: t.avatarUrl };
}

// ── Stats & valuation (batched across agents) ───────────────────────────────────────────────────────

interface TradeStats {
  copies: number;
  boughtSol: number;
  soldSol: number;
  /** Σ CopyTrade.feeSol of filled trades: every platform fee charged (paid + owed). */
  feesSol: number;
  lastTradeAt: Date | null;
  latencies: number[];
  spark: { side: Side; solAmount: number }[];
}

function emptyStats(): TradeStats {
  return { copies: 0, boughtSol: 0, soldSol: 0, feesSol: 0, lastTradeAt: null, latencies: [], spark: [] };
}

async function loadTradeStats(agentIds: string[]): Promise<Map<string, TradeStats>> {
  const out = new Map<string, TradeStats>(agentIds.map((id) => [id, emptyStats()]));
  if (agentIds.length === 0) return out;

  const [grouped, recent] = await Promise.all([
    prisma.copyTrade.groupBy({
      by: ["agentId", "side"],
      where: { agentId: { in: agentIds }, status: "filled" },
      _sum: { solAmount: true, feeSol: true },
      _count: { _all: true },
      _max: { createdAt: true },
    }),
    // Most recent filled trades per agent in one query (window function works on SQLite ≥ 3.25 and Postgres).
    prisma.$queryRaw<Array<{ agentId: string; side: string; solAmount: number | string; latencyMs: number | bigint | null }>>`
      SELECT "agentId", "side", "solAmount", "latencyMs" FROM (
        SELECT "agentId", "side", "solAmount", "latencyMs",
               ROW_NUMBER() OVER (PARTITION BY "agentId" ORDER BY "createdAt" DESC, "id" DESC) AS rn
        FROM "CopyTrade"
        WHERE "status" = 'filled' AND "agentId" IN (${Prisma.join(agentIds)})
      ) ranked
      WHERE rn <= ${LATENCY_SAMPLE}
      ORDER BY "agentId", rn`,
  ]);

  for (const g of grouped) {
    const s = out.get(g.agentId);
    if (!s) continue;
    const sum = g._sum.solAmount ?? 0;
    s.copies += g._count._all;
    s.feesSol += g._sum.feeSol ?? 0;
    if (g.side === "sell") s.soldSol += sum;
    else s.boughtSol += sum;
    const max = g._max.createdAt;
    if (max && (!s.lastTradeAt || max > s.lastTradeAt)) s.lastTradeAt = max;
  }

  // Rows arrive newest-first per agent.
  for (const r of recent) {
    const s = out.get(r.agentId);
    if (!s) continue;
    if (s.spark.length < SPARK_LEN) s.spark.push({ side: asSide(r.side), solAmount: round(Number(r.solAmount), 6) });
    if (r.latencyMs !== null) {
      const ms = Number(r.latencyMs);
      if (Number.isFinite(ms) && ms >= 0) s.latencies.push(ms);
    }
  }
  for (const s of out.values()) s.spark.reverse();
  return out;
}

interface Valuation {
  /** USD prices by mint; missing = unknown. */
  prices: Record<string, number>;
  solUsd: number | null;
  /** Jupiter answered and has no price for these mints. */
  unpriced: Set<string>;
  /** No price because we could not ask (outage, rate limit): value at cost, flag as stale. */
  unavailable: Set<string>;
}

async function loadValuation(mints: string[]): Promise<Valuation> {
  if (mints.length === 0) return { prices: {}, solUsd: null, unpriced: new Set(), unavailable: new Set() };
  const [status, solUsd] = await Promise.all([
    getUsdPriceStatus(mints).catch(() => ({ prices: {} as Record<string, number>, unpriced: new Set<string>(), unavailable: new Set(mints) })),
    getSolUsd().catch(() => null),
  ]);
  return { prices: status.prices, solUsd, unpriced: status.unpriced, unavailable: status.unavailable };
}

function positionValueSol(p: { mint: string; rawAmount: string; decimals: number }, v: Valuation): number | null {
  const usd = v.prices[p.mint];
  if (usd === undefined || v.solUsd === null || v.solUsd <= 0) return null;
  return (uiAmount(p.rawAmount, p.decimals) * usd) / v.solUsd;
}

type OpenPosition = { mint: string; rawAmount: string; decimals: number; costSol: number; openedAt: Date };

interface OpenValuation {
  /** Value counted in equity / PnL (priced value + unpriced counted at cost per the rules below). */
  valueSol: number;
  /** Priced positions only. */
  pricedValueSol: number;
  pricedCostSol: number;
  /** Part of valueSol that is unpriced positions counted at cost. */
  atCostSol: number;
  unpricedCount: number;
  unpricedCostSol: number;
  stale: boolean;
}

/**
 * Open positions → value (finding F19). Priced → market value. No price:
 *  - prices unavailable (outage / no SOL/USD): at cost, and the valuation is flagged stale;
 *  - Jupiter has no price and the position is < 24 h old: at cost (new tokens may not be indexed yet);
 *  - Jupiter has no price and the position is older: 0 (dead / rugged token).
 */
function valueOpenPositions(positions: readonly OpenPosition[], v: Valuation, now: number): OpenValuation {
  const out: OpenValuation = { valueSol: 0, pricedValueSol: 0, pricedCostSol: 0, atCostSol: 0, unpricedCount: 0, unpricedCostSol: 0, stale: false };
  const feedDown = v.solUsd === null || v.solUsd <= 0;
  for (const p of positions) {
    const value = positionValueSol(p, v);
    if (value !== null) {
      out.valueSol += value;
      out.pricedValueSol += value;
      out.pricedCostSol += p.costSol;
      continue;
    }
    out.unpricedCount++;
    out.unpricedCostSol += p.costSol;
    const unavailable = feedDown || !v.unpriced.has(p.mint);
    if (unavailable) out.stale = true;
    if (unavailable || now - p.openedAt.getTime() < UNPRICED_GRACE_MS) {
      out.valueSol += p.costSol;
      out.atCostSol += p.costSol;
    }
  }
  return out;
}

function toPositionDTO(p: AgentWithRelations["positions"][number], v: Valuation): PositionDTO {
  const valueSol = positionValueSol(p, v);
  return {
    mint: p.mint,
    symbol: p.symbol,
    trader: { wallet: p.trader.wallet, handle: p.trader.handle, displayName: p.trader.displayName },
    decimals: p.decimals,
    rawAmount: p.rawAmount,
    amount: uiAmount(p.rawAmount, p.decimals),
    costSol: round(p.costSol),
    valueSol: valueSol === null ? null : round(valueSol),
    unrealizedSol: valueSol === null ? null : round(valueSol - p.costSol),
    realizedSol: round(p.realizedSol),
    openedAt: p.openedAt.toISOString(),
  };
}

/** Balance shown in lists and to non-owners: stored values only (no RPC). The worker refreshes live balances. */
function storedBalanceSol(a: Agent): number {
  return asMode(a.mode) === "paper" ? a.paperSol : a.lastBalanceSol;
}

interface Summary {
  dto: AgentSummaryDTO;
  open: OpenValuation;
  /** PnL with every unpriced position at 0: what the public floor ranks on. */
  rankPnlSol: number;
}

function buildSummary(a: AgentWithRelations, stats: TradeStats, v: Valuation, balanceSol: number, now = Date.now()): Summary {
  // PnL from the trade ledger, so sleeves that were fully closed (and deleted) still count, net of platform fees:
  //   Σ sell proceeds − Σ buy spend + value of open sleeves − Σ fees charged.
  const open = valueOpenPositions(a.positions, v, now);
  const pnlSol = stats.soldSol - stats.boughtSol + open.valueSol - stats.feesSol;
  // Fees owed (live) still sit in the wallet but belong to the platform.
  const equitySol = balanceSol - (asMode(a.mode) === "live" ? Math.max(0, a.feeOwedSol) : 0) + open.valueSol;
  // ROI on net capital put in (equity − pnl = deposits − withdrawals, less network costs); see F44.
  const capital = equitySol - pnlSol;
  const roiPct =
    capital > 1e-6 ? (pnlSol / capital) * 100 : stats.boughtSol > 0 ? (pnlSol / stats.boughtSol) * 100 : 0;

  return {
    open,
    rankPnlSol: pnlSol - open.atCostSol,
    dto: {
      id: a.id,
      slug: a.slug,
      name: a.name,
      mode: asMode(a.mode),
      status: asStatus(a.status),
      sizingMode: asSizing(a.sizingMode),
      traders: a.follows.map((f) => traderPick(f.trader)),
      equitySol: round(equitySol),
      pnlSol: round(pnlSol),
      roiPct: round(roiPct, 4),
      unpricedCount: open.unpricedCount,
      unpricedCostSol: round(open.unpricedCostSol),
      valuationStale: open.stale,
      copies: stats.copies,
      medianLatencyMs: median(stats.latencies),
      spark: stats.spark,
      lastTradeAt: stats.lastTradeAt ? stats.lastTradeAt.toISOString() : null,
      createdAt: a.createdAt.toISOString(),
    },
  };
}

async function buildSummaries(agents: AgentWithRelations[]): Promise<Summary[]> {
  const mints = [...new Set(agents.flatMap((a) => a.positions.map((p) => p.mint)))];
  const [stats, valuation] = await Promise.all([loadTradeStats(agents.map((a) => a.id)), loadValuation(mints)]);
  return agents.map((a) => buildSummary(a, stats.get(a.id) ?? emptyStats(), valuation, storedBalanceSol(a)));
}

// ── Public mappers ──────────────────────────────────────────────────────────────────────────────────

/** "mirror 1:1 · max 1 SOL" / "fixed 0.1 SOL" / "proportional · max 1 SOL" */
export function sizeLabel(a: Agent): string {
  switch (asSizing(a.sizingMode)) {
    case "fixed":
      return `fixed ${trimNum(a.fixedSol)} SOL`;
    case "proportional":
      return `proportional · max ${trimNum(a.maxPerTradeSol)} SOL`;
    default:
      return `mirror 1:1 · max ${trimNum(a.maxPerTradeSol)} SOL`;
  }
}

export async function toAgentSummary(a: AgentWithRelations): Promise<AgentSummaryDTO> {
  const [summary] = await buildSummaries([a]);
  return summary!.dto;
}

export interface AgentViewOptions {
  /**
   * The viewer owns this agent (auth.isOwnerOf / requireOwner). Adds ownerWallet + payoutAddress and allows an
   * on-demand balance refresh. Default false: the public view.
   */
  isOwner?: boolean;
  /** Owner views only: re-read a live balance older than 20 s (budget-checked, single-flight). Default: isOwner. */
  refreshBalance?: boolean;
}

/**
 * Full AgentDTO (create / PATCH / deposit responses, owner dashboards). Public view by default; pass
 * { isOwner: true } from owner-authenticated routes. Only owner views may cost an RPC call.
 */
export async function toAgentDTO(a: AgentWithRelations, opts: AgentViewOptions = {}): Promise<AgentDTO> {
  const isOwner = opts.isOwner === true;
  const mints = [...new Set(a.positions.map((p) => p.mint))];
  const [stats, valuation, balanceSol] = await Promise.all([
    loadTradeStats([a.id]),
    loadValuation(mints),
    isOwner && (opts.refreshBalance ?? true) ? agentBalanceSol(a) : Promise.resolve(storedBalanceSol(a)),
  ]);
  const dto = agentDTOFrom(a, stats.get(a.id) ?? emptyStats(), valuation, balanceSol, isOwner);
  if (isOwner && dto.mode === "live") {
    const untracked = await untrackedTokens(a.id);
    if (untracked.length > 0) dto.untrackedTokens = untracked;
  }
  return dto;
}

/** The worker's report of tokens no sleeve accounts for (Kv "holdings:<agentId>"). Owner views only. */
async function untrackedTokens(agentId: string): Promise<{ mint: string; raw: string; why: string }[]> {
  const row = await kvGet<{ untracked?: unknown }>(`holdings:${agentId}`).catch(() => null);
  const list = Array.isArray(row?.value?.untracked) ? row.value.untracked : [];
  const out: { mint: string; raw: string; why: string }[] = [];
  for (const u of list.slice(0, 20)) {
    if (!u || typeof u !== "object") continue;
    const { mint, raw, why } = u as Record<string, unknown>;
    if (typeof mint === "string" && typeof raw === "string" && typeof why === "string") out.push({ mint, raw, why: why.slice(0, 120) });
  }
  return out;
}

function agentDTOFrom(a: AgentWithRelations, stats: TradeStats, v: Valuation, balanceSol: number, isOwner: boolean): AgentDTO {
  const mode = asMode(a.mode);
  const { dto, open } = buildSummary(a, stats, v, balanceSol);
  const feeOwedSol = mode === "live" ? Math.max(0, a.feeOwedSol) : 0;
  // Same ceiling as the worker: while positions are open the live sell reserve stays behind (finding F7).
  const withdrawable = withdrawableSol({
    mode,
    balanceSol,
    feeOwedSol,
    holdsTokens: a.positions.length > 0,
    maxPriorityFeeLamports: config.maxPriorityFeeLamports,
  });
  const pricedProceeds = open.pricedValueSol * CLOSE_ESTIMATE_HAIRCUT;
  const closeFee = computeSellFee({ proceedsSol: pricedProceeds, costPartSol: open.pricedCostSol, bps: config.platformFeeBps });
  return {
    ...dto,
    depositAddress: a.depositAddress,
    isOwner,
    ...(isOwner && a.ownerWallet ? { ownerWallet: a.ownerWallet } : {}),
    ...(isOwner ? { payoutAddress: a.payoutAddress } : {}),
    fixedSol: a.fixedSol,
    maxPerTradeSol: a.maxPerTradeSol,
    minReserveSol: a.minReserveSol,
    slippageBps: a.slippageBps,
    copySells: a.copySells,
    balanceSol: round(balanceSol),
    balanceAt: mode === "live" && a.balanceAt ? a.balanceAt.toISOString() : null,
    feesPaidSol: round(Math.max(0, a.feesPaidSol)),
    feeOwedSol: round(feeOwedSol),
    withdrawableSol: round(withdrawable),
    withdrawAfterCloseSol: round(Math.max(0, withdrawable + pricedProceeds - closeFee)),
  };
}

/**
 * What a withdrawal may ask for right now (the withdraw route's ceiling; the worker re-checks on-chain).
 *  - `withdrawableSol`: balance − fees owed − live reserve (the sell reserve while positions are open, else
 *    LIVE_WITHDRAW_BUFFER_SOL; same rule as the worker).
 *  - `withdrawAfterCloseSol`: estimate when positions are sold first: + priced positions at 95%, − the fee on
 *    their estimated profit. Unpriced positions are never counted (finding F19).
 * Owner-only (it may refresh a stale live balance).
 */
export async function withdrawLimits(a: AgentWithRelations): Promise<{
  balanceSol: number;
  feeOwedSol: number;
  reserveSol: number;
  withdrawableSol: number;
  withdrawAfterCloseSol: number;
}> {
  const dto = await toAgentDTO(a, { isOwner: true });
  return {
    balanceSol: dto.balanceSol,
    feeOwedSol: dto.feeOwedSol,
    reserveSol:
      dto.mode === "live"
        ? liveWithdrawReserveSol({ holdsTokens: a.positions.length > 0, maxPriorityFeeLamports: config.maxPriorityFeeLamports })
        : 0,
    withdrawableSol: dto.withdrawableSol,
    withdrawAfterCloseSol: dto.withdrawAfterCloseSol,
  };
}

type EventWithTrader = Prisma.TraderEventGetPayload<{ include: { trader: true } }>;

function toTraderEventDTO(e: EventWithTrader): TraderEventDTO {
  return {
    id: e.id,
    signature: e.signature,
    side: asSide(e.side),
    mint: e.mint,
    symbol: e.symbol,
    solAmount: round(e.solAmount),
    venue: asVenue(e.venue),
    blockTime: e.blockTime.toISOString(),
    trader: traderPick(e.trader),
  };
}

type TradeWithEvent = Prisma.CopyTradeGetPayload<{ include: { event: { include: { trader: true } } } }>;

function toCopyTradeDTO(t: TradeWithEvent): CopyTradeDTO {
  return {
    id: t.id,
    side: asSide(t.side),
    mint: t.mint,
    symbol: t.symbol,
    solAmount: round(t.solAmount),
    status: asCopyStatus(t.status),
    // "sending": a signed live swap that is still settling (the reconciler records it from the chain).
    reason: t.reason ?? (t.status === "sending" ? "swap sent; waiting for confirmation" : null),
    signature: t.signature,
    latencyMs: t.latencyMs,
    feeSol: round(t.feeSol),
    createdAt: t.createdAt.toISOString(),
    original: t.event ? toTraderEventDTO(t.event) : null,
  };
}

export function toCommandDTO(c: Command): CommandDTO {
  const type: CommandType = c.type === "close_all" ? "close_all" : "withdraw";
  const status: CommandStatus =
    c.status === "running" || c.status === "done" || c.status === "failed" ? c.status : "pending";
  return {
    id: c.id,
    type,
    status,
    result: c.result,
    createdAt: c.createdAt.toISOString(),
    doneAt: c.doneAt ? c.doneAt.toISOString() : null,
  };
}

/** Find by id or slug, with agentInclude relations. */
export async function findAgent(idOrSlug: string): Promise<AgentWithRelations | null> {
  if (!idOrSlug) return null;
  return prisma.agent.findFirst({
    where: { OR: [{ id: idOrSlug }, { slug: idOrSlug }] },
    include: agentInclude,
  });
}

/**
 * Agent page data. `req` (optional) decides the view: the owner (session wallet, or a legacy x-owner-key)
 * gets owner-only fields and a fresh balance; everyone else gets stored values and no RPC call (F26).
 */
export async function getAgentDetail(idOrSlug: string, opts: { req?: Request | null; isOwner?: boolean } = {}): Promise<AgentDetailDTO | null> {
  const a = await findAgent(idOrSlug);
  if (!a) return null;
  const isOwner = opts.isOwner ?? isOwnerOf(opts.req, a);

  const mints = [...new Set(a.positions.map((p) => p.mint))];
  const [stats, valuation, balanceSol, trades] = await Promise.all([
    loadTradeStats([a.id]),
    loadValuation(mints),
    isOwner ? agentBalanceSol(a) : Promise.resolve(storedBalanceSol(a)),
    prisma.copyTrade.findMany({
      where: { agentId: a.id },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: DETAIL_TRADES,
      include: { event: { include: { trader: true } } },
    }),
  ]);

  return {
    agent: agentDTOFrom(a, stats.get(a.id) ?? emptyStats(), valuation, balanceSol, isOwner),
    positions: a.positions.map((p) => toPositionDTO(p, valuation)),
    trades: trades.map(toCopyTradeDTO),
  };
}

/** Agents owned by `wallet` (GET /api/me/agents), newest first. Stored balances only (no RPC). */
export async function listMyAgents(wallet: string, limit = 50): Promise<AgentSummaryDTO[]> {
  const agents = await prisma.agent.findMany({
    where: { ownerWallet: wallet },
    include: agentInclude,
    orderBy: { createdAt: "desc" },
    take: Math.min(Math.max(Math.floor(limit) || 50, 1), 100),
  });
  return (await buildSummaries(agents)).map((s) => s.dto);
}

// ── Balance & worker status ─────────────────────────────────────────────────────────────────────────

const balanceInflight = new Map<string, Promise<number>>();

/**
 * OWNER paths only (withdraw, activation checks, owner dashboards): paper → paperSol; live → lastBalanceSol when
 * < 20 s old, else one budget-checked read (P2, single-flight per agent) that is persisted. Falls back to the
 * stored value on any error. Public views must use the stored balance instead (finding F26).
 */
export async function agentBalanceSol(a: Agent): Promise<number> {
  if (asMode(a.mode) === "paper") return a.paperSol;
  if (a.balanceAt && Date.now() - a.balanceAt.getTime() < BALANCE_FRESH_MS) return a.lastBalanceSol;
  let running = balanceInflight.get(a.id);
  if (!running) {
    running = (async () => {
      const sol = await getSolBalanceBudgeted(a.depositAddress, HELIUS_PRIORITY.backfill);
      await prisma.agent.updateMany({ where: { id: a.id }, data: { lastBalanceSol: sol, balanceAt: new Date() } });
      return sol;
    })().finally(() => balanceInflight.delete(a.id));
    balanceInflight.set(a.id, running);
  }
  try {
    const sol = await running;
    a.lastBalanceSol = sol;
    a.balanceAt = new Date();
    return sol;
  } catch (err) {
    console.warn(`[agents] balance refresh failed for ${a.id}: ${err instanceof Error ? err.message : String(err)}`);
    return a.lastBalanceSol;
  }
}

export async function workerOnline(): Promise<boolean> {
  try {
    const hb = await kvGet<unknown>("worker:heartbeat");
    return hb !== null && Date.now() - hb.updatedAt.getTime() < HEARTBEAT_FRESH_MS;
  } catch {
    return false;
  }
}

// ── Public floor ────────────────────────────────────────────────────────────────────────────────────

/** Upper bound on agents ranked for the floor (keeps the page O(1) as the table grows). */
const FLOOR_CANDIDATES = 100;

export async function listFloor(limit = 24): Promise<FloorDTO> {
  const n = Math.min(Math.max(Math.floor(limit) || 24, 1), 100);
  const visible = { status: { not: "stopped" } } satisfies Prisma.AgentWhereInput;

  const agentCount = await prisma.agent.count({ where: visible });
  if (agentCount === 0) {
    return { demo: false, agents: [], stats: { mode: config.mode, agents: 0, copies: 0, volumeSol: 0, medianLatencyMs: null } };
  }

  // Headline stats count the deployment's own mode only (finding F41): on a live deployment, simulated paper
  // copies must not inflate copies / volume / latency. A paper deployment counts its paper agents.
  const statsMode = config.mode;
  const modeTrades = { status: "filled", agent: { mode: statsMode } } satisfies Prisma.CopyTradeWhereInput;
  const [agents, modeAgents, totals, latencySample] = await Promise.all([
    prisma.agent.findMany({
      where: visible,
      include: agentInclude,
      orderBy: { updatedAt: "desc" },
      take: FLOOR_CANDIDATES,
    }),
    prisma.agent.count({ where: { ...visible, mode: statsMode } }),
    prisma.copyTrade.aggregate({ where: modeTrades, _count: { _all: true }, _sum: { solAmount: true } }),
    prisma.copyTrade.findMany({
      where: { ...modeTrades, latencyMs: { not: null } },
      orderBy: { createdAt: "desc" },
      take: 500,
      select: { latencyMs: true },
    }),
  ]);

  const summaries = await buildSummaries(agents);
  // Agents with activity first, best PnL first (unpriced positions at 0: no break-even for rugs); brand-new
  // agents after, newest first.
  summaries.sort((x, y) => {
    if ((x.dto.copies > 0) !== (y.dto.copies > 0)) return x.dto.copies > 0 ? -1 : 1;
    if (x.dto.copies > 0) return y.rankPnlSol - x.rankPnlSol;
    return y.dto.createdAt.localeCompare(x.dto.createdAt);
  });

  return {
    demo: false,
    agents: summaries.slice(0, n).map((s) => s.dto),
    stats: {
      mode: statsMode,
      agents: modeAgents,
      copies: totals._count._all,
      volumeSol: round(totals._sum.solAmount ?? 0, 4),
      medianLatencyMs: median(latencySample.flatMap((r) => (r.latencyMs === null ? [] : [r.latencyMs]))),
    },
  };
}

// ── Public feed ─────────────────────────────────────────────────────────────────────────────────────

const COPY_STATUS_PREFERENCE: Record<CopyStatus, number> = { filled: 0, pending: 1, skipped: 2, failed: 3 };

export async function listFeed(limit = 30): Promise<FeedDTO> {
  const n = Math.min(Math.max(Math.floor(limit) || 30, 1), 100);
  const events = await prisma.traderEvent.findMany({
    orderBy: [{ blockTime: "desc" }, { id: "desc" }],
    take: n,
    include: {
      trader: true,
      copies: {
        orderBy: { createdAt: "asc" },
        take: 20,
        include: { agent: { select: { id: true, name: true, slug: true, mode: true } } },
      },
    },
  });
  if (events.length === 0) return { demo: false, items: [] };

  const items: FeedItemDTO[] = events.map((e) => {
    // Best status first; on a tie a live copy beats a simulated paper one (finding F41).
    const best = [...e.copies].sort(
      (x, y) =>
        COPY_STATUS_PREFERENCE[asCopyStatus(x.status)] - COPY_STATUS_PREFERENCE[asCopyStatus(y.status)] ||
        (x.agent.mode === "live" ? 0 : 1) - (y.agent.mode === "live" ? 0 : 1),
    )[0];
    return {
      id: e.id,
      original: toTraderEventDTO(e),
      copy: best
        ? {
            agentId: best.agent.id,
            agentName: best.agent.name,
            agentSlug: best.agent.slug,
            mode: asMode(best.agent.mode),
            status: asCopyStatus(best.status),
            solAmount: round(best.solAmount),
            latencyMs: best.latencyMs,
            reason: best.reason,
          }
        : null,
    };
  });
  return { demo: false, items };
}
