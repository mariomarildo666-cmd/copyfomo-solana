"use client";

// Infinite marquee of recent copy fills. The list is rendered twice and slid by -50%
// so the loop is seamless; short lists are repeated until they fill the strip.
// Pauses on hover/focus and via an explicit button (moving content needs a pause control).

import { useState } from "react";
import type { FeedItemDTO } from "@/lib/types";
import { PixelRobot } from "@/components/bots/PixelRobot";
import { useClientConfig } from "@/components/providers/AppConfig";
import { Icon } from "@/components/ui/icons";
import { cn } from "@/components/ui/primitives";
import { DemoTag, TEXT_TONE } from "./bits";
import { tickerParts } from "./model";

const MIN_ITEMS = 8;
const SECONDS_PER_ITEM = 4.5;

export function Ticker({ items, demo, className }: { items: FeedItemDTO[]; demo?: boolean; className?: string }) {
  const [paused, setPaused] = useState(false);
  const { mode } = useClientConfig();

  const parts = items.flatMap((item) => {
    const p = tickerParts(item, mode);
    return p ? [{ id: item.id, ...p }] : [];
  });

  const shell = "flex items-center gap-3 border-t border-border bg-card-2";

  if (parts.length === 0) {
    return (
      <div className={cn(shell, "px-5 py-3 text-[12.5px] font-medium text-muted", className)}>
        <span className="size-1.5 rounded-full bg-mint-500 animate-blink" aria-hidden />
        Waiting for the first copy…
      </div>
    );
  }

  const repeat = Math.ceil(MIN_ITEMS / parts.length);
  const loop = Array.from({ length: repeat }, () => parts).flat();
  const duration = `${Math.max(20, loop.length * SECONDS_PER_ITEM)}s`;

  const row = (copy: 0 | 1) => (
    <ul aria-hidden={copy === 1 ? true : undefined} className="flex shrink-0 items-center">
      {loop.map((p, i) => (
        <li
          key={`${copy}-${i}-${p.id}`}
          // repeats exist only to fill the strip; screen readers get each copy once
          aria-hidden={copy === 0 && i >= parts.length ? true : undefined}
          className="flex items-center gap-1.5 whitespace-nowrap pr-9 text-[12.5px]"
        >
          {/* each entry starts with the agent's own robot (no bullet separators) */}
          <PixelRobot seed={p.agentId} variant="agent" size={32} className="-my-1.5 mr-0.5" />
          <span className="font-bold text-text">{p.agent}</span>
          <span className={cn("font-semibold", TEXT_TONE[p.tone])}>{p.verb}</span>
          <span className="font-semibold text-text-2">{p.token}</span>
          {p.amount ? <span className="num text-[12px] text-muted">{p.amount}</span> : null}
          {p.note ? <span className="text-muted">· {p.note}</span> : null}
        </li>
      ))}
    </ul>
  );

  return (
    <div className={cn(shell, "pl-1 pr-2", className)}>
      <div className="group relative min-w-0 flex-1 overflow-hidden py-3" aria-label="Recent copies" role="region">
        <div
          className={cn(
            "flex w-max animate-ticker group-hover:[animation-play-state:paused] group-focus-within:[animation-play-state:paused]",
            paused && "[animation-play-state:paused]",
          )}
          style={{ animationDuration: duration }}
        >
          {row(0)}
          {row(1)}
        </div>
        <span aria-hidden className="pointer-events-none absolute inset-y-0 left-0 w-8 bg-linear-to-r from-card-2 to-transparent" />
        <span aria-hidden className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-linear-to-l from-card-2 to-transparent" />
      </div>
      {demo ? (
        <span className="hidden sm:block">
          <DemoTag />
        </span>
      ) : null}
      <button
        type="button"
        onClick={() => setPaused((p) => !p)}
        aria-pressed={paused}
        aria-label="Pause ticker"
        title={paused ? "Resume ticker" : "Pause ticker"}
        className="grid size-10 shrink-0 place-items-center rounded-full text-muted transition-colors duration-150 hover:bg-card hover:text-text focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus app:size-8"
      >
        <Icon name={paused ? "play" : "pause"} size={14} strokeWidth={2} />
      </button>
    </div>
  );
}
