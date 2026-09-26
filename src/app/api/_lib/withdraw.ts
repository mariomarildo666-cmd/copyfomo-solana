// What a withdraw request may queue, given what the agent holds now. Pure: the route supplies the numbers
// (lib/agents.withdrawLimits) and the worker re-checks the real balance before it sends anything.

import { HttpError } from "@/lib/http";
import type { WithdrawPayload } from "./commands";

/** One lamport of slack for float noise in stored balances. */
const EPSILON_SOL = 1e-9;

export interface WithdrawState {
  /** balance − platform fees owed − the live rent/fee buffer (lib/fees.withdrawableSol). */
  withdrawableSol: number;
  /** SOL a live withdrawal leaves behind (0 for paper), for the error message. */
  reserveSol: number;
  /** Platform fees owed (live), never withdrawable. */
  feeOwedSol: number;
  /** The agent holds open positions (close-first would sell them). */
  hasPositions: boolean;
}

export interface WithdrawRequest {
  amountSol?: number;
  all?: boolean;
  closePositions?: boolean;
}

function amountError(msg: string): HttpError {
  return new HttpError(400, msg, { amountSol: msg });
}

/**
 * Validate a withdraw request and build the command payload.
 *  - "Everything" (all): allowed when something is withdrawable now, or positions will be sold first.
 *  - A set amount: at most withdrawableSol (fees owed and the live buffer excluded).
 *  - "Close all positions first" + a set amount is refused while the agent holds positions (finding F37): the
 *    sale's proceeds are only an estimate, so the worker could sell everything and then fail the amount. Close
 *    positions with "withdraw everything", or close them first (close-all) and then withdraw an amount.
 */
export function planWithdraw(state: WithdrawState, req: WithdrawRequest): WithdrawPayload {
  const sellsFirst = req.closePositions === true && state.hasPositions;
  const withdrawable = Math.max(0, state.withdrawableSol);

  if (req.all === true) {
    if (withdrawable <= EPSILON_SOL && !sellsFirst) {
      const owed = state.feeOwedSol > EPSILON_SOL ? ` (${round6(state.feeOwedSol)} SOL of platform fees owed stays behind)` : "";
      throw new HttpError(400, `nothing to withdraw right now${owed}`);
    }
    // Keep the flag as asked: "everything + close positions" also stops the agent for good (worker rule).
    return { all: true, closePositions: req.closePositions === true };
  }

  if (req.amountSol === undefined) {
    // Unreachable after withdrawSchema, kept so a schema change can't turn into an unvalidated send.
    throw amountError("enter an amount, or withdraw everything");
  }
  if (sellsFirst) {
    const msg = "selling positions first only works with “withdraw everything” — or close all positions, then withdraw an amount";
    throw new HttpError(400, msg, { closePositions: msg });
  }

  const sol = Math.round(req.amountSol * 1e9) / 1e9; // whole lamports
  if (!(sol > 0)) throw amountError("enter an amount above 0");
  if (sol > withdrawable + EPSILON_SOL) {
    const max = Math.floor(withdrawable * 1e6) / 1e6;
    const parts: string[] = [];
    if (state.reserveSol > 0) parts.push(`${state.reserveSol} SOL stays for rent + the network fee`);
    if (state.feeOwedSol > EPSILON_SOL) parts.push(`${round6(state.feeOwedSol)} SOL of platform fees owed`);
    const why = parts.length ? ` (${parts.join("; ")})` : "";
    throw amountError(`at most ${max} SOL can be withdrawn right now${why}`);
  }
  // No positions to sell: close-first is a no-op, so the amount is withdrawn as is.
  return { amountSol: sol, closePositions: false };
}

function round6(n: number): number {
  return Math.ceil(n * 1e6) / 1e6;
}
