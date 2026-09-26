"use client";

// One line under the leaderboard title: what the on-chain FOMO indexer is doing right now
// (GET /api/indexer), plus a warning pill when detection may have drifted or Helius is throttled.

import type { IndexerStatusDTO } from "@/lib/types";
import { timeAgo } from "@/lib/format";
import { Pill, cn } from "@/components/ui/primitives";
import { useNow } from "@/components/landing/hooks";
import { usePolled } from "../hooks";

export function IndexerStatus({ className }: { className?: string }) {
  const status = usePolled<IndexerStatusDTO>("/api/indexer", 30_000);
  const now = useNow(5_000);
  const s = status.data;
  if (!s) return null;

  if (!s.enabled) {
    return (
      <p className={cn("flex flex-wrap items-center gap-2 text-[12px] font-medium text-muted", className)}>
        <span className="size-1.5 rounded-full bg-icon" aria-hidden />
        On-chain indexer is off · rankings don&apos;t update
      </p>
    );
  }

  const running = s.mode !== "off";
  const live = running && s.connected;
  const lastTrade = s.lastFomoTradeAt ? timeAgo(s.lastFomoTradeAt, Math.max(now, status.fetchedAt ?? 0)) : null;

  return (
    <div className={cn("flex flex-wrap items-center gap-x-2 gap-y-1.5 text-[12px] font-medium text-muted", className)}>
      <span className="flex items-center gap-1.5">
        <span
          aria-hidden
          className={cn("size-1.5 shrink-0 rounded-full", live ? "bg-up animate-blink" : running ? "bg-paper-dot" : "bg-down")}
        />
        {running ? (
          <span>
            Indexing {s.tracked.toLocaleString("en-US")} wallet{s.tracked === 1 ? "" : "s"}
            {lastTrade ? ` · last FOMO trade ${lastTrade}` : " · no FOMO trade seen yet"}
            {!live ? " · reconnecting" : ""}
          </span>
        ) : (
          <span>Indexer offline · rankings may be out of date</span>
        )}
      </span>
      {s.throttled ? (
        <Pill
          tone="warn"
          title="Today's Helius credit budget is used up: discovery and history backfill are paused until 00:00 UTC. Live FOMO trades and copying continue."
        >
          throttled
        </Pill>
      ) : null}
      {s.driftWarning ? (
        <>
          <Pill tone="warn" icon="alert">
            check detection
          </Pill>
          <span className="basis-full text-warn sm:basis-auto">{s.driftWarning}</span>
        </>
      ) : null}
    </div>
  );
}
