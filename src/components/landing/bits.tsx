// Tiny presentational pieces shared across landing / floor / feed (light look).
// No hooks here, so these render in server and client components alike.

import type { ReactNode } from "react";
import { cn } from "@/components/ui/cn";
import { Icon } from "@/components/ui/icons";
import { Pill } from "@/components/ui/primitives";
import type { Tone } from "./model";

/** Text colour per tone, readable on white cards. */
export const TEXT_TONE: Record<Tone, string> = {
  up: "text-up",
  down: "text-down",
  warn: "text-warn",
  info: "text-info",
  muted: "text-muted",
};

/** Marks generated sample data on the floor / feed (FloorDTO.demo / FeedDTO.demo while there's no real activity). */
export function DemoTag({ className }: { className?: string }) {
  return (
    <Pill tone="paper" className={cn("tracking-[0.08em]", className)} title="Generated sample data, not real trades">
      DEMONSTRATION
      <span className="sr-only"> — sample data, not real trades</span>
    </Pill>
  );
}

/** LIVE with the pulsing red dot, or "reconnecting" while the poll is stale. */
export function LivePill({ stale }: { stale?: boolean }) {
  return stale ? (
    <Pill tone="warn">reconnecting</Pill>
  ) : (
    <span className="inline-flex h-[22px] shrink-0 items-center gap-1.5 rounded-full border border-live-border bg-live-bg px-2 text-[11.5px] font-bold tracking-[0.04em] text-live-ink">
      <span aria-hidden className="size-[7px] rounded-full bg-live-dot animate-pulse-live" />
      LIVE
    </span>
  );
}

/**
 * Speech bubble. Position it with `className` (it is absolutely positioned).
 * tone "light": white chip; "lime" (legacy name): the mint "gm" bubble of the hero banner.
 * Decorative: whatever it says must also be available in an accessible label nearby.
 */
export function Bubble({ children, className, tone = "light" }: { children: ReactNode; className?: string; tone?: "light" | "lime" }) {
  const mint = tone === "lime";
  return (
    <span
      aria-hidden
      className={cn(
        "pointer-events-none absolute z-10 whitespace-nowrap px-2 py-1 text-[10.5px] font-bold leading-none animate-rise",
        mint
          ? "rounded-[12px_12px_12px_4px] bg-[linear-gradient(150deg,var(--bubble-1),var(--bubble-2))] italic text-on-ink shadow-[0_6px_12px_-6px_rgb(8_80_74/0.6)]"
          : "rounded-[10px_10px_10px_3px] bg-card text-text shadow-[0_6px_14px_-8px_rgb(20_40_50/0.4),0_0_0_1px_rgb(24_44_56/0.06)]",
        className,
      )}
    >
      {children}
    </span>
  );
}

/** Up/down value with a trend icon so colour is never the only signal. */
export function Delta({ value, children, className }: { value: number | null | undefined; children: ReactNode; className?: string }) {
  const v = value ?? 0;
  const tone = v > 0 ? "text-up" : v < 0 ? "text-down" : "text-muted";
  return (
    <span className={cn("inline-flex items-center gap-1 font-bold tabular-nums", tone, className)}>
      {/* flat: no mark (a lone dot read as a stray bullet) */}
      {v > 0 ? <Icon name="trend" size={12} strokeWidth={2.4} /> : v < 0 ? <Icon name="trend-down" size={12} strokeWidth={2.4} /> : null}
      {children}
    </span>
  );
}
