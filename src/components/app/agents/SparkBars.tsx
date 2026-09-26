// Mini bar chart of an agent's last fills (light look): buys grow UP from the midline (green), sells hang DOWN
// from it (red), so direction reads without colour. Height ∝ SOL size. No hooks.

import type { AgentSummaryDTO } from "@/lib/types";
import { cn } from "@/components/ui/cn";

type Spark = AgentSummaryDTO["spark"];

export function sparkSummary(spark: Spark): string {
  if (spark.length === 0) return "No copies yet";
  const buys = spark.filter((s) => s.side === "buy").length;
  return `Last ${spark.length} copies: ${buys} buys, ${spark.length - buys} sells`;
}

/** Give it a height via className (e.g. "h-10"). */
export function SparkBars({ spark, slots = 12, className }: { spark: Spark; slots?: number; className?: string }) {
  const items = spark.slice(-slots);
  const max = items.reduce((m, s) => Math.max(m, s.solAmount), 0);
  const pad = Math.max(0, slots - items.length);

  if (items.length === 0) {
    return (
      <div role="img" aria-label={sparkSummary(items)} className={cn("grid place-items-center", className)}>
        <span aria-hidden className="text-[11.5px] font-medium text-muted">
          no copies yet
        </span>
      </div>
    );
  }

  return (
    <div role="img" aria-label={sparkSummary(items)} className={cn("relative flex items-stretch gap-[3px]", className)}>
      <span aria-hidden className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-border-strong" />
      {Array.from({ length: pad }, (_, i) => (
        <span key={`pad-${i}`} aria-hidden className="flex-1" />
      ))}
      {items.map((s, i) => {
        // Floor at 14% so a dust-sized fill is still visible.
        const pct = max > 0 ? Math.max(14, Math.round((s.solAmount / max) * 100)) : 14;
        const buy = s.side === "buy";
        return (
          <span key={i} aria-hidden className="relative flex flex-1 flex-col">
            <span className="flex flex-1 items-end pb-px">
              {buy ? <span className="w-full rounded-t-[3px] bg-up" style={{ height: `${pct}%` }} /> : null}
            </span>
            <span className="flex flex-1 items-start pt-px">
              {buy ? null : <span className="w-full rounded-b-[3px] bg-down" style={{ height: `${pct}%` }} />}
            </span>
          </span>
        );
      })}
    </div>
  );
}
