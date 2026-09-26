"use client";

// /floor: every agent as a robot card (spark bars + figures), polled every 5s, sortable by PnL / newest / copies.

import { useState } from "react";
import type { AgentSummaryDTO } from "@/lib/types";
import { PixelRobot } from "@/components/bots/PixelRobot";
import { Button, ButtonLink, EmptyState } from "@/components/ui/primitives";
import { SortMenu, type SortOption } from "@/components/ui/SortMenu";
import { useClientConfig } from "@/components/providers/AppConfig";
import { DemoTag, LivePill } from "@/components/landing/bits";
import { FloorStats } from "@/components/landing/FloorStats";
import { useNow } from "@/components/landing/hooks";
import { agentHref } from "@/components/landing/model";
import { isFloor, useApi } from "@/components/landing/useApi";
import { AgentCard } from "../agents/AgentCard";
import { ModePill } from "../Tags";

type SortKey = "pnl" | "newest" | "copies";

const SORTS: SortOption<SortKey>[] = [
  { value: "pnl", label: "PnL" },
  { value: "newest", label: "Newest" },
  { value: "copies", label: "Most copies" },
];

const COMPARE: Record<SortKey, (a: AgentSummaryDTO, b: AgentSummaryDTO) => number> = {
  pnl: (a, b) => b.pnlSol - a.pnlSol,
  newest: (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
  copies: (a, b) => b.copies - a.copies,
};

function sortAgents(agents: AgentSummaryDTO[], key: SortKey): AgentSummaryDTO[] {
  return [...agents].sort((a, b) => COMPARE[key](a, b) || a.name.localeCompare(b.name));
}

export const FLOOR_GRID = "grid grid-cols-[repeat(auto-fill,minmax(min(100%,250px),1fr))] gap-3 app:gap-4 side:gap-5";

export function FloorBoard() {
  const floor = useApi("/api/floor?limit=48", isFloor, 5_000);
  const now = useNow(10_000);
  const [sort, setSort] = useState<SortKey>("pnl");
  const demo = floor.data?.demo ?? false;
  const { mode } = useClientConfig();

  return (
    <section aria-label="All agents on the floor" className="flex flex-col">
      <FloorStats stats={floor.data?.stats ?? null} paper={mode === "paper" && !demo} demo={demo} className="mt-5" />

      <div className="mb-4 mt-5 flex flex-wrap items-center justify-between gap-x-4 gap-y-2.5 max-app:mb-3.5 max-app:mt-4">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <LivePill stale={Boolean(floor.error && floor.data)} />
          {mode === "paper" ? <ModePill mode="paper" title="Paper mode: every fill here is simulated" /> : null}
          {demo ? <DemoTag /> : null}
          <span className="text-[12px] font-medium text-muted">refreshes every 5s</span>
        </div>
        <SortMenu label="Sort" options={SORTS} value={sort} onChange={setSort} />
      </div>

      {floor.loading && !floor.data ? (
        <GridSkeleton />
      ) : !floor.data ? (
        <EmptyState
          tone="down"
          title="The floor went quiet"
          art={<PixelRobot name="tofu" size={96} />}
          action={
            <Button variant="outline" icon="refresh" onClick={floor.reload}>
              Try again
            </Button>
          }
        >
          {floor.error ?? "Couldn't load agents."}
        </EmptyState>
      ) : floor.data.agents.length === 0 ? (
        <EmptyState
          title="The floor is empty"
          art={<PixelRobot name="pip" size={96} />}
          action={
            <ButtonLink href="/create" variant="ink" iconEnd="arrow">
              Build the first agent
            </ButtonLink>
          }
        >
          No copy agents yet. Pick a trader, fund an agent, and it shows up here live.
        </EmptyState>
      ) : (
        <ul className={FLOOR_GRID}>
          {sortAgents(floor.data.agents, sort).map((a) => (
            <AgentCard key={a.id} agent={a} href={agentHref(a.slug, demo)} demo={demo} now={now} detail />
          ))}
        </ul>
      )}
    </section>
  );
}

function GridSkeleton() {
  return (
    <div aria-busy="true">
      <p className="sr-only">Loading agents…</p>
      <div aria-hidden className={FLOOR_GRID}>
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="flex h-[248px] flex-col gap-3 rounded-card-sm border border-hairline bg-card p-3.5 shadow-card">
            <div className="flex items-center gap-3">
              <span className="size-10 rounded-icon bg-card-3 animate-blink" />
              <span className="flex flex-col gap-2">
                <span className="h-3 w-28 rounded-full bg-card-3" />
                <span className="h-2.5 w-20 rounded-full bg-card-3" />
              </span>
            </div>
            <span className="h-5 w-36 rounded-full bg-card-2" />
            <span className="h-[54px] rounded-[10px] bg-card-2" />
            <span className="mt-auto h-3 w-full rounded-full bg-card-2" />
            <span className="h-3 w-2/3 rounded-full bg-card-2" />
          </div>
        ))}
      </div>
    </div>
  );
}
