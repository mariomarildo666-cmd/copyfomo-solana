"use client";

// Step 3: who owns the agent (the signed-in wallet) and how much to fund it with.

import type { Mode } from "@/lib/types";
import { shortAddr } from "@/lib/format";
import { RobotTile } from "@/components/bots/RobotTile";
import { Icon } from "@/components/ui/icons";
import { useSession } from "@/components/wallet/session";
import { SignInPanel } from "@/components/wallet/WalletButton";
import { AmountPicker } from "../deposit/AmountPicker";
import { FieldError, Notice } from "../Field";

export function StepFund({
  mode,
  minDepositSol,
  value,
  onChange,
  error,
  walletSol,
  walletLoading,
  walletError,
  signInError,
}: {
  mode: Mode;
  minDepositSol: number;
  value: string;
  onChange: (v: string) => void;
  error?: string | null;
  walletSol: number | null;
  walletLoading: boolean;
  walletError: string | null;
  signInError?: string | null;
}) {
  const session = useSession();

  if (!session.wallet) {
    return (
      <div className="flex flex-col gap-3">
        <SignInPanel>
          Your agent belongs to the wallet you sign in with.{" "}
          {mode === "live" ? "You fund it from that wallet, and withdrawals" : "Withdrawals"} only ever go back to it. There&apos;s
          no password or key to save.
        </SignInPanel>
        <FieldError>{signInError}</FieldError>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-start gap-3 rounded-card-sm border border-border bg-card-2/60 p-3.5">
        <RobotTile seed={session.wallet} variant="agent" size="xs" shape="circle" />
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-[11.5px] font-bold uppercase tracking-[0.08em] text-muted">
            <Icon name="shield" size={13} strokeWidth={2.2} className="text-mint-700" />
            Owner &amp; payout wallet
          </p>
          <p className="addr mt-1 break-all text-[12.5px] text-text">{session.wallet}</p>
          <p className="mt-1 text-[12px] leading-snug text-muted">
            The wallet you signed in with owns this agent. Withdrawals can only ever go back to it.
          </p>
        </div>
      </div>

      {mode === "live" && session.mismatch && session.connected ? (
        <Notice tone="amber" title="Wallet switched">
          Your wallet is on <span className="font-mono">{shortAddr(session.connected)}</span>, but you&apos;re signed in as{" "}
          <span className="font-mono">{shortAddr(session.wallet)}</span>. Switch back in your wallet before creating: the
          deposit must come from the owner wallet.
        </Notice>
      ) : null}

      <AmountPicker
        id="fund-amount"
        value={value}
        onChange={onChange}
        mode={mode}
        minSol={minDepositSol}
        minLabel="activates at"
        walletSol={walletSol}
        walletLoading={walletLoading}
        error={error}
      />
      {mode === "live" && walletError ? (
        <p className="flex items-start gap-1.5 text-[12px] font-medium leading-snug text-warn">
          <Icon name="alert" size={13} strokeWidth={2.2} className="mt-px shrink-0" />
          Couldn&apos;t read your wallet balance ({walletError}). Your wallet will check it when you sign.
        </p>
      ) : null}

      {mode === "live" ? (
        <p className="flex items-start gap-2 text-[12.5px] leading-snug text-muted">
          <Icon name="wallet" size={15} strokeWidth={2} className="mt-px shrink-0 text-icon" />
          <span>
            After you create the agent, your wallet asks you to approve{" "}
            <span className="font-semibold text-text">one SOL transfer</span> to the agent&apos;s own wallet. Nothing else
            is signed. You can top up later from the dashboard.
          </span>
        </p>
      ) : (
        <Notice tone="amber" title="Paper mode · simulated">
          This amount is credited as simulated SOL the moment the agent is created. No real SOL moves and no transaction
          is signed.
        </Notice>
      )}
    </div>
  );
}
