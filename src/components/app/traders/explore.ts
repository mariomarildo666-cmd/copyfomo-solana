// Pure list helpers shared by the Explore grid (/) and the leaderboard (/traders): filter chips, sort orders,
// text search and number formatting. No React, client + server safe.

import type { LeaderboardWindow, TraderDTO } from "@/lib/types";
import { shortAddr } from "@/lib/format";

export const WINDOWS: { value: LeaderboardWindow; label: string; long: string }[] = [
  { value: "24h", label: "24h", long: "24 hours" },
  { value: "7d", label: "7d", long: "7 days" },
  { value: "30d", label: "30d", long: "30 days" },
];

export function windowLong(w: LeaderboardWindow): string {
  return WINDOWS.find((x) => x.value === w)?.long ?? w;
}

/** Below this, a cross-chain share is noise and gets no badge. */
export const XCHAIN_BADGE_MIN = 0.05;

// ── filter chips ────────────────────────────────────────────────────────────────────────────────────────────────

export type TraderFilter = "all" | "top" | "win" | "active";

/**
 * Chip labels, and the longer accessible name that says what each chip actually keeps. "Top" thresholds are
 * relative to the list on screen (a fixed dollar amount would mean nothing in the 24h window and everything in 30d).
 */
export const FILTERS: { value: TraderFilter; label: string; ariaLabel?: string }[] = [
  { value: "all", label: "All" },
  { value: "top", label: "Top PnL", ariaLabel: "Top PnL: the top quarter by realized profit" },
  { value: "win", label: "High win rate", ariaLabel: "High win rate: 50% or more winning trades" },
  { value: "active", label: "Most active", ariaLabel: "Most active: the top quarter by number of trades" },
];

/** Value at the top-quarter cut of `values` (descending), or null when there is nothing to rank. */
function quarterCut(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => b - a);
  return sorted[Math.max(1, Math.ceil(sorted.length / 4)) - 1] ?? null;
}

export function applyFilter(rows: TraderDTO[], filter: TraderFilter): TraderDTO[] {
  if (filter === "all") return rows;
  if (filter === "win") return rows.filter((t) => t.winRate !== null && t.winRate >= 0.5);
  if (filter === "top") {
    const cut = quarterCut(rows.flatMap((t) => (t.pnlUsd !== null && t.pnlUsd > 0 ? [t.pnlUsd] : [])));
    return cut === null ? [] : rows.filter((t) => t.pnlUsd !== null && t.pnlUsd > 0 && t.pnlUsd >= cut);
  }
  const cut = quarterCut(rows.flatMap((t) => (t.trades !== null && t.trades > 0 ? [t.trades] : [])));
  return cut === null ? [] : rows.filter((t) => t.trades !== null && t.trades > 0 && t.trades >= cut);
}

// ── sort ────────────────────────────────────────────────────────────────────────────────────────────────────────

export type TraderSort = "pnl" | "win" | "trades" | "volume" | "copiers";

export function sortOptions(win: LeaderboardWindow): { value: TraderSort; label: string }[] {
  return [
    { value: "pnl", label: `${win} PnL` },
    { value: "win", label: "Win rate" },
    { value: "trades", label: "Trades" },
    { value: "volume", label: "Volume" },
    { value: "copiers", label: "Copiers" },
  ];
}

/** Descending by a nullable number, nulls last, ties by rank (unranked last), then by wallet for a stable order. */
function byDesc(pick: (t: TraderDTO) => number | null) {
  return (a: TraderDTO, b: TraderDTO): number => {
    const x = pick(a);
    const y = pick(b);
    if (x !== y) {
      if (x === null) return 1;
      if (y === null) return -1;
      return y - x;
    }
    const ra = a.rank ?? Number.POSITIVE_INFINITY;
    const rb = b.rank ?? Number.POSITIVE_INFINITY;
    if (ra !== rb) return ra - rb;
    return a.wallet < b.wallet ? -1 : a.wallet > b.wallet ? 1 : 0;
  };
}

const SORTS: Record<TraderSort, (a: TraderDTO, b: TraderDTO) => number> = {
  pnl: byDesc((t) => t.pnlUsd),
  win: byDesc((t) => t.winRate),
  trades: byDesc((t) => t.trades),
  volume: byDesc((t) => t.volumeUsd),
  copiers: byDesc((t) => t.copiers),
};

/**
 * "pnl" keeps the server's order (its rank: realized profit, then volume; unranked rows after). The others
 * re-sort a copy.
 */
export function sortTraders(rows: TraderDTO[], sort: TraderSort): TraderDTO[] {
  if (sort === "pnl") return rows;
  return [...rows].sort(SORTS[sort]);
}

// ── search ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** Name, @handle, X handle, wallet or $token, case-insensitive. */
export function matchesQuery(t: TraderDTO, q: string): boolean {
  const needle = q.trim().toLowerCase().replace(/^[@$]/, "");
  if (!needle) return true;
  return [t.handle, t.displayName, t.xHandle, t.wallet, ...t.topTokens].some((v) => v?.toLowerCase().includes(needle));
}

/** A full Solana address (base58, 32–44 chars). */
export function isWalletLike(v: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v.trim());
}

// ── formatting ──────────────────────────────────────────────────────────────────────────────────────────────────

export function fmtCount(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "—";
  return n.toLocaleString("en-US", { notation: n >= 10_000 ? "compact" : "standard", maximumFractionDigits: 1 });
}

export function fmtWinRate(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "—";
  return `${Math.round(n * 100)}%`;
}

/** topTokens are symbols, or short mints ("Abcd…wxyz") when we have no symbol; never print a mint as "$…". */
export function tokenChip(t: string): string {
  if (t.includes("…")) return t;
  return t.length >= 32 ? shortAddr(t) : `$${t.replace(/^\$/, "")}`;
}

/** Tokens with a symbol, for prose ("Top: $STONK, $CATE"); falls back to the short mints when none has one. */
export function namedTokens(tokens: string[], max = 3): string[] {
  const named = tokens.filter((t) => !t.includes("…") && t.length < 32);
  return (named.length ? named : tokens).slice(0, max).map(tokenChip);
}
