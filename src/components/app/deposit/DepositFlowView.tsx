"use client";

// What the one-click deposit is doing right now: a three-stage track (sign → confirm → funded), one plain
// status line, and the one action that makes sense next (connect, retry, check on Solscan).

import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { fmtSol, shortAddr, solscanTx } from "@/lib/format";
import { Icon } from "@/components/ui/icons";
import { Button, buttonClass, cn } from "@/components/ui/primitives";
import { useSession } from "@/components/wallet/session";
import type { DepositPhase } from "./useDepositFlow";

const STAGES = ["Approve", "Confirming", "Funded"] as const;

function stageOf(p: DepositPhase): { at: number; failed: boolean } {
  switch (p.step) {
    case "idle":
    case "needs_wallet":
    case "wrong_wallet":
    case "preparing":
    case "signing":
      return { at: 0, failed: false };
    case "sending":
      return { at: 1, failed: false };
    case "done":
      return { at: p.result.status === "confirmed" ? 3 : 2, failed: false };
    case "error":
      return { at: p.kind === "unknown" ? 1 : 0, failed: true };
  }
}

function SolscanLink({ signature }: { signature: string }) {
  return (
    <a
      href={solscanTx(signature)}
      target="_blank"
      rel="noopener noreferrer"
      className="relative inline-flex items-center gap-1 text-[12px] font-semibold text-mint-700 underline after:absolute after:inset-x-0 after:-inset-y-3 decoration-mint-300 underline-offset-2"
    >
      <span className="font-mono font-medium">{signature.slice(0, 10)}…</span> on Solscan
      <Icon name="external" size={11} strokeWidth={2.2} />
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}

export function DepositFlowView({
  phase,
  onRetry,
  onDismiss,
  className,
}: {
  phase: DepositPhase;
  onRetry: () => void;
  /** Offered once the flow is over (done or error). */
  onDismiss?: () => void;
  className?: string;
}) {
  const session = useSession();
  const { disconnect } = useWallet();
  const { setVisible } = useWalletModal();
  if (phase.step === "idle") return null;
  const { at, failed } = stageOf(phase);
  const amount = fmtSol(phase.amountSol, 4);

  let line: string;
  let tone: "dim" | "up" | "down" | "amber" | "cyan" = "cyan";
  switch (phase.step) {
    case "needs_wallet":
      line = `Connect your wallet (${shortAddr(session.wallet)}) to sign the ${amount} transfer.`;
      tone = "amber";
      break;
    case "wrong_wallet":
      line = `Your wallet is on ${shortAddr(phase.connected)}. Switch it to ${shortAddr(phase.owner)} (the owner) to sign; this continues on its own.`;
      tone = "amber";
      break;
    case "preparing":
      line = `Preparing a ${amount} transfer…`;
      break;
    case "signing":
      line = `Approve the ${amount} transfer in your wallet.`;
      break;
    case "sending":
      line = `Sent. Waiting for Solana to confirm ${amount}…`;
      break;
    case "done":
      line =
        phase.result.status === "confirmed"
          ? `✓ ${amount} landed. ${phase.result.agent.status === "active" ? "Copying is on." : "The agent switches on once it holds the minimum."}`
          : `Sent, not confirmed yet. The balance updates by itself once it lands (usually seconds).`;
      tone = "up";
      break;
    case "error":
      line = phase.message;
      tone = phase.kind === "unknown" ? "amber" : phase.kind === "rejected" ? "dim" : "down";
      break;
  }

  const TONE = { dim: "text-muted", up: "text-up", down: "text-down", amber: "text-warn", cyan: "text-info" } as const;
  const busy = phase.step === "preparing" || phase.step === "signing" || phase.step === "sending";

  return (
    <div className={cn("rounded-card-sm border border-border bg-card-2 p-3.5", className)} role="status" aria-live="polite">
      <ol className="grid grid-cols-3 gap-1.5" aria-label="Deposit progress">
        {STAGES.map((label, i) => {
          const complete = i < at;
          const current = i === at && !complete;
          return (
            <li key={label} className="flex min-w-0 flex-col gap-1.5">
              <span
                aria-hidden
                className={cn(
                  "h-1.5 rounded-full",
                  complete ? "bg-up" : current ? (failed ? "bg-down" : "bg-mint-500 animate-blink") : "bg-card-3",
                )}
              />
              <span className={cn("flex min-w-0 items-center gap-1 text-[11.5px] font-semibold", complete ? "text-up" : current ? "text-text" : "text-muted")}>
                {complete ? <Icon name="check" size={12} strokeWidth={2.8} className="shrink-0" /> : null}
                {label}
                <span className="sr-only">{complete ? " (done)" : current ? (failed ? " (stopped)" : " (in progress)") : ""}</span>
              </span>
            </li>
          );
        })}
      </ol>

      <p className={cn("mt-3 text-[13px] font-medium leading-snug", TONE[tone])}>{line}</p>

      {"signature" in phase && phase.signature ? (
        <p className="mt-1.5">
          <SolscanLink signature={phase.signature} />
        </p>
      ) : phase.step === "done" ? (
        <p className="mt-1.5">
          <SolscanLink signature={phase.result.signature} />
        </p>
      ) : null}

      {!busy ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {phase.step === "needs_wallet" ? (
            <Button type="button" variant="ink" icon="wallet" onClick={session.connectWallet} disabled={session.busy !== null}>
              Connect wallet
            </Button>
          ) : null}
          {phase.step === "wrong_wallet" ? (
            <button
              type="button"
              className={buttonClass("outline")}
              onClick={async () => {
                await disconnect().catch(() => undefined);
                setVisible(true); // pick the owner wallet; the transfer continues once it connects
              }}
            >
              Use another wallet
            </button>
          ) : null}
          {phase.step === "error" && phase.kind !== "unknown" ? (
            <Button type="button" variant="ink" icon="refresh" onClick={onRetry}>
              Try again
            </Button>
          ) : null}
          {phase.step === "error" && phase.kind === "unknown" ? (
            // Deliberately secondary: the first transfer may still land.
            <button type="button" className={buttonClass("outline")} onClick={onRetry}>
              Send a new transfer anyway
            </button>
          ) : null}
          {onDismiss && (phase.step === "done" || phase.step === "error") ? (
            <button type="button" className={buttonClass("ghost")} onClick={onDismiss}>
              {phase.step === "done" ? "OK" : "Cancel"}
            </button>
          ) : null}
        </div>
      ) : null}
      {session.error && phase.step === "needs_wallet" ? (
        <p role="alert" className="mt-2 flex items-start gap-1.5 text-[12px] font-medium text-down">
          <Icon name="x" size={13} strokeWidth={2.6} className="mt-px shrink-0" />
          {session.error}
        </p>
      ) : null}
    </div>
  );
}
