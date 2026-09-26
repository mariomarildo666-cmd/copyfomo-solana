"use client";

import type { ReactNode } from "react";
import type { Mode } from "@/lib/types";
import { fmtSol, shortAddr, traderLabel } from "@/lib/format";
import { cn } from "@/components/ui/primitives";
import { CopyDesk } from "../CopyDesk";
import type { CopyRules } from "../CopyRules";
import type { CopyableTrader } from "../picks";
import { ModePill } from "../Tags";
import { traderSeed } from "../TraderAvatar";
import { sizingSummary } from "./StepReview";

/**
 * Live side card: what the agent will look like with the current answers. The robot is seeded by the name typed
 * so far (the agent's id doesn't exist yet), so it is a preview: the created agent gets its own robot.
 */
export function DeskPreview({
  traders,
  rules,
  name,
  owner,
  depositSol,
  mode,
}: {
  traders: CopyableTrader[];
  rules: CopyRules | null;
  name: string;
  owner: string | null;
  depositSol: number | null;
  mode: Mode;
}) {
  const originals = traders.map((t) => ({ seed: traderSeed(t), label: traderLabel(t) }));
  return (
    <section
      className="overflow-hidden rounded-card border border-hairline bg-card text-text shadow-card"
      aria-label="Agent preview"
    >
      <div className="flex items-center justify-between gap-2 px-4 pt-4">
        <p className="flex items-center gap-1.5 text-[11.5px] font-bold uppercase tracking-[0.08em] text-muted">
          <span aria-hidden className="size-1.5 rounded-full bg-mint-500 animate-blink" />
          Live preview
        </p>
        <ModePill mode={mode} />
      </div>

      <div
        className="mx-3 mt-3 rounded-hero border border-mint-100 px-3 pb-3 pt-5"
        style={{
          background:
            "radial-gradient(240px 140px at 50% 100%, rgb(255 255 255 / 0.9), rgb(255 255 255 / 0) 70%), linear-gradient(170deg, var(--mint-50), var(--mint-100))",
        }}
      >
        <CopyDesk originals={originals} agentSeed={name || "new-agent"} size={128} maxShown={3} />
      </div>

      <div className="px-4 pb-4 pt-3">
        <p className="break-all text-center text-[17px] font-extrabold tracking-[-0.02em] text-text">{name || "your-agent.copy"}</p>
        <p className="mt-0.5 text-center text-[11.5px] font-medium text-muted">Preview · its own robot is drawn when it&apos;s created</p>
        <dl className="mt-3.5 rounded-card-sm border border-border bg-card-2/60 px-3 py-1 text-[12.5px]">
          <PreviewRow label="Copies" value={traders.length ? `${traders.length} trader${traders.length === 1 ? "" : "s"}` : "—"} />
          <PreviewRow label="Sizing" value={rules ? sizingSummary(rules) : "—"} />
          <PreviewRow label="Max / trade" value={rules ? fmtSol(rules.maxPerTradeSol) : "—"} mono />
          <PreviewRow label="Slippage" value={rules ? `${rules.slippageBps / 100}%` : "—"} />
          <PreviewRow label="Sells" value={rules ? (rules.copySells ? "mirrored" : "ignored") : "—"} />
          <PreviewRow
            label="Deposit"
            value={
              depositSol === null ? (
                "—"
              ) : (
                <>
                  <span className="num text-[12px] font-medium">{fmtSol(depositSol, 4)}</span>
                  {mode === "paper" ? <span className="font-medium text-muted"> simulated</span> : null}
                </>
              )
            }
          />
          <PreviewRow label="Owner" value={owner ? shortAddr(owner) : "sign in"} mono={Boolean(owner)} />
        </dl>
      </div>
    </section>
  );
}

function PreviewRow({ label, value, mono }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-t border-border py-1.5 first:border-t-0">
      <dt className="shrink-0 font-medium text-muted">{label}</dt>
      <dd className={cn("truncate text-right text-text", mono ? "num text-[12px] font-medium" : "font-semibold")}>{value}</dd>
    </div>
  );
}
