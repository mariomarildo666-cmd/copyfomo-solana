// Small status labels (light chips). They always carry text, so colour is never the only signal.

import type { AgentStatus, CopyStatus, LeaderboardDTO, Mode, Side, Venue } from "@/lib/types";
import { cn } from "@/components/ui/cn";
import { Icon } from "@/components/ui/icons";
import { Pill, Tag } from "@/components/ui/primitives";

/** Where the leaderboard came from: our on-chain stats, or the curated list while stats warm up. */
export function SourceTag({ source }: { source: LeaderboardDTO["source"] }) {
  if (source === "onchain")
    return (
      <Pill tone="up" dot>
        Computed on-chain
      </Pill>
    );
  return <Pill tone="warn">Warming up</Pill>;
}

/** We only hold this wallet's FOMO history since `coveredFrom` (still backfilling, or older than we index). */
export function CoverageTag({ coveredFrom, className }: { coveredFrom?: string | null; className?: string }) {
  const since = coveredFrom ? new Date(coveredFrom) : null;
  const title =
    since && Number.isFinite(since.getTime())
      ? `We only have this wallet's FOMO trades since ${since.toISOString().slice(0, 10)}`
      : "We don't have this wallet's full FOMO history for this window yet";
  return (
    <Pill tone="neutral" className={cn("shrink-0", className)} title={title}>
      partial history
    </Pill>
  );
}

/** Share of the trader's FOMO buy flow that went cross-chain (Relay): not counted in PnL, never copied. */
export function XchainTag({ share, className }: { share: number; className?: string }) {
  const pct = Math.round(share * 100);
  return (
    <Pill
      tone="warn"
      className={cn("shrink-0", className)}
      title={`${pct}% of this trader's FOMO buys went to other chains. Those aren't counted in PnL and are never copied.`}
    >
      cross-chain {pct}%
    </Pill>
  );
}

/** Where an original trade was made (rule R): in the FOMO app, or anywhere else. */
export function VenueTag({ venue, className }: { venue: Venue | undefined; className?: string }) {
  return venue === "fomo" ? (
    <Tag className={className}>FOMO</Tag>
  ) : (
    <Tag tone="muted" className={className} title="Not a FOMO trade (another app or a direct swap)">
      other app
    </Tag>
  );
}

const STATUS: Record<AgentStatus, { label: string; tone: "info" | "up" | "neutral" | "down"; dot?: boolean }> = {
  awaiting_deposit: { label: "Awaiting deposit", tone: "info", dot: true },
  active: { label: "Active", tone: "up", dot: true },
  paused: { label: "Paused", tone: "neutral" },
  stopped: { label: "Stopped", tone: "down" },
};

export function StatusPill({ status }: { status: AgentStatus }) {
  const s = STATUS[status];
  return (
    <Pill tone={s.tone} dot={s.dot}>
      {s.label}
    </Pill>
  );
}

/**
 * The one PAPER / LIVE tag: a dot and "Paper" or "Live · real SOL", everywhere a mode is shown (the shell's chip
 * uses the same look). `sm` inside dense rows (feed, floor robots).
 */
export function ModePill({ mode, size = "md", title, className }: { mode: Mode; size?: "sm" | "md"; title?: string; className?: string }) {
  const live = mode === "live";
  return (
    <Pill
      tone={live ? "live" : "paper"}
      size={size}
      className={className}
      title={title ?? (live ? "Live agent: trades real SOL" : "Paper agent: simulated fills, no real SOL")}
    >
      <ModeDot mode={mode} />
      {live ? "Live · real SOL" : "Paper"}
    </Pill>
  );
}

export function ModeDot({ mode }: { mode: Mode }) {
  return <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", mode === "live" ? "bg-live-dot" : "bg-paper-dot")} />;
}

/** Buy / Sell (or Bought / Sold) with a trend arrow + colour. */
export function SideTag({ side, past, className }: { side: Side; past?: boolean; className?: string }) {
  const buy = side === "buy";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-[12px] font-bold leading-none",
        buy ? "text-up" : "text-down",
        className,
      )}
    >
      <Icon name={buy ? "trend" : "trend-down"} size={13} strokeWidth={2.4} />
      {buy ? (past ? "Bought" : "Buy") : past ? "Sold" : "Sell"}
    </span>
  );
}

/** What happened to a copy, in one vocabulary everywhere (feed, floor, trade log, ticker). */
export const COPY_STATUS_TAG: Record<CopyStatus, { label: string; tone: "up" | "down" | "info" | "warn" }> = {
  filled: { label: "Copied", tone: "up" },
  pending: { label: "Copying", tone: "info" },
  skipped: { label: "Skipped", tone: "warn" },
  failed: { label: "Failed", tone: "down" },
};

/** The copy's status pill. `label` overrides the text (a manual close-all sell "Filled" has no original). */
export function CopyStatusTag({ status, label, className }: { status: CopyStatus; label?: string; className?: string }) {
  const s = COPY_STATUS_TAG[status];
  return (
    <Pill tone={s.tone} dot={status === "pending"} className={className}>
      {label ?? s.label}
    </Pill>
  );
}

/**
 * The FOMO handle is confirmed by a Helius identity label (or manually) — a label, not FOMO's own badge and
 * not a proof: we can't check handles against FOMO.
 */
export function VerifiedMark({ className, small }: { className?: string; small?: boolean }) {
  return (
    <span
      className={cn("inline-grid shrink-0 place-items-center rounded-full bg-mint-700 text-on-ink", small ? "size-3" : "size-3.5", className)}
      title="Handle confirmed by a Helius identity label"
    >
      <Icon name="check" size={small ? 8 : 10} strokeWidth={3.4} />
      <span className="sr-only">handle confirmed</span>
    </span>
  );
}
