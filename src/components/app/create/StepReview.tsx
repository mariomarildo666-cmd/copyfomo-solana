"use client";

import type { ReactNode } from "react";
import type { AppConfigDTO, Mode } from "@/lib/types";
import { fmtSol, shortAddr } from "@/lib/format";
import { RobotTile } from "@/components/bots/RobotTile";
import { Icon, type IconName } from "@/components/ui/icons";
import { cn } from "@/components/ui/primitives";
import { rulesPreview, type CopyRules } from "../CopyRules";
import { feeExplainer, feeLine } from "../fees";
import { Field, FieldError, inputClass, Notice } from "../Field";
import type { CopyableTrader } from "../picks";
import { traderSeed } from "../TraderAvatar";
import { traderName } from "../TraderIdentity";

/** What exactly gets copied, stated plainly (design §6.7). */
export function copiesLine(n: number, copyVenue: AppConfigDTO["copyVenue"]): string {
  const whose = n === 1 ? "this trader's" : "these traders'";
  return copyVenue === "fomo"
    ? `Copies ${whose} FOMO buys on Solana and their sells of tokens your agent holds. Cross-chain FOMO trades (Base, BNB, Robinhood Chain…) and trades made in other apps are not copied.`
    : `Copies ${whose} buys and sells on Solana, in FOMO or any other app. Cross-chain FOMO trades (Base, BNB, Robinhood Chain…) are not copied.`;
}

/** How and when the agent switches on, per mode (paper agents are never funded with real SOL). */
export function activationLine(mode: Mode, minDepositSol: number): string {
  return mode === "live"
    ? `Activates once your deposit lands and the agent holds ≥ ${fmtSol(minDepositSol)}.`
    : `Activates once it holds ≥ ${fmtSol(minDepositSol)} of simulated paper SOL.`;
}

export function sizingSummary(r: Pick<CopyRules, "sizingMode" | "fixedSol">): string {
  if (r.sizingMode === "mirror") return "1:1 mirror";
  if (r.sizingMode === "fixed") return `Fixed · ${fmtSol(r.fixedSol)} per buy`;
  return "Proportional to balance";
}

function Row({ label, icon, children }: { label: string; icon: IconName; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[108px_minmax(0,1fr)] items-center gap-3 border-t border-border py-2.5 first:border-t-0 app:grid-cols-[136px_minmax(0,1fr)]">
      <dt className="flex items-center gap-1.5 text-[12px] font-semibold text-muted">
        <Icon name={icon} size={13} strokeWidth={2} className="shrink-0 text-icon" />
        {label}
      </dt>
      <dd className="min-w-0 text-[13.5px] font-medium text-text">{children}</dd>
    </div>
  );
}

/** One line of the "what happens" list, with a mint chevron. */
function Line({ children, strong }: { children: ReactNode; strong?: boolean }) {
  return (
    <li className={cn("flex gap-2", strong ? "text-text" : "text-text-2")}>
      <Icon name="chev-right" size={14} strokeWidth={2.6} className="mt-[3px] shrink-0 text-mint-600" />
      <span>{children}</span>
    </li>
  );
}

export function StepReview({
  traders,
  rules,
  owner,
  depositSol,
  name,
  autoName,
  onName,
  nameError,
  mode,
  copyVenue,
  minDepositSol,
  platformFeeBps,
  ack,
  onAck,
  ackError,
  generalError,
}: {
  traders: CopyableTrader[];
  rules: CopyRules;
  owner: string | null;
  depositSol: number | null;
  name: string;
  autoName: string;
  onName: (v: string) => void;
  nameError?: string | null;
  mode: Mode;
  copyVenue: AppConfigDTO["copyVenue"];
  minDepositSol: number;
  platformFeeBps: number;
  ack: boolean;
  onAck: (v: boolean) => void;
  ackError?: string | null;
  generalError?: string | null;
}) {
  const preview = rulesPreview(rules, traders[0] ? traderName(traders[0]) : "the trader", depositSol ?? minDepositSol);
  return (
    <div className="flex flex-col gap-5">
      <Field
        id="agent-name"
        label="Agent name"
        error={nameError}
        hint={
          <>
            Lowercase letters, numbers, <code className="font-mono">. _ -</code> · max 24. Shown publicly on the floor.
            {autoName ? ` Leave it as is for ${autoName}.` : ""}
          </>
        }
      >
        <input
          id="agent-name"
          value={name}
          onChange={(e) => onName(e.target.value.toLowerCase())}
          placeholder={autoName || "moonmath.copy"}
          maxLength={24}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          className={cn(inputClass, "font-mono")}
          aria-invalid={Boolean(nameError) || undefined}
          aria-describedby="agent-name-hint agent-name-error"
        />
      </Field>

      <dl className="rounded-card-sm border border-border bg-card-2/60 px-3.5 py-1 app:px-4">
        <Row label="Copies" icon="users">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span aria-hidden className="flex -space-x-1.5">
              {traders.slice(0, 4).map((t) => (
                <RobotTile key={t.wallet} seed={traderSeed(t)} variant="trader" size="2xs" shape="circle" style={{ boxShadow: "0 0 0 2px var(--card)" }} />
              ))}
            </span>
            <span>{traders.map((t) => traderName(t)).join(", ")}</span>
          </span>
        </Row>
        <Row label="Sizing" icon="target">
          {sizingSummary(rules)}
        </Row>
        <Row label="Max / trade" icon="shield">
          <span className="font-mono">{fmtSol(rules.maxPerTradeSol)}</span>
        </Row>
        <Row label="Slippage" icon="swap">
          <span className="font-semibold tabular-nums">{(rules.slippageBps / 100).toFixed(rules.slippageBps % 100 ? 2 : 0)}%</span>{" "}
          <span className="text-muted">({rules.slippageBps} bps)</span>
        </Row>
        <Row label="Sells" icon="trend-down">
          {rules.copySells ? "Mirrored by fraction" : "Not copied"}
        </Row>
        <Row label="Deposit" icon="sol">
          {depositSol === null ? (
            "—"
          ) : mode === "live" ? (
            <>
              <span className="font-mono">{fmtSol(depositSol, 4)}</span>{" "}
              <span className="text-muted">from your wallet · you sign one transfer</span>
            </>
          ) : (
            <>
              <span className="font-mono">{fmtSol(depositSol, 4)}</span>{" "}
              <span className="font-semibold text-paper-ink">simulated · nothing is transferred</span>
            </>
          )}
        </Row>
        <Row label="Owner" icon="wallet">
          <span className="addr break-all text-[12.5px]" title={owner ?? undefined}>
            {owner ? shortAddr(owner, 8, 8) : "sign in first"}
          </span>{" "}
          <span className="text-muted">· withdrawals only go here</span>
        </Row>
        <Row label="Fee" icon="info">
          {feeLine(platformFeeBps)}
          {platformFeeBps > 0 ? <span className="text-muted"> · nothing on losing trades</span> : null}
        </Row>
        <Row label="Mode" icon={mode === "live" ? "alert" : "clock"}>
          {mode === "live" ? (
            <span className="font-semibold text-down">Live — real SOL on mainnet</span>
          ) : (
            <span className="font-semibold text-paper-ink">Paper — simulated fills on live quotes</span>
          )}
        </Row>
      </dl>

      <div className="rounded-card-sm border border-dashed border-mint-300 bg-mint-50/60 p-3.5 app:p-4">
        <p className="mb-2 text-[11.5px] font-bold uppercase tracking-[0.08em] text-mint-800">What happens</p>
        <ul className="flex flex-col gap-1.5 text-[13px] leading-relaxed">
          <Line strong>{copiesLine(traders.length, copyVenue)}</Line>
          <Line strong>{preview.buy}</Line>
          <Line>{preview.sell}</Line>
          <Line>{activationLine(mode, minDepositSol)}</Line>
          <Line>{feeExplainer(platformFeeBps)}</Line>
        </ul>
      </div>

      <Notice tone={mode === "live" ? "down" : "amber"} title="Read this">
        Copy-trading memecoins is risky. Traders dump, tokens rug, and a copy always lands a little after the original,
        often at a worse price. {mode === "live" ? "Only deposit SOL you can afford to lose." : "Paper mode moves no real SOL."}
      </Notice>

      <div>
        <label
          className={cn(
            "flex min-h-11 cursor-pointer items-start gap-3 rounded-card-sm border p-3.5 transition-[border-color,background-color,box-shadow] duration-150",
            ack
              ? "border-mint-400 bg-mint-50 shadow-[0_0_0_3px_rgb(47_191_174/0.14)]"
              : "border-border-strong bg-card hover:border-mint-300",
            "has-[input:focus-visible]:outline-2 has-[input:focus-visible]:outline-offset-2 has-[input:focus-visible]:outline-focus",
          )}
        >
          <input
            type="checkbox"
            checked={ack}
            onChange={(e) => onAck(e.target.checked)}
            className="mt-0.5 size-[18px] shrink-0 cursor-pointer accent-mint-700"
            aria-describedby="ack-error"
          />
          <span className="text-[13.5px] font-medium leading-snug text-text">
            I understand my agent trades on its own, copies can lose money, and I can lose what I deposit.
          </span>
        </label>
        <FieldError id="ack-error">{ackError}</FieldError>
      </div>

      {generalError ? (
        <Notice tone="down" title="Couldn't create the agent">
          {generalError}
        </Notice>
      ) : null}
    </div>
  );
}
