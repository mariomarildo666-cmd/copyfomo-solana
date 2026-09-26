"use client";

// One-click funding of a LIVE agent from the owner's wallet:
//   deposit-tx (server builds the unsigned transfer, fee payer = owner) → checkDepositTx (we prove it's
//   exactly that transfer) → wallet.signTransaction → deposit-submit (server validates again, relays, confirms).
// The browser never talks to an RPC node. Paper agents never come here (their deposits are simulated).

import { VersionedTransaction } from "@solana/web3.js";
import { useWallet } from "@solana/wallet-adapter-react";
import bs58 from "bs58";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentDTO, DepositSubmitResultDTO, DepositTxDTO } from "@/lib/types";
import { api, ApiRequestError, errorMessage } from "../api";
import { useSession } from "@/components/wallet/session";
import { isUserRejection, walletErrorMessage } from "@/components/wallet/walletErrors";
import { base64ToBytes, bytesToBase64, checkDepositTx, DepositTxMismatch, sameBytes, solToLamports } from "./depositTx";

export type DepositPhase =
  | { step: "idle" }
  /** The owner wallet isn't connected in this browser yet: connect, then the flow resumes. */
  | { step: "needs_wallet"; amountSol: number }
  /** The extension is on another account than the owner wallet. */
  | { step: "wrong_wallet"; connected: string; owner: string; amountSol: number }
  | { step: "preparing"; amountSol: number }
  | { step: "signing"; amountSol: number }
  | { step: "sending"; amountSol: number; signature: string }
  | { step: "done"; amountSol: number; result: DepositSubmitResultDTO }
  | {
      step: "error";
      amountSol: number;
      /** rejected: the user said no. failed: nothing moved. unknown: it may have been sent (check before retrying). */
      kind: "rejected" | "failed" | "unknown";
      message: string;
      signature?: string;
    };

export function isBusy(p: DepositPhase): boolean {
  return p.step === "preparing" || p.step === "signing" || p.step === "sending";
}

export function useDepositFlow(agent: Pick<AgentDTO, "id" | "depositAddress" | "ownerWallet">, onAgent?: (a: AgentDTO) => void) {
  const { signTransaction } = useWallet();
  const session = useSession();
  const [phase, setPhase] = useState<DepositPhase>({ step: "idle" });
  const running = useRef(false);
  const owner = agent.ownerWallet ?? session.wallet;

  const start = useCallback(
    async (amountSol: number, prepared?: DepositTxDTO | null) => {
      if (running.current) return;
      if (!owner) {
        setPhase({ step: "error", amountSol, kind: "failed", message: "Sign in with the wallet that owns this agent first." });
        return;
      }
      if (!session.connected) {
        setPhase({ step: "needs_wallet", amountSol });
        return;
      }
      if (session.connected !== owner) {
        setPhase({ step: "wrong_wallet", connected: session.connected, owner, amountSol });
        return;
      }
      if (!signTransaction) {
        setPhase({ step: "error", amountSol, kind: "failed", message: "This wallet can't sign transactions. Send SOL to the deposit address instead." });
        return;
      }

      running.current = true;
      let signature: string | undefined;
      try {
        setPhase({ step: "preparing", amountSol });
        const dto =
          prepared ??
          (await api<DepositTxDTO>(`/api/agents/${encodeURIComponent(agent.id)}/deposit-tx`, {
            method: "POST",
            body: { amountSol },
          }));
        const lamports = solToLamports(dto.amountSol);
        if (lamports !== solToLamports(amountSol)) throw new DepositTxMismatch("the amount differs from what you asked for");
        const expected = { from: owner, to: agent.depositAddress, lamports };
        const unsigned = VersionedTransaction.deserialize(base64ToBytes(dto.txBase64));
        checkDepositTx(unsigned, expected);
        const unsignedMessage = unsigned.message.serialize();

        setPhase({ step: "signing", amountSol });
        const signed = await signTransaction(unsigned);
        // Some wallets add a compute budget before signing; anything else can't be relayed, so stop here.
        if (!sameBytes(signed.message.serialize(), unsignedMessage)) {
          try {
            checkDepositTx(signed, expected);
          } catch {
            throw new DepositTxMismatch(
              "your wallet added its own instructions, which we can't relay — send SOL to the deposit address instead",
            );
          }
        }
        const sig = signed.signatures[0];
        if (!sig || sig.every((b) => b === 0)) throw new Error("the wallet returned the transfer unsigned");
        signature = bs58.encode(sig);

        setPhase({ step: "sending", amountSol, signature });
        const result = await api<DepositSubmitResultDTO>(`/api/agents/${encodeURIComponent(agent.id)}/deposit-submit`, {
          method: "POST",
          body: { txBase64: bytesToBase64(signed.serialize()), amountSol: dto.amountSol },
        });
        setPhase({ step: "done", amountSol, result });
        onAgent?.(result.agent);
      } catch (err) {
        if (err instanceof DepositTxMismatch) {
          setPhase({ step: "error", amountSol, kind: "failed", message: err.message });
        } else if (!signature) {
          // Before a signature exists nothing can have moved.
          const rejected = !(err instanceof ApiRequestError) && isUserRejection(err);
          setPhase({
            step: "error",
            amountSol,
            kind: rejected ? "rejected" : "failed",
            message: err instanceof ApiRequestError ? errorMessage(err) : walletErrorMessage(err, "transaction"),
          });
        } else if (err instanceof ApiRequestError && err.status >= 400 && err.status < 500 && err.status !== 409) {
          // The server refused it or the network rejected it: nothing was transferred.
          setPhase({ step: "error", amountSol, kind: "failed", message: errorMessage(err), signature });
        } else {
          // Network drop, 5xx or "already submitted": the transfer may be on its way. Never blind-retry.
          setPhase({
            step: "error",
            amountSol,
            kind: "unknown",
            signature,
            message: `We couldn't confirm the transfer (${errorMessage(err)}). It may still land: check it on Solscan or wait for the balance to update before you try again.`,
          });
        }
      } finally {
        running.current = false;
      }
    },
    [agent.id, agent.depositAddress, owner, session.connected, signTransaction, onAgent],
  );

  // While waiting for the owner wallet, reflect what is connected right now (none, or another account).
  let effective: DepositPhase = phase;
  if (phase.step === "needs_wallet" || phase.step === "wrong_wallet") {
    if (session.connected && owner && session.connected !== owner) {
      effective = { step: "wrong_wallet", connected: session.connected, owner, amountSol: phase.amountSol };
    } else if (!session.connected) {
      effective = { step: "needs_wallet", amountSol: phase.amountSol };
    }
  }

  // Resume once the owner wallet is connected (after "Connect wallet", or after switching accounts).
  const pendingAmount = phase.step === "needs_wallet" || phase.step === "wrong_wallet" ? phase.amountSol : null;
  useEffect(() => {
    if (pendingAmount === null || !session.connected || session.connected !== owner) return;
    // The wallet just connected (an external event): continue on the next tick, outside this render pass.
    const t = setTimeout(() => void start(pendingAmount), 0);
    return () => clearTimeout(t);
  }, [pendingAmount, session.connected, owner, start]);

  const reset = useCallback(() => setPhase({ step: "idle" }), []);
  return { phase: effective, start, reset, owner };
}
