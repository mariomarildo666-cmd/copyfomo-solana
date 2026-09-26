// Pure view helpers for agents / traders / copies. Client + server safe.

import type { AgentStatus, AgentSummaryDTO, CopyStatus, FeedItemDTO, Mode, Side, TraderDTO } from "@/lib/types";
import { robotMood, type RobotMood } from "@/components/bots/params";
import { fmtMs, fmtSol, tokenLabel } from "@/lib/format";

type TraderRef = Pick<TraderDTO, "wallet" | "handle">;

/** Seed of a trader's robot: the wallet (stable across renames); the handle is only a defensive fallback. */
export function traderSeed(t: TraderRef): string {
  return t.wallet || t.handle || "unknown-trader";
}

/** An agent's robot mood: asleep when paused / stopped, else the side of its latest copy, else idle. */
export function agentMood(a: Pick<AgentSummaryDTO, "status" | "spark">): RobotMood {
  return robotMood({ status: a.status, lastSide: a.spark.at(-1)?.side ?? null });
}

/**
 * Where an agent tile links to. Demo agents are generated and have no detail page,
 * so they send the visitor to build a real one instead.
 */
export function agentHref(slug: string, demo: boolean): string {
  return demo ? "/create" : `/agents/${encodeURIComponent(slug)}`;
}

export function createHref(target: string): string {
  return `/create?t=${encodeURIComponent(target)}`;
}

/** Past-tense verb of a trade, for sentences ("bought $BONK"). */
export function sideWord(side: Side): "bought" | "sold" {
  return side === "buy" ? "bought" : "sold";
}

export type Tone = "up" | "down" | "warn" | "info" | "muted";

/** Same words and tones as the CopyStatusTag pill (components/app/Tags). */
export const COPY_STATUS: Record<CopyStatus, { label: string; tone: Tone }> = {
  filled: { label: "Copied", tone: "up" },
  skipped: { label: "Skipped", tone: "warn" },
  failed: { label: "Failed", tone: "down" },
  pending: { label: "Copying", tone: "info" },
};

/** Same words as the StatusPill (components/app/Tags). */
export const AGENT_STATUS: Record<AgentStatus, { label: string; tone: Tone }> = {
  active: { label: "Active", tone: "up" },
  awaiting_deposit: { label: "Awaiting deposit", tone: "info" },
  paused: { label: "Paused", tone: "muted" },
  stopped: { label: "Stopped", tone: "down" },
};

/** Short, lower-case reason for bubbles/tickers: "insufficient balance" → "no SOL". */
export function shortReason(reason: string | null): string {
  if (!reason) return "no reason given";
  const r = reason.toLowerCase();
  if (r.includes("insufficient") || r.includes("balance")) return "no SOL";
  if (r.includes("not holding")) return "not holding";
  if (r.includes("slippage")) return "slippage";
  if (r.includes("quote")) return "no route";
  return r.length > 28 ? `${r.slice(0, 27)}…` : r;
}

/**
 * Whether a feed copy was simulated. Uses the copy's own `mode` when the API sends it; otherwise a paper
 * deployment only ever fills paper agents, and in a live one we can't tell (null).
 */
export function copyMode(copy: FeedItemDTO["copy"], deploymentMode: Mode): Mode | null {
  const own = (copy as { mode?: unknown } | null)?.mode;
  if (own === "paper" || own === "live") return own;
  return deploymentMode === "paper" ? "paper" : null;
}

export interface TickerParts {
  agent: string;
  agentId: string;
  /** "bought" / "sold" for fills, else the copy status in lower case ("skipped"). */
  verb: string;
  tone: Tone;
  token: string;
  /** SOL amount (fills and pending copies), else null. */
  amount: string | null;
  /** latency, "paper (simulated)", or the short reason of a skip / failure. */
  note: string | null;
  /** The whole line after the verb, as plain text. */
  detail: string;
}

/** One ticker entry for a feed row, or null when no agent acted on it. */
export function tickerParts(item: FeedItemDTO, deploymentMode: Mode = "live"): TickerParts | null {
  const c = item.copy;
  if (!c) return null;
  const token = tokenLabel(item.original.symbol, item.original.mint);
  const base = { agent: c.agentName, agentId: c.agentId, token };
  if (c.status === "filled") {
    const paper = copyMode(c, deploymentMode) === "paper";
    const amount = fmtSol(c.solAmount);
    const note = paper ? "paper (simulated)" : fmtMs(c.latencyMs);
    return {
      ...base,
      verb: sideWord(item.original.side),
      tone: item.original.side === "buy" ? "up" : "down",
      amount,
      note,
      detail: `${token} · ${amount} · ${note}`,
    };
  }
  const s = COPY_STATUS[c.status];
  const amount = c.status === "pending" ? fmtSol(c.solAmount) : null;
  const note = c.status === "pending" ? null : shortReason(c.reason);
  return { ...base, verb: s.label.toLowerCase(), tone: s.tone, amount, note, detail: `${token} · ${amount ?? note}` };
}
