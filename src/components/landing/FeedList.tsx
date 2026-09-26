"use client";

// The public feed: each row pairs an ORIGINAL trade with what a COPY agent did about it (copied, skipped or
// failed, with latency), newest first, polled every 5 s. One component for the short preview on the landing page
// and the full /feed view (withFilters: All / Copied / Skipped · Failed). Rows are the shared TradePairRow, the same
// row an agent's trade log uses.

import { useState, type ReactNode } from "react";
import type { FeedItemDTO, Mode } from "@/lib/types";
import { tokenLabel, traderLabel } from "@/lib/format";
import { PixelRobot } from "@/components/bots/PixelRobot";
import { ChipGroup, type ChoiceOption } from "@/components/ui/ChipGroup";
import { Button, ButtonLink, EmptyState, cn } from "@/components/ui/primitives";
import { TradePairList, TradePairRow, TradePairSkeleton } from "@/components/app/trades/TradePair";
import { useClientConfig } from "@/components/providers/AppConfig";
import { DemoTag, LivePill } from "./bits";
import { useNow } from "./hooks";
import { agentHref, copyMode, createHref } from "./model";
import { isFeed, useApi } from "./useApi";

export type FeedFilter = "all" | "copied" | "missed";

const MATCH: Record<FeedFilter, (i: FeedItemDTO) => boolean> = {
  all: () => true,
  copied: (i) => i.copy?.status === "filled",
  missed: (i) => i.copy?.status === "skipped" || i.copy?.status === "failed",
};

export function FeedList({
  limit,
  withFilters = false,
  pollMs = 5_000,
  lead,
  actions,
  className,
}: {
  limit: number;
  /** Show All / Copied / Skipped · Failed filter chips (full /feed page). */
  withFilters?: boolean;
  pollMs?: number;
  /** Left side of the header row when there are no filter chips (e.g. a section heading). */
  lead?: ReactNode;
  /** After the DEMONSTRATION / LIVE pills (e.g. a "Full feed" link). */
  actions?: ReactNode;
  className?: string;
}) {
  const feed = useApi(`/api/feed?limit=${limit}`, isFeed, pollMs);
  const now = useNow(10_000);
  const { mode } = useClientConfig();
  const [filter, setFilter] = useState<FeedFilter>("all");

  const items = feed.data?.items ?? [];
  const demo = feed.data?.demo ?? false;
  const shown = items.filter(MATCH[filter]).slice(0, limit);

  const options: ChoiceOption<FeedFilter>[] = [
    { value: "all", label: "All", count: items.length },
    { value: "copied", label: "Copied", count: items.filter(MATCH.copied).length },
    { value: "missed", label: "Skipped · Failed", count: items.filter(MATCH.missed).length },
  ];

  const pills = (
    <div className="flex shrink-0 flex-wrap items-center gap-2">
      {demo ? <DemoTag /> : null}
      <LivePill stale={Boolean(feed.error && feed.data)} />
      {actions}
    </div>
  );

  return (
    <div className={cn("flex min-w-0 flex-col gap-3", withFilters && "gap-4 max-app:gap-3.5", className)}>
      {withFilters ? (
        // chips scroll sideways on phones, so the LIVE pill always stays on the same row
        <div className="flex min-w-0 items-center justify-between gap-3">
          <ChipGroup label="Filter the feed" options={options} value={filter} onChange={setFilter} bleed={false} className="min-w-0 flex-1" />
          {pills}
        </div>
      ) : (
        <div className="flex flex-wrap items-end justify-between gap-x-3 gap-y-2">
          {lead ?? <span />}
          {pills}
        </div>
      )}

      {feed.loading && !feed.data ? (
        <TradePairSkeleton rows={Math.min(limit, 4)} />
      ) : !feed.data ? (
        <EmptyState
          tone="down"
          title="Feed unavailable"
          art={<PixelRobot name="echo" mood="shock" size={64} />}
          action={
            <Button variant="outline" size="sm" icon="refresh" onClick={feed.reload}>
              Try again
            </Button>
          }
        >
          {feed.error ?? "Couldn't load recent copies."}
        </EmptyState>
      ) : items.length === 0 ? (
        <EmptyState
          title="Nothing to mirror yet"
          art={<PixelRobot name="echo" size={64} />}
          action={
            <ButtonLink href="/create" size="sm" iconEnd="arrow">
              Build an agent
            </ButtonLink>
          }
        >
          The feed fills up the moment a followed trader makes a move.
        </EmptyState>
      ) : shown.length === 0 ? (
        <EmptyState title={filter === "missed" ? "Clean run" : "No copies yet"} art={<PixelRobot name="pip" mood="happy" size={64} />}>
          {filter === "missed" ? "No skipped or failed copies in the latest batch." : "Nothing matches this filter yet."}
        </EmptyState>
      ) : (
        <TradePairList label="Original trades and their copies">
          {shown.map((item) => (
            <FeedRow key={item.id} item={item} demo={demo} now={now} mode={mode} />
          ))}
        </TradePairList>
      )}
    </div>
  );
}

function FeedRow({ item, demo, now, mode }: { item: FeedItemDTO; demo: boolean; now: number; mode: Mode }) {
  const o = item.original;
  const c = item.copy;
  return (
    <TradePairRow
      now={now}
      original={{
        trader: o.trader,
        side: o.side,
        token: tokenLabel(o.symbol, o.mint),
        solAmount: o.solAmount,
        blockTime: o.blockTime,
        signature: demo ? null : o.signature || null,
        venue: demo ? null : o.venue,
      }}
      copy={
        c
          ? {
              agentId: c.agentId,
              agentName: c.agentName,
              href: demo ? null : agentHref(c.agentSlug, false),
              status: c.status,
              side: o.side,
              solAmount: c.solAmount,
              paper: !demo && copyMode(c, mode) === "paper",
              reason: c.reason,
              latencyMs: c.latencyMs,
            }
          : null
      }
      missing={!demo && o.trader.wallet ? { href: createHref(o.trader.wallet), label: traderLabel(o.trader) } : null}
    />
  );
}
