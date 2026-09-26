"use client";

// "Your agents": every agent owned by the signed-in wallet (GET /api/me/agents, session cookie).

import Link from "next/link";
import { useEffect, useRef } from "react";
import type { MyAgentsDTO } from "@/lib/types";
import { shortAddr } from "@/lib/format";
import { PixelRobot } from "@/components/bots/PixelRobot";
import { RobotTile } from "@/components/bots/RobotTile";
import { HeroBanner } from "@/components/ui/HeroBanner";
import { Icon } from "@/components/ui/icons";
import { Button, ButtonLink, EmptyState } from "@/components/ui/primitives";
import { useSession } from "@/components/wallet/session";
import { SignInPanel } from "@/components/wallet/WalletButton";
import { errorMessage } from "../api";
import { usePolled } from "../hooks";
import { AgentCard } from "../agents/AgentCard";

const GRID = "grid grid-cols-[repeat(auto-fill,minmax(min(100%,250px),1fr))] gap-3 app:gap-4 side:gap-5";

export function MyAgents() {
  const session = useSession();
  const mine = usePolled<MyAgentsDTO>(session.wallet ? "/api/me/agents" : null, 15_000);
  const { refresh } = mine;
  const { epoch } = session;

  // A 401 means the session ended elsewhere: re-read it so the sign-in panel comes back.
  const unauthorized = mine.error?.status === 401;
  const refreshSession = session.refresh;
  useEffect(() => {
    if (unauthorized) void refreshSession();
  }, [unauthorized, refreshSession]);

  const seenEpoch = useRef(epoch);
  useEffect(() => {
    if (seenEpoch.current === epoch) return;
    seenEpoch.current = epoch;
    refresh();
  }, [epoch, refresh]);

  const agents = mine.data?.agents ?? null;

  return (
    <div className="page">
      <HeroBanner
        id="agents-title"
        title={["Your ", "copy agents"]}
        robots={["the-copy", "pip", "tofu"]}
        stackActions
        actions={
          <>
            <ButtonLink href="/floor" variant="white" iconEnd="arrow">
              See the floor
            </ButtonLink>
            <ButtonLink href="/create" variant="ink" iconEnd="arrow">
              Build an agent
            </ButtonLink>
          </>
        }
      >
        Every agent owned by the wallet you signed in with, on any device. Withdrawals from them only ever go back to that
        wallet.
      </HeroBanner>

      {/* whose agents these are: only once a wallet is signed in */}
      {session.wallet ? (
        <div className="mb-4 mt-5 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 max-app:mb-3.5 max-app:mt-4">
          <p className="flex min-w-0 items-center gap-2 text-[13px] font-medium text-muted">
            <RobotTile seed={session.wallet} variant="agent" size="2xs" shape="circle" />
            <span>
              wallet <span className="addr text-text">{shortAddr(session.wallet)}</span>
            </span>
          </p>
          {agents ? (
            <p className="text-[13px] font-semibold text-text-2">
              {agents.length} agent{agents.length === 1 ? "" : "s"}
            </p>
          ) : null}
        </div>
      ) : null}

      {!session.wallet ? (
        <SignInPanel title="Sign in to see your agents" centered className="mt-5 max-app:mt-4">
          Your agents belong to your wallet. Sign in with it to see, fund and control them.
        </SignInPanel>
      ) : mine.loading ? (
        <ul className={GRID} aria-busy="true" aria-label="Loading your agents">
          {[0, 1, 2].map((i) => (
            <li key={i} aria-hidden className="flex h-[168px] flex-col gap-3 rounded-card-sm border border-hairline bg-card p-3.5 shadow-card">
              <div className="flex items-center gap-3">
                <span className="size-10 rounded-icon bg-card-3 animate-blink" />
                <span className="flex flex-col gap-2">
                  <span className="h-3 w-28 rounded-full bg-card-3" />
                  <span className="h-2.5 w-20 rounded-full bg-card-3" />
                </span>
              </div>
              <span className="h-5 w-40 rounded-full bg-card-2" />
              <span className="mt-auto h-3 w-full rounded-full bg-card-2" />
            </li>
          ))}
        </ul>
      ) : !mine.data ? (
        <EmptyState
          tone="down"
          title="Couldn't load your agents"
          art={<PixelRobot seed="mine-error" mood="rekt" size={96} />}
          action={
            <Button variant="outline" icon="refresh" onClick={refresh}>
              Try again
            </Button>
          }
        >
          {mine.error ? errorMessage(mine.error) : "Unknown error."}
        </EmptyState>
      ) : mine.data.agents.length === 0 ? (
        <EmptyState
          title="No agents yet"
          art={<PixelRobot name="tofu" size={96} />}
          action={
            <ButtonLink href="/create" variant="ink" iconEnd="arrow">
              Build an agent
            </ButtonLink>
          }
        >
          This wallet doesn&apos;t own any agents. Build one: pick a trader, set the size, fund it in one click.
        </EmptyState>
      ) : (
        <ul className={GRID}>
          {mine.data.agents.map((a) => (
            <AgentCard key={a.id} agent={a} href={`/agents/${encodeURIComponent(a.slug)}`} />
          ))}
          <li>
            <Link
              href="/create"
              className="group flex h-full min-h-[168px] flex-col items-center justify-center gap-2 rounded-card-sm border border-dashed border-border-strong bg-card/60 px-4 py-6 text-center transition-colors duration-150 hover:border-mint-300 hover:bg-mint-50"
            >
              <span aria-hidden className="grid size-10 place-items-center rounded-full bg-ink text-on-ink shadow-ink transition-transform duration-150 group-hover:scale-105">
                <Icon name="plus" size={18} strokeWidth={2.4} />
              </span>
              <span className="text-[14px] font-bold text-text">Build another agent</span>
              <span className="text-[12.5px] text-muted">Pick a trader, set the size, fund it in one click.</span>
            </Link>
          </li>
        </ul>
      )}
    </div>
  );
}
