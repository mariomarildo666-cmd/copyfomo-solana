// One ORIGINAL trade next to what a COPY agent did about it: the same row wherever pairs are shown (the home feed
// preview, /feed and an agent's trade log). No hooks: renders in server and client components alike.
//
//   <TradePairList label="…">                      a card with divided rows (a size container: rows go
//     <TradePairRow original={…} copy={…} />        side by side from 720 px of card width, stacked below)
//   </TradePairList>
//
// Type rule: amounts are mono (`num`), words and times are the body font.

import Link from "next/link";
import type { ReactNode } from "react";
import type { CopyStatus, Side, TraderDTO, Venue } from "@/lib/types";
import { fmtMs, fmtSol, solscanTx, timeAgo, traderLabel } from "@/lib/format";
import { RobotTile } from "@/components/bots/RobotTile";
import type { RobotMood } from "@/components/bots/params";
import { cn } from "@/components/ui/cn";
import { Icon, type IconName } from "@/components/ui/icons";
import { shortReason } from "@/components/landing/model";
import { CopyStatusTag, ModePill, SideTag, VenueTag } from "../Tags";
import { traderSeed } from "../TraderAvatar";

export interface PairOriginal {
  trader: Pick<TraderDTO, "wallet" | "handle" | "displayName">;
  side: Side;
  /** Token label ($BONK, or a short mint). */
  token: string;
  solAmount: number;
  blockTime: string;
  /** Original transaction; null hides the link (demonstration rows). */
  signature: string | null;
  /** Where the original was made; null hides the tag (demonstration rows). */
  venue: Venue | null;
}

export interface PairCopy {
  agentId: string;
  agentName: string;
  /** The agent's page; null shows the name without a link (demo rows, or the agent's own page). */
  href: string | null;
  status: CopyStatus;
  /** Overrides the status pill's text ("Filled" for a manual sell that mirrors nothing). */
  statusLabel?: string;
  side: Side;
  solAmount: number;
  /** Paper agent: a simulated fill (priced from a quote, no swap sent). */
  paper: boolean;
  reason: string | null;
  latencyMs: number | null;
}

/** What the copy's robot face shows: the side it filled, idle while copying, blinking at a skip / failure. */
function copyMood(status: CopyStatus, side: Side): RobotMood {
  if (status === "filled") return side;
  if (status === "pending") return "idle";
  return "blink";
}

const LABEL = "text-[12px] font-semibold leading-none";
const NAME = "block truncate text-[13.5px] font-bold tracking-[-0.01em] text-text";

/** Trader robot + "Original · 2m ago · FOMO", the trader, and what they did. */
function OriginalSide({ o, now }: { o: PairOriginal; now: number }) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <RobotTile seed={traderSeed(o.trader)} variant="trader" mood={o.side} size="xs" />
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className={cn(LABEL, "text-muted")}>Original</span>
          <time dateTime={o.blockTime} className="text-[12px] font-medium leading-none text-muted">
            {timeAgo(o.blockTime, now)}
          </time>
          {o.venue ? <VenueTag venue={o.venue} /> : null}
        </p>
        <p className={cn(NAME, "mt-1")}>{traderLabel(o.trader)}</p>
        <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[12.5px]">
          <SideTag side={o.side} past />
          <span className="truncate font-semibold text-text">{o.token}</span>
          <span className="num shrink-0 text-[12px] text-muted">{fmtSol(o.solAmount)}</span>
        </p>
      </div>
      {o.signature ? <TxLink sig={o.signature} label="tx" srLabel="original transaction on Solscan" /> : null}
    </div>
  );
}

/** A manual sell (close-all / withdraw) mirrors nothing: say so where the original would be. */
function ManualSide({ token }: { token: string }) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-icon border border-dashed border-border-strong text-icon">
        <Icon name="wallet" size={16} strokeWidth={2} />
      </span>
      <div className="min-w-0 flex-1">
        <p className={cn(LABEL, "text-muted")}>Manual</p>
        <p className={cn(NAME, "mt-1")}>Close-all or withdraw</p>
        <p className="mt-0.5 truncate text-[12.5px] font-semibold text-text-2">{token}</p>
      </div>
    </div>
  );
}

function CopySide({ c }: { c: PairCopy }) {
  const traded = c.status === "filled" || c.status === "pending";
  return (
    <div className="flex min-w-0 items-center gap-3 rounded-card-sm bg-card-2 p-2.5 @min-[720px]:-my-1">
      <RobotTile seed={c.agentId} variant="agent" mood={copyMood(c.status, c.side)} size="xs" />
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className={cn(LABEL, "text-mint-700")}>Copy</span>
          {c.paper ? <ModePill mode="paper" size="sm" title="Paper agent: simulated fill, no swap was sent" /> : null}
        </p>
        {c.href ? (
          // the link keeps a 40 px tall hit area inside the compact row
          <Link href={c.href} className={cn(NAME, "-mb-[10px] -mt-[9px] rounded-sm py-[11px] hover:text-mint-700")}>
            {c.agentName}
          </Link>
        ) : (
          <p className={cn(NAME, "mt-1")}>{c.agentName}</p>
        )}
        <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[12.5px]">
          {traded ? (
            <>
              <SideTag side={c.side} past={c.status === "filled"} />
              <span className="num text-[12px] text-muted">{c.solAmount > 0 ? fmtSol(c.solAmount) : "—"}</span>
            </>
          ) : (
            <span className="line-clamp-2 text-muted" title={c.reason ?? undefined}>
              {c.reason ?? "no reason recorded"}
            </span>
          )}
        </p>
      </div>
      <CopyStatusTag status={c.status} label={c.statusLabel} className="shrink-0" />
    </div>
  );
}

/** The footer line: what happened, in words ("mirrored · 81ms after the original"). */
function FooterLine({ copy, extra }: { copy: PairCopy | null; extra?: ReactNode }) {
  let icon: IconName = "minus";
  let text = "not copied";
  let tone = "text-icon";
  if (copy?.status === "filled") {
    icon = "check";
    // Paper fills only fetch a quote: their "latency" leaves out building, sending and confirming a swap.
    text = copy.paper
      ? `simulated · priced ${fmtMs(copy.latencyMs)} after the original (paper, no swap sent)`
      : copy.latencyMs !== null
        ? `mirrored · ${fmtMs(copy.latencyMs)} after the original`
        : "filled";
    tone = "text-up";
  } else if (copy?.status === "skipped") {
    icon = "x";
    text = `skipped · ${shortReason(copy.reason)}`;
    tone = "text-warn";
  } else if (copy?.status === "failed") {
    icon = "alert";
    text = `failed · ${shortReason(copy.reason)}`;
    tone = "text-down";
  } else if (copy?.status === "pending") {
    icon = "clock";
    text = "copying now";
    tone = "text-info";
  }
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1 pl-12 text-[12px] font-medium text-muted">
      <span className="inline-flex min-w-0 items-center gap-1.5">
        <Icon name={icon} size={13} strokeWidth={2.6} className={cn("shrink-0", tone)} />
        {text}
      </span>
      {extra}
    </div>
  );
}

/** "tx ↗" to Solscan, with a 40 px tall hit area. */
export function TxLink({ sig, label = "tx", srLabel = "Solscan", className }: { sig: string; label?: string; srLabel?: string; className?: string }) {
  return (
    <a
      href={solscanTx(sig)}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        "relative inline-flex h-8 shrink-0 items-center gap-0.5 rounded-full px-2 text-[12px] font-semibold text-muted",
        "after:absolute after:inset-x-0 after:-inset-y-1 hover:bg-card-2 hover:text-mint-700",
        "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus",
        className,
      )}
    >
      {label}
      <Icon name="external" size={11} strokeWidth={2.2} />
      <span className="sr-only"> ({srLabel}, opens in a new tab)</span>
    </a>
  );
}

export function TradePairRow({
  original,
  manualToken,
  copy,
  now,
  missing,
  footerExtra,
}: {
  /** The original trade, or null for a manual sell (then pass manualToken). */
  original: PairOriginal | null;
  manualToken?: string;
  copy: PairCopy | null;
  now: number;
  /** No agent acted on the original: a link to copy that trader (feed rows). */
  missing?: { href: string; label: string } | null;
  /** More facts on the footer line (a fee, the copy's own tx, its time). */
  footerExtra?: ReactNode;
}) {
  return (
    <li className="border-b border-border px-3.5 py-3.5 animate-rise last:border-0 app:px-5">
      <div className="grid gap-2 @min-[720px]:grid-cols-[minmax(0,1fr)_40px_minmax(0,1fr)] @min-[720px]:items-center @min-[720px]:gap-0">
        {original ? <OriginalSide o={original} now={now} /> : <ManualSide token={manualToken ?? "—"} />}

        <div aria-hidden className="flex items-center pl-[7px] text-mint-600 @min-[720px]:justify-center @min-[720px]:pl-0">
          <span className="grid size-[22px] place-items-center rounded-full border border-mint-200 bg-mint-50 @min-[720px]:size-7">
            <Icon name="arrow" size={13} strokeWidth={2.4} className="rotate-90 @min-[720px]:rotate-0" />
          </span>
        </div>

        {copy ? (
          <CopySide c={copy} />
        ) : (
          <div className="flex min-w-0 flex-col justify-center gap-1 rounded-card-sm border border-dashed border-border-strong p-2.5 @min-[720px]:-my-1">
            <p className="text-[12.5px] font-medium text-muted">No agent copied this one.</p>
            {missing ? (
              <Link
                href={missing.href}
                className="relative inline-flex w-fit items-center gap-1 rounded-sm text-[12.5px] font-bold text-mint-700 after:absolute after:inset-x-0 after:-inset-y-3 hover:underline"
              >
                Copy {missing.label}
                <Icon name="arrow" size={12} strokeWidth={2.4} />
              </Link>
            ) : null}
          </div>
        )}
      </div>
      <FooterLine copy={copy} extra={footerExtra} />
    </li>
  );
}

/** The card the rows sit in. */
export function TradePairList({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <ol aria-label={label} className={cn("@container overflow-hidden rounded-card border border-hairline bg-card shadow-card", className)}>
      {children}
    </ol>
  );
}

/** Loading placeholder with the same footprint. */
export function TradePairSkeleton({ rows = 4, className }: { rows?: number; className?: string }) {
  return (
    <ol aria-busy="true" aria-label="Loading trades" className={cn("@container overflow-hidden rounded-card border border-hairline bg-card shadow-card", className)}>
      {Array.from({ length: rows }, (_, i) => (
        <li key={i} aria-hidden className="grid gap-3 border-b border-border px-5 py-4 last:border-0 @min-[720px]:grid-cols-2 @min-[720px]:gap-10">
          {[0, 1].map((k) => (
            <div key={k} className="flex items-center gap-3">
              <span className="size-9 rounded-icon bg-card-3 animate-blink" style={{ animationDelay: `${i * 120}ms` }} />
              <span className="flex flex-col gap-2">
                <span className="h-2.5 w-16 rounded-full bg-card-3" />
                <span className="h-3 w-32 rounded-full bg-card-2" />
              </span>
            </div>
          ))}
        </li>
      ))}
    </ol>
  );
}
