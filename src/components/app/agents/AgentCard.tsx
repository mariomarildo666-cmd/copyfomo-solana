// One agent as a grid card (the mockup's trader-card anatomy, `.hover-card` lift + page curl): robot tile, name
// (the link; a stretched ::after makes the whole card clickable without turning every number into link text),
// who it copies, status / mode chips, then figures. `detail` (the floor) adds the spark bars and three more
// figures. No hooks.

import Link from "next/link";
import type { ReactNode } from "react";
import type { AgentSummaryDTO } from "@/lib/types";
import { fmtMs, fmtPct, fmtSignedSol, fmtSol, timeAgo, traderLabel } from "@/lib/format";
import { RobotTile } from "@/components/bots/RobotTile";
import { robotMood, type RobotMood } from "@/components/bots/params";
import { cn } from "@/components/ui/primitives";
import { ModePill, StatusPill } from "../Tags";
import { SparkBars } from "./SparkBars";

export function tradersLine(a: Pick<AgentSummaryDTO, "traders">): string {
  if (a.traders.length === 0) return "no traders yet";
  const names = a.traders.slice(0, 2).map(traderLabel).join(", ");
  return a.traders.length > 2 ? `${names} +${a.traders.length - 2}` : names;
}

/** Asleep when paused / stopped, else the side of its latest fill (spark is oldest first), else idle. */
export function summaryMood(a: Pick<AgentSummaryDTO, "status" | "spark">): RobotMood {
  return robotMood({ status: a.status, lastSide: a.spark.at(-1)?.side ?? null });
}

function toneClass(n: number): string {
  return n > 0 ? "text-up" : n < 0 ? "text-down" : "text-text";
}

function Figure({ label, children, className }: { label: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cn("min-w-0", className)}>
      <dt className="truncate text-[11px] font-semibold text-muted">{label}</dt>
      <dd className="mt-0.5 flex min-w-0 items-center gap-1 text-[13px] font-bold tabular-nums">{children}</dd>
    </div>
  );
}

/** A signed figure: the sign (+ / −) and the colour both carry the direction. `amount`: SOL, in mono. */
function Signed({ value, text, amount }: { value: number; text: string; amount?: boolean }) {
  return (
    <span className={cn("truncate", amount && "num font-semibold", toneClass(value))} title={text}>
      {text}
    </span>
  );
}

export function AgentCard({
  agent: a,
  href,
  detail = false,
  demo = false,
  now,
  headingAs: H = "h2",
}: {
  agent: AgentSummaryDTO;
  href: string;
  /** Floor card: spark bars + copies, latency and last trade. */
  detail?: boolean;
  /** Generated demonstration agent (the floor while there's no real activity). */
  demo?: boolean;
  /** Clock for "last trade" (detail only). */
  now?: number;
  headingAs?: "h2" | "h3";
}) {
  return (
    <li className="hover-card flex flex-col gap-3 px-[13px] pb-3 pt-3.5">
      <div className="grid grid-cols-[40px_minmax(0,1fr)] items-center gap-3">
        <RobotTile seed={a.id} variant="agent" mood={summaryMood(a)} size="sm" />
        <div className="min-w-0">
          <H className="truncate text-[14px] font-bold leading-[1.3] tracking-[-0.01em] text-text">
            <Link
              href={href}
              className="rounded-sm after:absolute after:inset-0 after:z-[1] after:rounded-card-sm focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:outline-offset-2 focus-visible:after:outline-focus"
            >
              {a.name}
              {demo ? <span className="sr-only"> (demonstration agent)</span> : null}
            </Link>
          </H>
          <p className="mt-0.5 truncate text-[12px] font-medium text-muted">copies {tradersLine(a)}</p>
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5">
        <StatusPill status={a.status} />
        <ModePill mode={a.mode} />
      </div>

      {detail ? (
        <div className="rounded-[10px] border border-border bg-card-2 px-2 py-1.5">
          <SparkBars spark={a.spark} className="h-10" />
        </div>
      ) : null}

      <dl className="mt-auto grid grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_minmax(0,0.9fr)] gap-x-2 gap-y-2.5 border-t border-border pt-2.5">
        <Figure label="Equity">
          <span className="truncate text-text">
            <span className="num font-semibold">{fmtSol(a.equitySol)}</span>
            {a.valuationStale ? <span className="font-medium text-muted"> est.</span> : null}
          </span>
        </Figure>
        <Figure label="PnL">
          <Signed value={a.pnlSol} text={fmtSignedSol(a.pnlSol)} amount />
        </Figure>
        <Figure label="ROI">
          <Signed value={a.roiPct} text={fmtPct(a.roiPct)} />
        </Figure>
        {detail ? (
          <>
            <Figure label="Copies">
              <span className="truncate text-text">{a.copies.toLocaleString("en-US")}</span>
            </Figure>
            <Figure
              label={
                <>
                  <span className="sr-only">Median </span>Latency
                </>
              }
            >
              <span className="truncate text-text">{fmtMs(a.medianLatencyMs)}</span>
            </Figure>
            <Figure label="Last trade">
              <span className="truncate text-text">{a.lastTradeAt ? timeAgo(a.lastTradeAt, now) : "—"}</span>
            </Figure>
          </>
        ) : null}
      </dl>
    </li>
  );
}
