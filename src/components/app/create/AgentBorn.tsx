"use client";

// Right after "Create": the agent pops in, and (live) the wallet pops up at once to sign the deposit transfer the
// server returned. Paper agents were already credited with simulated SOL. Nothing needs saving: the agent
// belongs to the signed-in wallet and shows up under "Your agents".

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentDetailDTO, AgentDTO, CreateAgentResult } from "@/lib/types";
import { fmtSol, traderLabel } from "@/lib/format";
import { Icon } from "@/components/ui/icons";
import { ButtonLink, cn } from "@/components/ui/primitives";
import { CopyDesk } from "../CopyDesk";
import { DepositAddress } from "../DepositAddress";
import { DepositFlowView } from "../deposit/DepositFlowView";
import { useDepositFlow } from "../deposit/useDepositFlow";
import { Notice } from "../Field";
import { useAppConfig, usePolled } from "../hooks";
import { ModePill, StatusPill } from "../Tags";
import { traderSeed } from "../TraderAvatar";

/**
 * The pop-in, as whole multiples of the 32 px sprite so the pixel art stays crisp on every frame (no fractional
 * scale()). The robot's feet stay put: the box above it shrinks as it grows.
 */
const GROW_SIZES = [32, 64, 96, 128] as const;
const GROWN = GROW_SIZES.length - 1;
const AGENT_PX = GROW_SIZES[GROWN];

/** Square "pixel" sparks around the agent robot once it has grown (decorative), relative to the desk. */
const SPARKS: { x: string; y: string; c: string; d: number }[] = [
  { x: "-8%", y: "60%", c: "bg-mint-500", d: 0 },
  { x: "102%", y: "54%", c: "bg-acc-pink", d: 150 },
  { x: "4%", y: "88%", c: "bg-acc-blue", d: 300 },
  { x: "92%", y: "86%", c: "bg-acc-gold", d: 80 },
  { x: "12%", y: "40%", c: "bg-acc-violet", d: 220 },
  { x: "86%", y: "36%", c: "bg-mint-400", d: 360 },
];

/** Stepped pop-in. Jumps straight to the end for reduced-motion users. */
function useGrowStage(): number {
  const [stage, setStage] = useState(0);
  useEffect(() => {
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    const timers = reduced
      ? [setTimeout(() => setStage(GROWN), 0)]
      : GROW_SIZES.slice(1).map((_, i) => setTimeout(() => setStage(i + 1), 250 + i * 200));
    return () => timers.forEach(clearTimeout);
  }, []);
  return stage;
}

export function AgentBorn({ result, depositSol }: { result: CreateAgentResult; depositSol: number }) {
  const { config } = useAppConfig();
  const [agent, setAgent] = useState<AgentDTO>(result.agent);
  const stage = useGrowStage();
  const grown = stage >= GROWN;
  const px = GROW_SIZES[stage];
  const live = usePolled<AgentDetailDTO>(`/api/agents/${encodeURIComponent(agent.id)}`, 5000);
  const current = live.data?.agent ?? agent;
  const originals = agent.traders.map((t) => ({ seed: traderSeed(t), label: traderLabel(t) }));
  const { mutate, refresh } = live;

  const onAgent = useCallback(
    (a: AgentDTO) => {
      setAgent(a);
      mutate((d) => ({ ...d, agent: a }));
      refresh();
    },
    [mutate, refresh],
  );
  const flow = useDepositFlow(agent, onAgent);
  const { start } = flow;

  // Live: ask the wallet to sign the deposit the server already built, right away (once).
  const started = useRef(false);
  useEffect(() => {
    if (started.current || !result.deposit || agent.mode !== "live") return;
    started.current = true;
    void start(result.deposit.amountSol, result.deposit);
  }, [result.deposit, agent.mode, start]);

  const isLive = agent.mode === "live";
  const waiting = current.status === "awaiting_deposit";

  // Deposit confirmed and copying switched on: move on to the dashboard (the button stays for the impatient).
  const router = useRouter();
  const dashboardHref = `/agents/${encodeURIComponent(agent.slug)}`;
  const landed = flow.phase.step === "done" && flow.phase.result.status === "confirmed" && flow.phase.result.agent.status === "active";
  useEffect(() => {
    if (!landed) return;
    const t = setTimeout(() => router.push(dashboardHref), 2500);
    return () => clearTimeout(t);
  }, [landed, router, dashboardHref]);

  return (
    <div className="flex flex-col gap-4 app:gap-5">
      <section className="overflow-hidden rounded-card border border-hairline bg-card text-text shadow-card" aria-labelledby="born-title">
        <div className="grid grid-cols-1 @3xl:grid-cols-[minmax(0,340px)_minmax(0,1fr)]">
          {/* the stage: same mint as the wizard's live preview, now with the real agent */}
          <div
            className="relative m-3 flex flex-col items-center overflow-hidden rounded-hero border border-mint-100 px-4 pb-6 pt-7 text-center @3xl:mr-0"
            style={{
              background:
                "radial-gradient(300px 180px at 50% 62%, rgb(255 255 255 / 0.95), rgb(255 255 255 / 0) 70%), linear-gradient(170deg, var(--mint-50), var(--mint-100) 60%, var(--mint-200))",
            }}
          >
            <div className="relative">
              {grown
                ? SPARKS.map((s, i) => (
                    <span
                      key={i}
                      aria-hidden
                      className={cn("absolute size-2 animate-blink", s.c)}
                      style={{ left: s.x, top: s.y, animationDelay: `${s.d}ms` }}
                    />
                  ))
                : null}
              <CopyDesk
                originals={originals}
                agentSeed={agent.id}
                agentMood={grown ? "happy" : "blink"}
                size={AGENT_PX}
                maxShown={3}
                agentClassName={grown ? "animate-bob" : undefined}
                agentStyle={{ width: px, height: px, marginTop: AGENT_PX - px }}
              />
            </div>
            <p
              className="mt-4 inline-flex items-center gap-1.5 text-[11.5px] font-bold uppercase tracking-[0.12em] text-mint-800"
              aria-live="polite"
            >
              {grown ? <Icon name="sparkle" size={13} strokeWidth={2.4} /> : null}
              {grown ? "agent grown" : "growing…"}
            </p>
            <h1 id="born-title" className="mt-1.5 max-w-full break-all text-[24px] font-extrabold leading-tight tracking-[-0.03em] text-text app:text-[28px]">
              {agent.name}
            </h1>
            <div className="mt-2.5 flex flex-wrap justify-center gap-1.5">
              <StatusPill status={current.status} />
              <ModePill mode={agent.mode} />
            </div>
            <p className="mt-2.5 text-[13px] font-medium text-text-2">Copying {agent.traders.map((t) => traderLabel(t)).join(", ")}</p>
          </div>

          <div className="flex min-w-0 flex-col justify-center gap-5 p-5 app:p-7">
            <div>
              <p className="text-[11.5px] font-bold uppercase tracking-[0.08em] text-muted">
                {isLive ? "Funding from your wallet" : "Paper funding · simulated"}
              </p>
              <div className="mt-2 flex flex-wrap items-end justify-between gap-x-3 gap-y-1.5">
                <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[13px] font-medium text-muted">
                  Balance{" "}
                  <span className="font-mono text-[26px] font-semibold leading-none tracking-[-0.02em] text-text">
                    {fmtSol(current.balanceSol)}
                  </span>
                  {!isLive ? (
                    <span className="inline-flex h-[22px] items-center rounded-full border border-paper-border bg-paper-bg px-2 text-[11.5px] font-semibold text-paper-ink">
                      simulated
                    </span>
                  ) : null}
                </p>
                {waiting ? (
                  <p className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-info">
                    <Icon name="clock" size={14} strokeWidth={2.2} />
                    waiting for deposit<span className="animate-blink">_</span>
                  </p>
                ) : current.status === "active" ? (
                  <p className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-up">
                    <Icon name="check" size={14} strokeWidth={2.6} />
                    funded — copying is on
                  </p>
                ) : null}
              </div>
            </div>

            {isLive ? (
              result.deposit ? (
                <DepositFlowView
                  phase={flow.phase}
                  onRetry={() => void flow.start(result.deposit?.amountSol ?? depositSol)}
                />
              ) : (
                <Notice tone="amber" title="No transfer to sign">
                  The server didn&apos;t return a deposit transfer. Top up from the dashboard, or send SOL to the deposit
                  address below.
                </Notice>
              )
            ) : (
              <Notice tone="lime" title="Simulated deposit credited">
                {fmtSol(depositSol, 4)} of paper SOL was added. No real SOL moved and nothing was signed. The agent copies
                against live Jupiter quotes{waiting ? ` once it holds ≥ ${fmtSol(config.minDepositSol)}` : " from the next trade"}.
              </Notice>
            )}

            {isLive ? (
              <details className="group rounded-card-sm border border-border bg-card-2/60">
                <summary
                  className={cn(
                    "flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-card-sm px-3.5 text-[13px] font-semibold text-text-2 hover:text-text",
                    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus [&::-webkit-details-marker]:hidden",
                  )}
                >
                  <Icon name="chev-right" size={15} strokeWidth={2.4} className="shrink-0 text-icon transition-transform duration-150 group-open:rotate-90" />
                  Prefer to send SOL manually? Show the deposit address
                </summary>
                <div className="px-3.5 pb-3.5 pt-1">
                  <DepositAddress address={agent.depositAddress} mode="live" size="md" idPrefix="born" />
                  <p className="mt-3 text-[12.5px] leading-snug text-muted">
                    Any wallet can send SOL here; the agent activates at ≥ {fmtSol(config.minDepositSol)}. Withdrawals only
                    ever go back to the wallet you signed in with.
                  </p>
                </div>
              </details>
            ) : null}

            <div className="flex flex-wrap items-center gap-x-4 gap-y-3 border-t border-border pt-5">
              <ButtonLink href={dashboardHref} variant="ink" size="lg" iconEnd={landed ? undefined : "arrow"}>
                {landed ? "Opening dashboard…" : "Open dashboard"}
              </ButtonLink>
              <p className="max-w-xs text-[12.5px] leading-snug text-muted">
                It&apos;s saved to your wallet: find it any time under <span className="font-semibold text-text">Your agents</span>.
              </p>
            </div>
          </div>
        </div>
      </section>

      <Notice tone="dim">Copy-trading memecoins is risky. Watch the first few copies on the dashboard before you size up.</Notice>
    </div>
  );
}
