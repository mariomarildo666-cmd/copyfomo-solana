"use client";

import type { AgentDTO } from "@/lib/types";
import { fmtSol, timeAgo } from "@/lib/format";
import { Icon } from "@/components/ui/icons";
import { Kicker, Panel } from "@/components/ui/primitives";
import { DepositAddress } from "../DepositAddress";
import { TopUp } from "../deposit/TopUp";
import { Notice } from "../Field";
import { CardTitle, MiniStat } from "./bits";

/** "1.2345 SOL" → big number + small unit. */
function BigSol({ value }: { value: string }) {
  const m = /^(.*\S)\s+(SOL)$/.exec(value);
  return (
    <span className="flex items-baseline gap-1.5">
      <span className="num text-[30px] font-semibold leading-none tracking-[-0.05em] text-text">{m ? m[1] : value}</span>
      {m ? <span className="text-[13px] font-bold text-muted">{m[2]}</span> : null}
    </span>
  );
}

export function DepositCard({
  agent,
  minDepositSol,
  onAgent,
  now,
}: {
  agent: AgentDTO;
  minDepositSol: number;
  onAgent: (a: AgentDTO) => void;
  now: number;
}) {
  const waiting = agent.status === "awaiting_deposit";
  const stopped = agent.status === "stopped";
  const live = agent.mode === "live";
  const min = fmtSol(minDepositSol);

  return (
    <Panel className="flex flex-col gap-4 p-4 app:p-5" aria-labelledby="deposit-title">
      <CardTitle
        id="deposit-title"
        meta={live && agent.balanceAt ? <span className="text-[12px] font-medium text-muted">checked {timeAgo(agent.balanceAt, now)}</span> : null}
      >
        Balance<span className="sr-only"> and deposits</span>
      </CardTitle>

      {stopped ? (
        <Notice tone="down" title="Stopped — don't deposit">
          This agent was wound down and no longer copies. SOL sent here is not traded.
        </Notice>
      ) : null}

      <div>
        <Kicker>{live ? "Wallet balance" : "Paper balance · simulated"}</Kicker>
        <p className="mt-1.5">
          {/* the balance card is the exact-money card: every figure in it to the same 4-decimal rule */}
          <BigSol value={fmtSol(agent.balanceSol, 4)} />
        </p>
      </div>

      <dl className="grid grid-cols-2 gap-2">
        <MiniStat label="Fees paid">{fmtSol(agent.feesPaidSol, 4)}</MiniStat>
        <MiniStat label={live ? "Fees owed" : "Withdrawable"}>{fmtSol(live ? agent.feeOwedSol : agent.withdrawableSol, 4)}</MiniStat>
      </dl>

      {waiting ? (
        <div className="rounded-card-sm border border-dashed border-info/40 bg-info-bg px-3.5 py-3">
          <p className="flex items-center gap-2 text-[13.5px] font-bold text-info">
            <span aria-hidden className="size-2 rounded-full bg-info animate-blink" />
            Waiting for deposit
          </p>
          <p className="mt-1 text-[13px] leading-snug text-text-2">
            {live
              ? `Copying starts once the agent holds ≥ ${min}. ${agent.isOwner ? "Top up from your wallet below, or send SOL to the address." : "Only the owner funds it."}`
              : `Paper agent: copying starts once it holds ≥ ${min} of simulated SOL. ${agent.isOwner ? "Add some below." : "Only the owner can add it."}`}
          </p>
        </div>
      ) : null}

      {agent.isOwner && !stopped ? (
        <section className="border-t border-border pt-4" aria-labelledby="topup-title">
          <h3 id="topup-title" className="mb-3 text-[11.5px] font-bold uppercase tracking-[0.08em] text-muted">
            {live ? "Top up from your wallet" : "Top up · simulated"}
          </h3>
          <TopUp agent={agent} onAgent={onAgent} minDepositSol={minDepositSol} />
        </section>
      ) : null}

      <div className="border-t border-border pt-4">
        {live ? (
          <details className="group">
            <summary className="flex min-h-10 cursor-pointer list-none items-center gap-1.5 rounded-btn text-[13px] font-semibold text-text-2 hover:text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus [&::-webkit-details-marker]:hidden">
              <Icon name="chev-right" size={15} strokeWidth={2.2} className="shrink-0 text-icon transition-transform duration-150 group-open:rotate-90" />
              Deposit address (send SOL manually)
            </summary>
            <div className="mt-3">
              <DepositAddress address={agent.depositAddress} mode="live" size="md" idPrefix="dash" />
            </div>
          </details>
        ) : (
          <DepositAddress address={agent.depositAddress} mode="paper" size="md" idPrefix="dash" />
        )}
      </div>
    </Panel>
  );
}
