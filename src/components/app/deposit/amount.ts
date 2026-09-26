// Deposit / withdraw amount rules shown in the UI. The server enforces the real limits (src/lib/deposit.ts); these
// mirror them so the user hears about a bad amount before a wallet popup. Pure: unit-tested.

import type { Mode } from "@/lib/types";
import { fmtSol } from "@/lib/format";

export const DEPOSIT_PRESETS = [0.5, 1, 2, 5] as const;
/** Smallest top-up worth a transaction (deposit.ts MIN_TOPUP_SOL). */
export const MIN_TOPUP_SOL = 0.001;
/** Most SOL per live deposit transaction (deposit.ts MAX_DEPOSIT_SOL). */
export const MAX_LIVE_DEPOSIT_SOL = 1_000;
/** Most simulated SOL per paper deposit. */
export const MAX_PAPER_DEPOSIT_SOL = 100;
/** Left in the owner's wallet for the transfer's network fee. */
export const WALLET_FEE_HEADROOM_SOL = 0.001;

export function parseSol(raw: string): number | null {
  const t = raw.trim().replace(",", ".");
  if (!/^\d*\.?\d+$|^\d+\.$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

export function checkDepositAmount(p: {
  raw: string;
  mode: Mode;
  /** The first deposit must reach the activation minimum; top-ups only MIN_TOPUP_SOL. */
  minSol: number;
  /** The owner's wallet balance (live), null while unknown. */
  walletSol: number | null;
}): { amount: number | null; error: string | null } {
  const n = parseSol(p.raw);
  if (n === null || n <= 0) return { amount: null, error: "Enter an amount in SOL." };
  const decimals = p.raw.trim().replace(",", ".").split(".")[1]?.length ?? 0;
  if (decimals > 9) return { amount: null, error: "SOL has at most 9 decimals." };
  if (n < p.minSol) return { amount: null, error: `At least ${fmtSol(p.minSol, 4)}.` };
  const max = p.mode === "live" ? MAX_LIVE_DEPOSIT_SOL : MAX_PAPER_DEPOSIT_SOL;
  if (n > max) return { amount: null, error: `At most ${max.toLocaleString("en-US")} SOL per deposit.` };
  if (p.mode === "live" && p.walletSol !== null && n > p.walletSol - WALLET_FEE_HEADROOM_SOL) {
    return {
      amount: null,
      error: `Your wallet holds ${fmtSol(p.walletSol, 4)}. Keep a little for the network fee.`,
    };
  }
  return { amount: n, error: null };
}

/** Smallest withdrawal the API accepts (api/_lib/schemas.ts MIN_WITHDRAW_SOL). */
export const MIN_WITHDRAW_SOL = 0.0001;

/** A set withdrawal amount against the server-computed ceiling (withdrawableSol / withdrawAfterCloseSol). */
export function checkWithdrawAmount(
  raw: string,
  ceilingSol: number,
  closeFirst: boolean,
): { amount: number | null; error: string | null } {
  const n = parseSol(raw);
  if (n === null || n <= 0) return { amount: null, error: "Enter a SOL amount above 0." };
  if (n < MIN_WITHDRAW_SOL) return { amount: null, error: `At least ${MIN_WITHDRAW_SOL} SOL.` };
  if (n > ceilingSol) {
    return {
      amount: null,
      error: `That's more than can be withdrawn (max ${fmtSol(ceilingSol, 4)}${closeFirst ? " after selling positions, estimated" : ""}).`,
    };
  }
  return { amount: n, error: null };
}
