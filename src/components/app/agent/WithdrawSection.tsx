"use client";

import { useState, type FormEvent } from "react";
import type { AgentDTO, CommandDTO, WithdrawInput } from "@/lib/types";
import { fmtSol, shortAddr } from "@/lib/format";
import { Icon } from "@/components/ui/icons";
import { Button, buttonClass, cn } from "@/components/ui/primitives";
import { ApiRequestError, errorMessage } from "../api";
import { checkWithdrawAmount } from "../deposit/amount";
import { FieldError, inputClass, Notice } from "../Field";
import { MiniStat } from "./bits";
import { CommandStatusView } from "./CommandStatus";
import { agentPath, conflictCommand, isInFlight, useCommand, type OwnerApi } from "./ownerApi";

type Amount = "all" | "amount";

export function WithdrawSection({
  agent,
  ownerApi,
  positionsCount,
  workerOnline,
}: {
  agent: AgentDTO;
  ownerApi: OwnerApi;
  positionsCount: number;
  workerOnline: boolean | null;
}) {
  const [which, setWhich] = useState<Amount>("all");
  const [amount, setAmount] = useState("");
  const [closeFirst, setCloseFirst] = useState(false);
  const [confirming, setConfirming] = useState<WithdrawInput | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const cmd = useCommand(agent.id, ownerApi, "withdraw");
  const inFlight = cmd.command !== null && isInFlight(cmd.command);

  // Server-computed: balance − fees owed − the live rent/fee buffer (and, when closing first, an estimate of
  // what the positions sell for, minus the fee on their profit). The worker re-checks the real balance.
  // "Close first" works with "Everything" only while positions are open (the API refuses a set amount + close:
  // the sale proceeds aren't known in advance). With no positions it is a no-op either way.
  const closeAllowed = which === "all" || positionsCount === 0;
  const close = closeFirst && closeAllowed;
  const ceiling = Math.max(0, close ? agent.withdrawAfterCloseSol : agent.withdrawableSol);
  const destination = agent.payoutAddress ?? agent.ownerWallet ?? null;
  const live = agent.mode === "live";

  function review(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (which === "all") {
      setConfirming({ all: true, closePositions: close });
      return;
    }
    const check = checkWithdrawAmount(amount, ceiling, close);
    if (check.amount === null) {
      setError(check.error);
      return;
    }
    setConfirming({ amountSol: check.amount, closePositions: close });
  }

  async function send() {
    if (!confirming) return;
    setBusy(true);
    setError(null);
    try {
      const res = await ownerApi<{ command: CommandDTO }>(agentPath(agent.id, "/withdraw"), {
        method: "POST",
        body: confirming,
      });
      cmd.setCommand(res.command);
      setConfirming(null);
      setAmount("");
    } catch (err) {
      const open = conflictCommand(err);
      if (open) {
        cmd.setCommand(open);
        setConfirming(null);
      } else {
        // Field reasons ("at least 0.0001 SOL") beat a bare "invalid input".
        setError(err instanceof ApiRequestError && err.fields?.amountSol ? err.fields.amountSol : errorMessage(err));
      }
    } finally {
      setBusy(false);
    }
  }

  const summary = confirming
    ? `${confirming.all ? "Everything" : fmtSol(confirming.amountSol ?? 0, 4)}${confirming.closePositions ? ", after selling all positions," : ""} to ${destination ? shortAddr(destination, 6, 6) : "your wallet"}`
    : "";

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start gap-3 rounded-card-sm border border-mint-200 bg-mint-50 p-3.5">
        <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-icon bg-card text-mint-700 shadow-mini">
          <Icon name="wallet" size={17} strokeWidth={2} />
        </span>
        <div className="min-w-0">
          <p className="text-[11.5px] font-bold uppercase tracking-[0.08em] text-mint-800">
            {agent.ownerWallet ? "Goes to your wallet" : "Goes to the payout wallet"}
          </p>
          <p className="mt-1 break-all font-mono text-[12.5px] font-medium text-text">{destination ?? "—"}</p>
          <p className="mt-1 text-[12px] leading-snug text-text-2">
            {agent.ownerWallet
              ? "The wallet you signed in with. Withdrawals can't go anywhere else."
              : "Fixed at creation. Withdrawals can't go anywhere else."}
          </p>
        </div>
      </div>

      <dl className="grid grid-cols-2 gap-2">
        <MiniStat label="Withdrawable now">{fmtSol(agent.withdrawableSol, 4)}</MiniStat>
        <MiniStat label={live ? "Platform fee owed" : "Fees paid"}>{fmtSol(live ? agent.feeOwedSol : agent.feesPaidSol, 4)}</MiniStat>
      </dl>

      <form onSubmit={review} className="flex flex-col gap-4" noValidate>
        <fieldset disabled={inFlight || busy} className="min-w-0">
          <legend className="mb-2 text-[11.5px] font-bold uppercase tracking-[0.08em] text-muted">Amount</legend>
          <div className="inline-flex max-w-full gap-0.5 rounded-full border border-border bg-card-2 p-[3px]">
            {(["all", "amount"] as const).map((v) => (
              <label
                key={v}
                className={cn(
                  "flex h-10 cursor-pointer items-center rounded-full px-4 text-[13px] font-bold transition-[background-color,color] duration-150 app:h-9",
                  which === v ? "bg-ink text-on-ink shadow-ink" : "text-text-2 hover:bg-card hover:text-text",
                  "has-[input:focus-visible]:outline-2 has-[input:focus-visible]:outline-offset-1 has-[input:focus-visible]:outline-focus",
                  "has-[input:disabled]:cursor-not-allowed has-[input:disabled]:opacity-60",
                )}
              >
                <input
                  type="radio"
                  name="withdraw-which"
                  value={v}
                  checked={which === v}
                  onChange={() => {
                    setWhich(v);
                    setConfirming(null);
                  }}
                  className="sr-only"
                />
                {v === "all" ? "Everything" : "Set amount"}
              </label>
            ))}
          </div>
          {which === "amount" ? (
            <div className="mt-3 max-w-64">
              <label htmlFor="withdraw-amount" className="sr-only">
                Amount in SOL
              </label>
              <div className="relative">
                <input
                  id="withdraw-amount"
                  inputMode="decimal"
                  value={amount}
                  onChange={(e) => {
                    setAmount(e.target.value);
                    setConfirming(null);
                  }}
                  placeholder={`max ${fmtSol(ceiling, 4)}`}
                  className={cn(inputClass, "pr-12 font-mono")}
                  aria-invalid={Boolean(error) || undefined}
                  aria-describedby="withdraw-error"
                />
                <span className="pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 text-[12px] font-semibold text-muted">SOL</span>
              </div>
            </div>
          ) : null}
        </fieldset>

        <label className="flex cursor-pointer items-start gap-3 rounded-card-sm border border-border bg-card p-3 has-[input:disabled]:cursor-not-allowed has-[input:focus-visible]:outline-2 has-[input:focus-visible]:outline-offset-2 has-[input:focus-visible]:outline-focus">
          <input
            type="checkbox"
            checked={close}
            onChange={(e) => {
              setCloseFirst(e.target.checked);
              setConfirming(null);
            }}
            disabled={inFlight || busy || !closeAllowed}
            className="mt-0.5 size-[18px] shrink-0 accent-[var(--mint-700)] focus-visible:outline-none"
          />
          <span className={cn("text-[13px] font-semibold leading-snug", closeAllowed ? "text-text" : "text-muted")}>
            Close all positions first
            <span className="mt-0.5 block text-[12px] font-normal text-muted">
              {closeAllowed ? (
                <>
                  Sells {positionsCount ? `all ${positionsCount} open position${positionsCount === 1 ? "" : "s"}` : "any open positions"} into SOL before sending
                  {positionsCount
                    ? ` (about ${fmtSol(agent.withdrawAfterCloseSol, 4)} in total — an estimate, actual sale proceeds may be lower)`
                    : ""}
                  .
                </>
              ) : (
                <>Only with “Everything”. To take a set amount out of open positions, use “Close all positions” first, then withdraw.</>
              )}
            </span>
          </span>
        </label>

        {which === "all" && close ? (
          <Notice tone="amber">
            Everything + close positions winds the agent down: it stops only once every position is sold and the wallet holds
            no tokens. If a sell fails or tokens remain, the agent keeps running to copy their exits and keeps enough SOL to
            sell them; the result below says what is still open.
          </Notice>
        ) : null}
        {live ? (
          <p className="text-[12px] leading-snug text-muted">
            Platform fees owed ({fmtSol(agent.feeOwedSol, 4)}) are paid first, and a tiny amount stays behind for rent and
            the network fee.
          </p>
        ) : (
          <p className="text-[12px] font-medium text-paper-ink">Paper mode: this only moves simulated SOL.</p>
        )}

        <FieldError id="withdraw-error">{error}</FieldError>

        {confirming ? (
          <div className="flex flex-col gap-3 rounded-card-sm border border-paper-border bg-paper-bg p-3.5">
            <p className="flex items-start gap-2 text-[13px] font-semibold text-text">
              <Icon name="alert" size={16} strokeWidth={2} className="mt-px shrink-0 text-paper-ink" />
              <span>
                Withdraw <span className="font-semibold">{summary}</span>?
              </span>
            </p>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="ink" onClick={send} disabled={busy} aria-busy={busy}>
                {busy ? "Sending…" : "Confirm withdraw"}
              </Button>
              <button type="button" className={buttonClass("ghost")} onClick={() => setConfirming(null)}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <Button type="submit" variant="ink" icon="wallet" className="w-fit" disabled={inFlight || busy}>
            {inFlight ? "Withdrawal running…" : "Withdraw"}
          </Button>
        )}
      </form>

      {cmd.command ? (
        <CommandStatusView command={cmd.command} pollError={cmd.pollError} workerOnline={workerOnline} title="Withdrawal" />
      ) : null}
    </div>
  );
}
