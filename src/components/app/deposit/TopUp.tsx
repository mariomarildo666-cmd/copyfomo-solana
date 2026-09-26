"use client";

// Owner top-up from the dashboard. Live: the same one-click wallet transfer as the wizard. Paper: simulated SOL
// (POST paper-deposit), never a real transfer.

import { useState, type FormEvent } from "react";
import type { AgentDTO } from "@/lib/types";
import { fmtSol } from "@/lib/format";
import { Button } from "@/components/ui/primitives";
import { useSession } from "@/components/wallet/session";
import { api, errorMessage } from "../api";
import { checkDepositAmount, MIN_TOPUP_SOL } from "./amount";
import { AmountPicker, useWalletBalance } from "./AmountPicker";
import { StatusLine } from "../agent/bits";
import { DepositFlowView } from "./DepositFlowView";
import { isBusy, useDepositFlow } from "./useDepositFlow";

export function TopUp({ agent, onAgent, minDepositSol }: { agent: AgentDTO; onAgent: (a: AgentDTO) => void; minDepositSol: number }) {
  return agent.mode === "live" ? (
    <LiveTopUp agent={agent} onAgent={onAgent} minDepositSol={minDepositSol} />
  ) : (
    <PaperTopUp agent={agent} onAgent={onAgent} minDepositSol={minDepositSol} />
  );
}

function activationHint(agent: AgentDTO, minDepositSol: number): string | null {
  if (agent.status !== "awaiting_deposit") return null;
  const missing = Math.max(0, minDepositSol - agent.balanceSol);
  return missing > 0 ? `Add at least ${fmtSol(missing, 4)} more to switch copying on (activates at ${fmtSol(minDepositSol)}).` : null;
}

function LiveTopUp({ agent, onAgent, minDepositSol }: { agent: AgentDTO; onAgent: (a: AgentDTO) => void; minDepositSol: number }) {
  const session = useSession();
  const [raw, setRaw] = useState("0.5");
  const [attempted, setAttempted] = useState(false);
  const balance = useWalletBalance(true);
  const flow = useDepositFlow(agent, (a) => {
    onAgent(a);
    balance.refresh();
  });
  const check = checkDepositAmount({ raw, mode: "live", minSol: MIN_TOPUP_SOL, walletSol: balance.sol });
  const busy = isBusy(flow.phase);
  const hint = activationHint(agent, minDepositSol);

  function submit(e: FormEvent) {
    e.preventDefault();
    setAttempted(true);
    if (check.amount === null || busy) return;
    void flow.start(check.amount);
  }

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-3">
      <AmountPicker
        id="topup-amount"
        value={raw}
        onChange={(v) => {
          setRaw(v);
          if (!busy) flow.reset();
        }}
        mode="live"
        minSol={MIN_TOPUP_SOL}
        minLabel="minimum top-up"
        walletSol={balance.sol}
        walletLoading={balance.loading}
        error={attempted ? check.error : null}
        disabled={busy}
      />
      {hint ? <StatusLine tone="info" role={null}>{hint}</StatusLine> : null}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="ink" icon="wallet" disabled={busy} aria-busy={busy}>
          {busy ? "Waiting for wallet…" : `Top up${check.amount !== null ? ` ${fmtSol(check.amount, 4)}` : ""}`}
        </Button>
        <p className="max-w-xs text-[12px] leading-snug text-muted">
          One transfer from {session.wallet ? "your wallet" : "the owner wallet"} to this agent. Nothing else is signed.
        </p>
      </div>
      <DepositFlowView
        phase={flow.phase}
        onRetry={() => void flow.start(flow.phase.step === "idle" ? (check.amount ?? 0) : flow.phase.amountSol)}
        onDismiss={flow.reset}
      />
    </form>
  );
}

function PaperTopUp({ agent, onAgent, minDepositSol }: { agent: AgentDTO; onAgent: (a: AgentDTO) => void; minDepositSol: number }) {
  const [raw, setRaw] = useState("1");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const check = checkDepositAmount({ raw, mode: "paper", minSol: MIN_TOPUP_SOL, walletSol: null });
  const hint = activationHint(agent, minDepositSol);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (check.amount === null) {
      setMsg({ tone: "err", text: check.error ?? "Enter an amount." });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const res = await api<{ agent: AgentDTO }>(`/api/agents/${encodeURIComponent(agent.id)}/paper-deposit`, {
        method: "POST",
        body: { amountSol: check.amount },
      });
      setMsg({ tone: "ok", text: `Added ${fmtSol(check.amount, 4)} of simulated SOL. Balance ${fmtSol(res.agent.balanceSol)}.` });
      onAgent(res.agent);
    } catch (err) {
      setMsg({ tone: "err", text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-3">
      <AmountPicker
        id="paper-topup"
        value={raw}
        onChange={(v) => {
          setRaw(v);
          setMsg(null);
        }}
        mode="paper"
        minSol={MIN_TOPUP_SOL}
        minLabel="minimum"
        walletSol={null}
        error={msg?.tone === "err" ? msg.text : null}
        disabled={busy}
      />
      {hint ? <StatusLine tone="info" role={null}>{hint}</StatusLine> : null}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="ink" icon="plus" disabled={busy} aria-busy={busy}>
          {busy ? "Adding…" : "Add simulated SOL"}
        </Button>
        <p className="max-w-xs text-[12px] font-medium leading-snug text-paper-ink">Paper mode: no real SOL moves, nothing is signed.</p>
      </div>
      {msg?.tone === "ok" ? (
        <StatusLine tone="up">{msg.text}</StatusLine>
      ) : null}
    </form>
  );
}
