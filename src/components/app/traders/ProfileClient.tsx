"use client";

// The interactive bits of the (server-rendered) trader profile page.

import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { TraderDTO } from "@/lib/types";
import { Button, cn } from "@/components/ui/primitives";
import { useAppConfig } from "../hooks";
import { setPicks, usePicks } from "../picks";

/**
 * Re-render the server page every `everyMs` while the tab is visible. Stats are recomputed every 5 minutes, so
 * refreshing more often only costs the shared per-IP profile budget (finding F30).
 */
export function AutoRefresh({ everyMs = 5 * 60_000 }: { everyMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    const t = setInterval(() => {
      if (!document.hidden) router.refresh();
    }, everyMs);
    return () => clearInterval(t);
  }, [router, everyMs]);
  return null;
}

/** Add / remove this trader from the picks shared with /traders and /create. */
export function PickButton({ trader, className }: { trader: TraderDTO; className?: string }) {
  const picks = usePicks();
  const { config } = useAppConfig();
  const max = config.maxTradersPerAgent;
  const [full, setFull] = useState(false);
  const picked = picks.some((p) => p.wallet === trader.wallet);

  function toggle() {
    if (picked) {
      setPicks(picks.filter((p) => p.wallet !== trader.wallet));
      setFull(false);
    } else if (picks.length >= max) {
      setFull(true);
    } else {
      setPicks([...picks, trader]);
      setFull(false);
    }
  }

  return (
    <span className={cn("flex flex-col gap-1", className)}>
      <Button
        onClick={toggle}
        aria-pressed={picked}
        variant={picked ? "soft" : "outline"}
        size="lg"
        icon={picked ? "check" : "plus"}
        className="w-full"
      >
        {picked ? "In your picks" : "Add to picks"}
      </Button>
      <span className="min-h-4 px-1 text-[11.5px] font-medium leading-snug text-muted" aria-live="polite">
        {full ? `Max ${max} traders per agent — remove one first.` : picked ? `${picks.length} picked · build from any page` : ""}
      </span>
    </span>
  );
}

/**
 * Window tabs (24h / 7d / 30d) over server-rendered panels: the ARIA tabs pattern (arrow keys, Home / End), in the
 * look of the leaderboard's window switch. Every panel is in the HTML; the inactive ones are `hidden`.
 */
export function WindowTabs({
  label,
  tabs,
  defaultId,
  className,
}: {
  label: string;
  tabs: { id: string; label: string; panel: ReactNode }[];
  defaultId: string;
  className?: string;
}) {
  const [active, setActive] = useState(defaultId);
  const base = useId();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  function onKey(e: KeyboardEvent<HTMLButtonElement>, i: number) {
    const last = tabs.length - 1;
    const next = e.key === "ArrowRight" ? (i === last ? 0 : i + 1) : e.key === "ArrowLeft" ? (i === 0 ? last : i - 1) : e.key === "Home" ? 0 : e.key === "End" ? last : null;
    if (next === null) return;
    e.preventDefault();
    setActive(tabs[next].id);
    refs.current[next]?.focus();
  }

  return (
    <div className={className}>
      <div
        role="tablist"
        aria-label={label}
        className="inline-flex shrink-0 items-center gap-0.5 rounded-full border border-border bg-card p-[3px] shadow-pill"
      >
        {tabs.map((t, i) => {
          const on = t.id === active;
          return (
            <button
              key={t.id}
              ref={(el) => {
                refs.current[i] = el;
              }}
              type="button"
              role="tab"
              id={`${base}-tab-${t.id}`}
              aria-selected={on}
              aria-controls={`${base}-panel-${t.id}`}
              tabIndex={on ? 0 : -1}
              onClick={() => setActive(t.id)}
              onKeyDown={(e) => onKey(e, i)}
              className={cn(
                "inline-flex h-10 items-center rounded-full px-4 text-[12.5px] font-bold transition-[background-color,color] duration-150 app:h-[30px] app:px-3.5",
                "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus",
                on ? "bg-ink text-on-ink" : "text-text-2 hover:bg-card hover:text-text",
              )}
            >
              {t.label}
            </button>
          );
        })}
      </div>
      {tabs.map((t) => (
        <div
          key={t.id}
          role="tabpanel"
          id={`${base}-panel-${t.id}`}
          aria-labelledby={`${base}-tab-${t.id}`}
          hidden={t.id !== active}
          className="mt-3"
        >
          {t.panel}
        </div>
      ))}
    </div>
  );
}

/**
 * A long list, ten rows at first. The server renders every row; rows past the first `initial` carry the class
 * `group-data-[more=some]/more:hidden` (see MORE_ROW in TraderProfile), and this wrapper flips data-more.
 */
export function MoreRows({ total, initial, noun, children }: { total: number; initial: number; noun: string; children: ReactNode }) {
  const [all, setAll] = useState(false);
  return (
    <div data-more={all ? "all" : "some"} className="group/more">
      {children}
      {total > initial ? (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-3 app:px-5">
          <p className="text-[12.5px] font-medium text-muted">
            {all ? `All ${total} ${noun}` : `Showing ${initial} of ${total} ${noun}`}
          </p>
          <Button variant="outline" size="sm" icon={all ? "chev-up" : "chev"} aria-expanded={all} onClick={() => setAll((v) => !v)}>
            {all ? "Show fewer" : `Show all ${total}`}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
