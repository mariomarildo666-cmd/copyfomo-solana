"use client";

import { useCallback, useEffect, useRef } from "react";
import type { AgentDetailDTO, AgentDTO } from "@/lib/types";
import { shortAddr, solscanAccount } from "@/lib/format";
import { PixelRobot } from "@/components/bots/PixelRobot";
import { Icon } from "@/components/ui/icons";
import { Button, ButtonLink, Card, Heading, Kicker, Panel } from "@/components/ui/primitives";
import { useSession } from "@/components/wallet/session";
import { errorMessage } from "../api";
import { feeLine } from "../fees";
import { useAppConfig, usePolled } from "../hooks";
import { AgentHeader } from "./AgentHeader";
import { CardTitle } from "./bits";
import { DepositCard } from "./DepositCard";
import { OwnerPanel } from "./OwnerPanel";
import { PositionsTable } from "./PositionsTable";
import { TradeLog } from "./TradeLog";

/** The page column (the mockup's main padding via `.page`), a container for the two-column rows. */
const WRAP = "page @container gap-4 app:gap-5";
/** Balance card + owner desk side by side once the column is wide enough. */
const ROW = "grid grid-cols-1 gap-4 app:gap-5 @min-[980px]:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] @min-[980px]:items-start";

export function AgentDashboard({ idOrSlug }: { idOrSlug: string }) {
  const detail = usePolled<AgentDetailDTO>(`/api/agents/${encodeURIComponent(idOrSlug)}`, 5000);
  const { config } = useAppConfig();
  const { epoch } = useSession();
  const { mutate, refresh } = detail;
  const onAgent = useCallback((agent: AgentDTO) => mutate((d) => ({ ...d, agent })), [mutate]);

  // Owner controls depend on who is signed in (agent.isOwner is computed per request): refetch on sign-in/out.
  const seenEpoch = useRef(epoch);
  useEffect(() => {
    if (seenEpoch.current === epoch) return;
    seenEpoch.current = epoch;
    refresh();
  }, [epoch, refresh]);

  if (detail.loading) return <DashboardSkeleton />;

  if (!detail.data) {
    if (detail.error?.status === 404) return <AgentNotFound idOrSlug={idOrSlug} />;
    return (
      <div className={WRAP}>
        <Card className="flex flex-col items-center gap-3 px-5 py-12 text-center">
          <PixelRobot seed="dash-error" mood="rekt" size={96} />
          <Heading as="h1" size="lg">
            Couldn&apos;t load this agent
          </Heading>
          <p className="max-w-sm text-[13px] leading-relaxed text-muted">{detail.error ? errorMessage(detail.error) : "Unknown error."}</p>
          <Button variant="ink" icon="refresh" onClick={detail.refresh} className="mt-1">
            Try again
          </Button>
        </Card>
      </div>
    );
  }

  const { agent, positions, trades } = detail.data;
  const now = detail.fetchedAt ?? 0;

  return (
    <div className={WRAP}>
      {detail.error ? (
        <p
          role="status"
          className="flex items-center gap-2 rounded-card-sm border border-paper-border bg-paper-bg px-3.5 py-2.5 text-[12.5px] font-medium text-paper-ink"
        >
          <Icon name="refresh" size={14} strokeWidth={2.2} className="shrink-0" />
          Connection hiccup ({errorMessage(detail.error)}). Showing the last data, retrying every 5s.
        </p>
      ) : null}

      <AgentHeader agent={agent} trades={trades} now={now} platformFeeBps={config.platformFeeBps} />

      <div className={ROW}>
        <DepositCard agent={agent} minDepositSol={config.minDepositSol} onAgent={onAgent} now={now} />
        <OwnerPanel agent={agent} onAgent={onAgent} positionsCount={positions.length} workerOnline={config.workerOnline} />
      </div>

      <PositionsTable positions={positions} />
      {agent.isOwner && agent.untrackedTokens?.length ? <UntrackedTokens tokens={agent.untrackedTokens} /> : null}
      <TradeLog trades={trades} agent={agent} now={now} />

      <p className="flex items-start gap-2 px-1 text-[12.5px] leading-relaxed text-muted">
        <Icon name="info" size={14} strokeWidth={2} className="mt-[3px] shrink-0 text-icon" />
        <span>
          Copy-trading memecoins is risky: copies land after the original, often at a worse price, and tokens can go to
          zero. PnL is shown after the platform fee ({feeLine(config.platformFeeBps).toLowerCase()}). Last update{" "}
          {now ? new Date(now).toLocaleTimeString() : "—"} · refreshes every 5s while this tab is open.
        </span>
      </p>
    </div>
  );
}

/** Owner only: tokens in the agent wallet that no position accounts for (reported by the worker). */
function UntrackedTokens({ tokens }: { tokens: NonNullable<AgentDTO["untrackedTokens"]> }) {
  return (
    <Panel className="flex flex-col gap-2 p-4 app:p-5" aria-labelledby="untracked-title">
      <CardTitle id="untracked-title">Other tokens in the agent wallet</CardTitle>
      <p className="text-[12.5px] leading-snug text-muted">
        The wallet holds tokens no copied trade explains (airdrops, spam or dust). They are not sold, valued or withdrawn
        automatically.
      </p>
      <ul className="mt-1 flex flex-col divide-y divide-border rounded-card-sm border border-border bg-card-2 font-mono text-[12px]">
        {tokens.map((t) => (
          <li key={t.mint} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 px-3 py-2">
            <a
              href={solscanAccount(t.mint)}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 break-all font-semibold text-text hover:text-mint-700"
            >
              {shortAddr(t.mint, 6, 6)}
              <Icon name="external" size={11} strokeWidth={2.2} className="text-icon" />
              <span className="sr-only"> (Solscan, opens in a new tab)</span>
            </a>
            <span className="text-text-2">raw {t.raw}</span>
            <span className="font-sans text-muted">{t.why}</span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function DashboardSkeleton() {
  return (
    <div className={WRAP} aria-busy="true" aria-label="Loading agent">
      <Card className="p-4 app:p-6">
        <div className="flex items-center gap-5">
          <span className="size-[72px] shrink-0 rounded-[16px] bg-card-3 animate-blink app:size-[104px] app:rounded-[20px]" />
          <div className="flex min-w-0 flex-col gap-3">
            <span className="h-3 w-24 rounded-full bg-card-3" />
            <span className="h-7 w-56 max-w-full rounded-full bg-card-3" />
            <span className="h-3 w-40 max-w-full rounded-full bg-card-3" />
          </div>
        </div>
        <div className="mt-6 grid grid-cols-2 gap-2.5 sm:grid-cols-3 side:grid-cols-6">
          {Array.from({ length: 6 }, (_, i) => (
            <span key={i} className="h-[84px] rounded-card-sm bg-card-2" />
          ))}
        </div>
      </Card>
      <div className={ROW}>
        <Card className="h-64" />
        <Card className="h-64" />
      </div>
    </div>
  );
}

/** Also rendered by app/agents/[id]/not-found.tsx (server-side 404, where the id isn't available). */
export function AgentNotFound({ idOrSlug }: { idOrSlug?: string }) {
  return (
    <div className={WRAP}>
      <Card className="relative flex flex-col items-center gap-3 overflow-hidden px-5 py-14 text-center">
        <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-40 bg-[linear-gradient(180deg,var(--mint-50),rgb(239_252_249/0))]" />
        <PixelRobot name="tofu" size={128} className="relative" />
        <Kicker className="relative">error 404</Kicker>
        <Heading as="h1" size="xl" className="relative">
          No agent here
        </Heading>
        <p className="relative max-w-md text-[14px] leading-relaxed text-muted">
          {idOrSlug ? (
            <>
              Nothing answers to <span className="break-all font-mono font-medium text-text">{idOrSlug}</span>.
            </>
          ) : (
            "Nothing answers to this link."
          )}{" "}
          Check the link, or build a fresh one.
        </p>
        <div className="relative mt-2 flex flex-wrap justify-center gap-2">
          <ButtonLink href="/create" variant="ink" iconEnd="arrow">
            Build an agent
          </ButtonLink>
          <ButtonLink href="/floor" variant="outline">
            See the floor
          </ButtonLink>
        </div>
      </Card>
    </div>
  );
}
