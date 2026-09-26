"use client";

// Owner routes authenticate with the wallet session cookie. A 401 means the session ended (expired, or signed
// out in another tab): the caller refreshes the session so the dashboard falls back to the sign-in gate.

import { useWallet } from "@solana/wallet-adapter-react";
import bs58 from "bs58";
import { useCallback, useEffect, useState } from "react";
import type { CommandDTO, CommandStatus, CommandType } from "@/lib/types";
import { useSession } from "@/components/wallet/session";
import { isUserRejection } from "@/components/wallet/walletErrors";
import { api, ApiRequestError, errorMessage, type RequestOptions } from "../api";
import { describeResult } from "./commandResult";

export type OwnerApi = <T>(path: string, opts?: RequestOptions) => Promise<T>;

export function makeOwnerApi(onUnauthorized: () => void): OwnerApi {
  return async function ownerApi<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    try {
      return await api<T>(path, opts);
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 401) onUnauthorized();
      throw err;
    }
  };
}

export function agentPath(agentId: string, rest = ""): string {
  return `/api/agents/${encodeURIComponent(agentId)}${rest}`;
}

export function isOpen(status: CommandStatus): boolean {
  return status === "pending" || status === "running";
}

/**
 * Still in flight from the owner's point of view: queued / running, or a live transfer that was sent and is still
 * confirming (failed + { pending: true } until the worker settles it from the chain). Keep polling; never retry.
 */
export function isInFlight(c: CommandDTO): boolean {
  return isOpen(c.status) || (c.status === "failed" && describeResult(c.result).pendingOnChain);
}

function isCommand(v: unknown): v is CommandDTO {
  return typeof v === "object" && v !== null && typeof (v as CommandDTO).id === "string" && typeof (v as CommandDTO).status === "string";
}

/** The open command a 409 names ("a withdrawal is already in progress"), so the UI can attach to it. */
export function conflictCommand(err: unknown): CommandDTO | null {
  if (!(err instanceof ApiRequestError) || err.status !== 409) return null;
  const cmd = (err.body as { command?: unknown } | null)?.command;
  return isCommand(cmd) ? cmd : null;
}

/** A finished command stays on screen after a reload for this long (how the last withdrawal ended). */
const SHOW_FINISHED_MS = 60 * 60_000;

/**
 * Track a withdraw / close_all command until the worker marks it done or failed. On mount it picks up the
 * newest command of that type (GET /commands), so a reloaded dashboard keeps following one in flight.
 */
export function useCommand(agentId: string, ownerApi: OwnerApi, type: CommandType) {
  const [command, setCommand] = useState<CommandDTO | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const openId = command && isInFlight(command) ? command.id : null;

  useEffect(() => {
    let alive = true;
    ownerApi<{ commands: CommandDTO[] }>(agentPath(agentId, `/commands?type=${type}&limit=1`)).then(
      ({ commands }) => {
        const c = commands[0];
        if (!alive || !c) return;
        const recent = isInFlight(c) || Date.now() - Date.parse(c.doneAt ?? c.createdAt) < SHOW_FINISHED_MS;
        if (recent) setCommand((prev) => prev ?? c);
      },
      () => undefined, // older servers / transient errors: nothing to resume
    );
    return () => {
      alive = false;
    };
  }, [agentId, ownerApi, type]);

  useEffect(() => {
    if (!openId) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (!alive) return;
      if (document.hidden) {
        timer = setTimeout(tick, 2000);
        return;
      }
      try {
        const { command: next } = await ownerApi<{ command: CommandDTO }>(
          agentPath(agentId, `/commands/${encodeURIComponent(openId)}`),
        );
        if (!alive) return;
        setPollError(null);
        setCommand(next);
        if (isOpen(next.status)) timer = setTimeout(tick, 2000);
        else if (isInFlight(next)) timer = setTimeout(tick, 5000); // confirming on-chain: slower
      } catch (err) {
        if (!alive) return;
        setPollError(errorMessage(err));
        timer = setTimeout(tick, 5000);
      }
    };
    timer = setTimeout(tick, 1200);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [agentId, openId, ownerApi]);

  return { command, setCommand, pollError };
}

/** 428 body of a risk-raising rule change on a live agent (see src/app/api/_lib/stepup.ts). */
export interface StepUpChallenge {
  message: string;
  nonce: string;
  expiresAt: string;
}

export function stepUpChallenge(err: unknown): StepUpChallenge | null {
  if (!(err instanceof ApiRequestError) || err.status !== 428) return null;
  const s = (err.body as { stepUp?: unknown } | null)?.stepUp;
  if (typeof s !== "object" || s === null) return null;
  const c = s as Partial<StepUpChallenge>;
  return typeof c.message === "string" && typeof c.nonce === "string" ? { message: c.message, nonce: c.nonce, expiresAt: String(c.expiresAt ?? "") } : null;
}

export class StepUpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StepUpError";
  }
}

/**
 * Sign a step-up challenge with the owner's wallet (signMessage: no transaction, no cost). Throws StepUpError
 * with a readable reason when the owner wallet isn't connected or the user declines.
 */
export function useStepUpSigner(owner: string | null | undefined) {
  const { signMessage } = useWallet();
  const session = useSession();
  return useCallback(
    async (challenge: StepUpChallenge): Promise<{ nonce: string; signature: string }> => {
      if (!owner) throw new StepUpError("This agent has no owner wallet to confirm with.");
      if (session.connected !== owner) {
        if (!session.connected) session.connectWallet();
        throw new StepUpError(
          session.connected
            ? `Switch your wallet to the owner (${owner.slice(0, 4)}…${owner.slice(-4)}) to confirm this change, then save again.`
            : "Connect the owner wallet to confirm this change, then save again.",
        );
      }
      if (!signMessage) throw new StepUpError("This wallet can't sign messages, so it can't confirm the change.");
      try {
        const sig = await signMessage(new TextEncoder().encode(challenge.message));
        return { nonce: challenge.nonce, signature: bs58.encode(sig) };
      } catch (err) {
        throw new StepUpError(isUserRejection(err) ? "You declined the confirmation. Nothing changed." : errorMessage(err));
      }
    },
    [owner, session, signMessage],
  );
}
