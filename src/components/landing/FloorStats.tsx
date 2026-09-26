// Floor-wide numbers from GET /api/floor (agents · copies · median latency · SOL volume): one strip, the same on
// the landing page and on /floor. Four cells in a row from the tablet frame up, a 2 × 2 grid on phones; every cell
// keeps its icon. No hooks.

import type { FloorDTO } from "@/lib/types";
import { fmtMs } from "@/lib/format";
import { Icon, type IconName } from "@/components/ui/icons";
import { cn } from "@/components/ui/primitives";

function compact(n: number, digits = 0): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: digits });
}

/**
 * The counts cover the deployment's own mode only (stats.mode: a live floor leaves simulated paper agents out),
 * while the floor itself shows every running agent; the label says which agents were counted.
 * `paper`: the deployment runs in paper mode, so every copy here is simulated (a quote, no swap): the numbers are
 * labelled as such and "latency" is only quote time. `demo`: generated demonstration numbers.
 */
export function FloorStats({
  stats: s,
  paper = false,
  demo = false,
  className,
}: {
  stats: FloorDTO["stats"] | null;
  paper?: boolean;
  demo?: boolean;
  className?: string;
}) {
  const agentsLabel = demo || !s ? "agents on the floor" : s.mode === "live" ? "live agents" : "paper agents";
  const items: { icon: IconName; label: string; value: string; amount?: boolean }[] = [
    { icon: "bot", label: agentsLabel, value: s ? compact(s.agents) : "—" },
    { icon: "swap", label: paper ? "paper copies" : "copies", value: s ? compact(s.copies) : "—" },
    { icon: "clock", label: paper ? "median quote time (paper)" : "median latency", value: s ? fmtMs(s.medianLatencyMs) : "—" },
    {
      icon: "sol",
      label: paper ? "simulated SOL volume" : "SOL volume",
      value: s ? compact(s.volumeSol, s.volumeSol >= 100 ? 0 : 2) : "—",
      amount: true,
    },
  ];
  return (
    <dl
      className={cn(
        "grid grid-cols-2 gap-px overflow-hidden rounded-card border border-hairline bg-border shadow-card app:grid-cols-4",
        className,
      )}
    >
      {items.map((it) => (
        <div key={it.label} className="flex min-w-0 items-center gap-3 bg-card px-4 py-3.5 max-app:gap-2.5 max-app:px-3 max-app:py-3">
          <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-icon bg-mint-50 text-mint-700 max-app:size-8">
            <Icon name={it.icon} size={17} strokeWidth={2} />
          </span>
          <div className="flex min-w-0 flex-col-reverse">
            <dt className="text-[12px] font-medium leading-snug text-muted">{it.label}</dt>
            <dd
              className={cn(
                "text-[18px] font-extrabold leading-tight tracking-[-0.02em] tabular-nums text-text",
                it.amount && "num font-semibold",
              )}
            >
              {it.value}
            </dd>
          </div>
        </div>
      ))}
    </dl>
  );
}
