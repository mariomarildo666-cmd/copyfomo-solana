"use client";

// "The floor" strip on the landing page: live stats, a scrollable row of agent robots under their mini monitors
// (with chatter bubbles), and a ticker of recent copies.

import Link from "next/link";
import { PixelRobot } from "@/components/bots/PixelRobot";
import { Button, ButtonLink, Card, EmptyState, cn } from "@/components/ui/primitives";
import { SparkBars } from "@/components/app/agents/SparkBars";
import { ModePill } from "@/components/app/Tags";
import { useClientConfig } from "@/components/providers/AppConfig";
import type { AgentSummaryDTO, FeedItemDTO } from "@/lib/types";
import { fmtSignedSol } from "@/lib/format";
import { Bubble, Delta, DemoTag, LivePill } from "./bits";
import { chatterFor, latestCopyByAgent, type Chatter } from "./chatter";
import { FloorStats } from "./FloorStats";
import { usePageVisible, useReducedMotion, useStepper } from "./hooks";
import { AGENT_STATUS, agentHref, agentMood } from "./model";
import { SectionHead } from "./SectionHead";
import { Ticker } from "./Ticker";
import { isFeed, isFloor, useApi } from "./useApi";

const POLL_MS = 5_000;
const CHATTER_MS = 2_600;

export function FloorStrip() {
  const floor = useApi("/api/floor?limit=24", isFloor, POLL_MS);
  const feed = useApi("/api/feed?limit=20", isFeed, POLL_MS);
  const floorDemo = floor.data?.demo ?? false;
  const feedDemo = feed.data?.demo ?? false;
  const { mode } = useClientConfig();

  return (
    <section aria-labelledby="floor-title" className="flex flex-col gap-4">
      <SectionHead
        id="floor-title"
        kicker="Copy agents, live"
        title="The floor"
        pills={
          <>
            <LivePill stale={Boolean(floor.error && floor.data)} />
            {floorDemo ? <DemoTag /> : null}
          </>
        }
        actions={
          <ButtonLink href="/floor" variant="ghost" size="sm" iconEnd="arrow">
            Whole floor
          </ButtonLink>
        }
      />

      {/* the same stats strip as /floor */}
      <FloorStats stats={floor.data?.stats ?? null} paper={mode === "paper" && !floorDemo} demo={floorDemo} />

      <Card className="overflow-hidden">
        <FloorRow
          agents={floor.data?.agents ?? null}
          feed={feed.data?.items ?? []}
          demo={floorDemo}
          loading={floor.loading}
          error={floor.data ? null : floor.error}
          onRetry={floor.reload}
        />

        <p className="px-5 pb-3 text-[12px] font-medium text-muted max-app:px-4">
          Every robot is an agent with its own wallet. Bars are its last 12 copies: up is a buy, down is a sell.
        </p>

        {/* Only tag the ticker separately when it is demo but the floor above isn't. */}
        <Ticker items={feed.data?.items ?? []} demo={feedDemo && !floorDemo} />
      </Card>
    </section>
  );
}

function FloorRow({
  agents,
  feed,
  demo,
  loading,
  error,
  onRetry,
}: {
  agents: AgentSummaryDTO[] | null;
  feed: FeedItemDTO[];
  demo: boolean;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  const reduced = useReducedMotion();
  const visible = usePageVisible();
  const tick = useStepper(CHATTER_MS, visible && !reduced);

  if (loading && !agents) return <FloorSkeleton />;
  if (error && !agents) {
    return (
      <div className="p-4">
        <EmptyState
          tone="down"
          title="The floor went quiet"
          art={<PixelRobot name="tofu" size={64} />}
          action={
            <Button variant="outline" size="sm" icon="refresh" onClick={onRetry}>
              Try again
            </Button>
          }
        >
          {error}
        </EmptyState>
      </div>
    );
  }
  if (!agents || agents.length === 0) {
    return (
      <div className="p-4">
        <EmptyState
          title="The floor is empty"
          art={<PixelRobot name="pip" size={64} />}
          action={
            <ButtonLink href="/create" size="sm" iconEnd="arrow">
              Build the first agent
            </ButtonLink>
          }
        >
          No copy agents yet. Yours could be the first robot on the floor.
        </EmptyState>
      </div>
    );
  }

  const latest = latestCopyByAgent(feed);
  const n = agents.length;
  // Two speakers at a time, rotating; spaced apart so bubbles don't collide.
  const speakers = new Set(n > 5 ? [(tick * 5) % n, (tick * 5 + Math.floor(n / 2)) % n] : [tick % n]);

  return (
    <ul aria-label="Agents on the floor" className="flex snap-x gap-1.5 overflow-x-auto px-3 pb-3 pt-11 [scrollbar-width:thin]">
      {agents.map((a, i) => (
        <FloorBot
          key={a.id}
          agent={a}
          index={i}
          demo={demo}
          chatter={speakers.has(i) ? chatterFor(a, latest.get(a.id)) : null}
        />
      ))}
    </ul>
  );
}

function FloorBot({ agent: a, index, demo, chatter }: { agent: AgentSummaryDTO; index: number; demo: boolean; chatter: Chatter | null }) {
  const status = AGENT_STATUS[a.status];
  const paper = a.mode === "paper";
  const label = `${a.name}${demo ? " (demonstration)" : paper ? " (paper agent, simulated)" : ""}: ${status.label.toLowerCase()}, PnL ${fmtSignedSol(a.pnlSol)}, ${a.copies} ${a.copies === 1 ? "copy" : "copies"}`;
  return (
    <li className="relative w-[112px] shrink-0 snap-start">
      {chatter ? (
        <Bubble key={chatter.text} className="bottom-[calc(100%-2px)] left-2.5">
          {paper && !demo ? `${chatter.text} · paper` : chatter.text}
        </Bubble>
      ) : null}
      <Link
        href={agentHref(a.slug, demo)}
        aria-label={label}
        className="flex flex-col items-center gap-1.5 rounded-card-sm p-2 transition-colors duration-150 hover:bg-card-2 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus"
      >
        <Monitor spark={a.spark} className="w-full" />
        <PixelRobot
          seed={a.id}
          variant="agent"
          mood={agentMood(a)}
          size={64}
          className={cn(a.status === "active" && "animate-bob")}
          style={{ animationDelay: `${(index % 5) * -0.28}s` }}
        />
        <span className="w-full truncate text-center text-[12px] font-bold tracking-[-0.01em] text-text">{a.name}</span>
        <span className="flex flex-wrap items-center justify-center gap-1">
          {paper && !demo ? <ModePill mode="paper" size="sm" /> : null}
          <Delta value={a.pnlSol} className="num whitespace-nowrap text-[11.5px] font-semibold">
            {fmtSignedSol(a.pnlSol)}
          </Delta>
        </span>
      </Link>
    </li>
  );
}

/** A small screen on a stand, holding the agent's spark bars ("no copies yet" on a fresh agent). */
function Monitor({ spark, className }: { spark: AgentSummaryDTO["spark"]; className?: string }) {
  return (
    <div className={cn("flex flex-col items-center", className)}>
      <div className="w-full rounded-[10px] border border-border bg-card-2 px-1.5 py-1 shadow-[inset_0_1px_2px_rgb(20_38_48/0.06)]">
        <SparkBars spark={spark} className="h-10" />
      </div>
      <span aria-hidden className="h-1.5 w-2 bg-border-strong" />
      <span aria-hidden className="h-1 w-7 rounded-full bg-border-strong" />
    </div>
  );
}

function FloorSkeleton() {
  return (
    <div className="px-3 pb-3 pt-11" aria-busy="true">
      <p className="sr-only">Loading the floor…</p>
      <div aria-hidden className="flex gap-1.5 overflow-hidden">
        {Array.from({ length: 9 }, (_, i) => (
          <div key={i} className="flex w-[112px] shrink-0 flex-col items-center gap-1.5 p-2 opacity-45 grayscale">
            <div className="h-[50px] w-full rounded-[10px] border border-border bg-card-2" />
            <PixelRobot seed={`boot-${i}`} variant="agent" mood="sleep" size={64} />
            <span className="h-2.5 w-16 rounded-full bg-card-3" />
            <span className="h-2 w-10 rounded-full bg-card-2" />
          </div>
        ))}
      </div>
      <p className="mt-1 px-2 text-[12px] font-medium text-muted">
        Booting the floor<span className="animate-blink">…</span>
      </p>
    </div>
  );
}
