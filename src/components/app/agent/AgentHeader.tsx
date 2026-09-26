"use client";

// The agent dashboard's header: the same ProfileHeader as a trader's profile (teal band, the agent's robot on its
// accent tile, name, status, who it copies), then six stat tiles. Amounts are mono (the type rule); counts,
// percentages and times are not.

import type { ReactNode } from "react";
import type { AgentDTO, CopyTradeDTO, Side } from "@/lib/types";
import { fmtMs, fmtPct, fmtSignedSol, fmtSol, solscanAccount, timeAgo, traderLabel } from "@/lib/format";
import { RobotTile } from "@/components/bots/RobotTile";
import { robotMood, type RobotMood } from "@/components/bots/params";
import { Icon, type IconName } from "@/components/ui/icons";
import { DotList, Kicker, PixelSigned, cn } from "@/components/ui/primitives";
import { ProfileHeader } from "../ProfileHeader";
import { ModePill, StatusPill } from "../Tags";
import { traderSeed } from "../TraderAvatar";
import { sizingSummary } from "../create/StepReview";
import { feePct } from "../fees";

/** Side of the agent's latest filled copy (what its robot's face shows), or null before the first fill. */
export function lastFilledSide(trades: CopyTradeDTO[]): Side | null {
  let last: CopyTradeDTO | null = null;
  for (const t of trades) {
    if (t.status !== "filled") continue;
    if (!last || Date.parse(t.createdAt) > Date.parse(last.createdAt)) last = t;
  }
  return last?.side ?? null;
}

/** The agent robot's mood: asleep when paused / stopped, else the side of its latest fill, else idle. */
export function agentMood(agent: AgentDTO, trades: CopyTradeDTO[]): RobotMood {
  return robotMood({ status: agent.status, lastSide: lastFilledSide(trades) });
}

function moodWords(mood: RobotMood): string {
  if (mood === "sleep") return "asleep";
  if (mood === "buy") return "last copied a buy";
  if (mood === "sell") return "last copied a sell";
  return "watching";
}

/** "+1.23 SOL" → ["+1.23", "SOL"] so the number can be big and the unit small. */
function splitUnit(s: string): [string, string | null] {
  const m = /^(.*\S)\s+(SOL)$/.exec(s);
  return m ? [m[1], m[2]] : [s, null];
}

type Tone = "up" | "down" | undefined;

function toneOf(n: number): Tone {
  return n > 0 ? "up" : n < 0 ? "down" : undefined;
}

function StatTile({
  label,
  value,
  tone,
  icon,
  hint,
  amount,
}: {
  label: string;
  value: string;
  tone?: Tone;
  icon: IconName;
  hint?: ReactNode;
  /** A SOL amount: mono. */
  amount?: boolean;
}) {
  const [num, unit] = splitUnit(value);
  const trendIcon: IconName | null = tone === "up" ? "trend" : tone === "down" ? "trend-down" : null;
  return (
    <div className="flex min-w-0 flex-col rounded-card-sm border border-border bg-card-2 px-3.5 py-3">
      <p className="flex min-w-0 items-center gap-1.5 text-[12px] font-semibold text-muted">
        <Icon name={icon} size={13} strokeWidth={2} className="shrink-0 text-icon" />
        <span className="truncate">{label}</span>
      </p>
      <p
        className={cn(
          "mt-2 flex min-w-0 items-baseline gap-1 text-[20px] leading-none tabular-nums app:text-[22px]",
          amount ? "num font-semibold tracking-[-0.04em]" : "font-extrabold tracking-[-0.02em]",
          tone === "up" ? "text-up" : tone === "down" ? "text-down" : "text-text",
        )}
      >
        {trendIcon ? <Icon name={trendIcon} size={15} strokeWidth={2.4} className="shrink-0 self-center" /> : null}
        <span className="min-w-0 truncate" title={value}>
          <PixelSigned text={num} />
        </span>
        {/* full colour: at 70 % opacity the red unit fell under AA on the grey tile */}
        {unit ? <span className="shrink-0 font-sans text-[12px] font-bold tracking-normal">{unit}</span> : null}
      </p>
      {hint ? (
        <p className="mt-1.5 truncate text-[11.5px] font-medium text-muted" title={typeof hint === "string" ? hint : undefined}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

function OriginalChip({ trader }: { trader: AgentDTO["traders"][number] }) {
  const label = traderLabel(trader);
  const inner = (
    <>
      <RobotTile seed={traderSeed(trader)} variant="trader" size="2xs" shape="circle" />
      <span className="min-w-0 truncate">{label}</span>
      {trader.wallet ? <Icon name="external" size={12} strokeWidth={2} className="shrink-0 text-icon" /> : null}
    </>
  );
  const cls =
    "flex h-10 max-w-full items-center gap-2 rounded-full border border-border bg-card py-1 pl-1 pr-3 text-[13px] font-semibold text-text shadow-mini";
  return trader.wallet ? (
    <a
      href={solscanAccount(trader.wallet)}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(cls, "transition-colors duration-150 hover:border-mint-300 hover:bg-mint-50 hover:text-mint-800")}
      title={`${label} on Solscan`}
    >
      {inner}
      <span className="sr-only">(Solscan, opens in a new tab)</span>
    </a>
  ) : (
    <span className={cls}>{inner}</span>
  );
}

export function AgentHeader({
  agent,
  trades,
  now,
  platformFeeBps,
}: {
  agent: AgentDTO;
  trades: CopyTradeDTO[];
  now: number;
  platformFeeBps: number;
}) {
  const mood = agentMood(agent, trades);
  const robotTitle = `${agent.name}, ${moodWords(mood)}`;
  const n = agent.traders.length;

  return (
    <ProfileHeader
      robot={{ seed: agent.id, variant: "agent", mood, label: robotTitle }}
      kicker="Copy agent"
      title={<span className="break-all">{agent.name}</span>}
      chips={
        <>
          <StatusPill status={agent.status} />
          <ModePill mode={agent.mode} />
        </>
      }
      subline={
        <DotList
          align="start"
          className="text-[12.5px]"
          items={[`born ${timeAgo(agent.createdAt, now)}`, sizingSummary(agent), <>max <span className="num">{fmtSol(agent.maxPerTradeSol)}</span></>]}
        />
      }
      aside={
        <div className="min-w-0">
          <Kicker>
            Copying {n} original{n === 1 ? "" : "s"}
          </Kicker>
          <ul className="mt-2.5 flex flex-wrap gap-2">
            {agent.traders.map((t) => (
              <li key={t.wallet ?? traderLabel(t)} className="min-w-0 max-w-full">
                <OriginalChip trader={t} />
              </li>
            ))}
          </ul>
        </div>
      }
    >
      <div className="relative grid grid-cols-2 gap-2.5 border-t border-border px-4 py-4 app:px-6 app:py-5 @min-[560px]:grid-cols-3 @min-[980px]:grid-cols-6">
        <StatTile
          label="Equity"
          icon="wallet"
          amount
          value={fmtSol(agent.equitySol)}
          hint={agent.valuationStale ? "estimate · prices unavailable" : `cash ${fmtSol(agent.balanceSol)}`}
        />
        <StatTile
          label="PnL after fees"
          icon="activity"
          amount
          value={fmtSignedSol(agent.pnlSol)}
          tone={toneOf(agent.pnlSol)}
          hint={agent.valuationStale ? "estimate · prices unavailable" : undefined}
        />
        <StatTile label="ROI" icon="target" value={fmtPct(agent.roiPct)} tone={toneOf(agent.roiPct)} />
        <StatTile label="Copies" icon="swap" value={agent.copies.toLocaleString("en-US")} />
        <StatTile label="Median latency" icon="clock" value={fmtMs(agent.medianLatencyMs)} hint="original → fill" />
        <StatTile
          label="Fees paid"
          icon="sol"
          amount
          value={fmtSol(agent.feesPaidSol, 4)}
          hint={agent.mode === "live" && agent.feeOwedSol > 0 ? `+ ${fmtSol(agent.feeOwedSol, 4)} owed` : `${feePct(platformFeeBps)} of profits`}
        />
      </div>
      {agent.unpricedCount > 0 ? (
        <p className="relative -mt-1.5 flex items-start gap-1.5 px-4 pb-4 text-[12px] font-medium leading-snug text-warn app:px-6 app:pb-6">
          <Icon name="alert" size={14} strokeWidth={2} className="mt-px shrink-0" />
          <span>
            {agent.unpricedCount} position{agent.unpricedCount === 1 ? " has" : "s have"} no price right now (cost{" "}
            {fmtSol(agent.unpricedCostSol, 4)}); equity counts {agent.unpricedCount === 1 ? "it" : "them"} at cost for 24 h, then at 0.
          </span>
        </p>
      ) : null}
    </ProfileHeader>
  );
}
