// "The copy desk": the crowned trader robots on top, a mint signal line, and the agent's robot underneath.
// Pixel robots only, at crisp sizes: the agent at the multiple of 32 nearest `size`, the originals at half of it.

import type { CSSProperties } from "react";
import { PixelRobot } from "@/components/bots/PixelRobot";
import { snapRobotSize, type RobotMood } from "@/components/bots/params";
import { cn } from "@/components/ui/cn";

export interface DeskOriginal {
  seed: string;
  label: string;
}

export function CopyDesk({
  originals,
  agentSeed,
  agentMood = "idle",
  size = 64,
  maxShown = 4,
  className,
  agentStyle,
  agentClassName,
}: {
  originals: DeskOriginal[];
  /** The agent's robot seed: its id once it exists (a stable placeholder before). */
  agentSeed: string;
  agentMood?: RobotMood;
  size?: number;
  maxShown?: number;
  className?: string;
  agentStyle?: CSSProperties;
  agentClassName?: string;
}) {
  const shown = originals.slice(0, maxShown);
  const extra = originals.length - shown.length;
  const agentPx = snapRobotSize(size);
  const originalPx = snapRobotSize(agentPx / 2);
  const summary = originals.length
    ? `Copy agent mirroring ${originals.map((o) => o.label).join(", ")}`
    : "Copy agent waiting for traders to mirror";

  return (
    <div role="img" aria-label={summary} className={cn("flex flex-col items-center", className)}>
      <div className="flex min-h-8 items-end justify-center gap-1">
        {shown.length ? (
          shown.map((o, i) => (
            <span key={o.seed} className="animate-bob" style={{ animationDelay: `${i * 170}ms` }}>
              <PixelRobot seed={o.seed} variant="trader" size={originalPx} />
            </span>
          ))
        ) : (
          <span className="grid size-10 place-items-center rounded-[10px] border-2 border-dashed border-border-strong text-[15px] font-bold text-icon">
            ?
          </span>
        )}
        {extra > 0 ? <span className="mb-1 text-[11.5px] font-bold text-muted">+{extra}</span> : null}
      </div>

      <div className="relative my-1.5 h-7 w-3" aria-hidden>
        <span className="absolute left-1/2 top-0 h-full -translate-x-1/2 border-l-2 border-dashed border-mint-300" />
        <span className="absolute left-1/2 top-1 size-1.5 -translate-x-1/2 rounded-full bg-mint-500 animate-blink" />
        <span className="absolute bottom-0 left-1/2 size-0 -translate-x-1/2 border-x-[5px] border-t-[5px] border-x-transparent border-t-mint-400" />
      </div>

      <PixelRobot seed={agentSeed} variant="agent" mood={agentMood} size={agentPx} className={agentClassName} style={agentStyle} />
      <span aria-hidden className="mt-0.5 h-1.5 rounded-full bg-[rgb(20_38_48/0.12)]" style={{ width: agentPx * 0.6 }} />
    </div>
  );
}
