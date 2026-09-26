// Platform performance fee and the withdraw / fee-sweep arithmetic shared by the web (limits it shows and
// checks) and the worker (what it executes). Pure functions only: no config, no DB, no network.
//
// The fee: for every FILLED copy sell (copied sells, close-all and withdraw liquidation sells) whose realized
// profit (proceeds − cost basis of the part sold) is > 0, the platform takes `bps / 10000` of that profit.
// Losing or break-even sells, buys, deposits and withdrawals pay nothing.
//   paper: the fee is deducted from paperSol at the sell and added to Agent.feesPaidSol.
//   live:  the fee is added to Agent.feeOwedSol; the worker sweeps it to PLATFORM_FEE_WALLET later
//          (planFeeSweep), always before a withdrawal. Owed fees are never spendable or withdrawable.

export const LAMPORTS_PER_SOL_NUM = 1_000_000_000;

/**
 * Live withdrawals leave this much SOL in the agent wallet for rent + the transfer fee. The web's ceiling and
 * the worker's check must use this same number.
 */
export const LIVE_WITHDRAW_BUFFER_SOL = 0.002;

/** Rent of the transient WSOL account a Jupiter sell creates (and closes) before its proceeds arrive. */
const WSOL_ACCOUNT_RENT_LAMPORTS = 2_039_280;
const SELL_BASE_FEE_SLACK_LAMPORTS = 10_000;
/** Never keep less than this in a live wallet that still holds tokens. */
const MIN_SELL_RESERVE_SOL = 0.005;

/**
 * SOL a live agent wallet must keep while it holds tokens so every sell can still pay for itself (finding F7):
 * the transient WSOL account's rent + base fees + the priority-fee cap, rounded UP to 0.0001 SOL, at least
 * 0.005 SOL. Buys keep it as a floor under minReserveSol; withdrawals leave it while positions are open. The web's
 * withdraw ceiling and the worker's check both use this.
 */
export function liveSellReserveSol(maxPriorityFeeLamports: number): number {
  const lamports = WSOL_ACCOUNT_RENT_LAMPORTS + SELL_BASE_FEE_SLACK_LAMPORTS + Math.max(0, Math.floor(maxPriorityFeeLamports) || 0);
  return Math.max(MIN_SELL_RESERVE_SOL, Math.ceil(lamports / 1e5) / 1e4);
}

/** Most a fee may be in basis points (config also caps PLATFORM_FEE_BPS at 2000). */
const MAX_BPS = 10_000;

/** Round a SOL amount DOWN to whole lamports (never over-charge / over-send because of float noise). */
export function floorLamportsSol(sol: number): number {
  if (!Number.isFinite(sol) || sol <= 0) return 0;
  // The small epsilon keeps values like 0.3 (0.29999999999999999 × 1e9) from losing a lamport.
  return Math.floor(sol * LAMPORTS_PER_SOL_NUM + 1e-6) / LAMPORTS_PER_SOL_NUM;
}

/**
 * Platform fee on one filled sell, in SOL (≥ 0, whole lamports, rounded down).
 *   profit = proceedsSol − costPartSol; fee = profit × bps / 10000 when profit > 0, else 0.
 * Non-finite or negative inputs are treated conservatively: never a fee larger than the profit or the proceeds.
 */
export function computeSellFee(p: { proceedsSol: number; costPartSol: number; bps: number }): number {
  const proceeds = Number.isFinite(p.proceedsSol) ? Math.max(0, p.proceedsSol) : 0;
  const cost = Number.isFinite(p.costPartSol) ? Math.max(0, p.costPartSol) : Number.POSITIVE_INFINITY;
  const bps = Number.isFinite(p.bps) ? Math.min(Math.max(Math.floor(p.bps), 0), MAX_BPS) : 0;
  const profit = proceeds - cost;
  if (!(profit > 0) || bps === 0) return 0;
  return Math.min(floorLamportsSol((profit * bps) / MAX_BPS), floorLamportsSol(proceeds));
}

/**
 * What a live withdrawal leaves in the wallet besides fees owed: the sell reserve while it still holds tokens
 * (their exits must pay for themselves), else LIVE_WITHDRAW_BUFFER_SOL (rent + the transfer fee).
 */
export function liveWithdrawReserveSol(p: { holdsTokens: boolean; maxPriorityFeeLamports: number }): number {
  return p.holdsTokens ? Math.max(liveSellReserveSol(p.maxPriorityFeeLamports), LIVE_WITHDRAW_BUFFER_SOL) : LIVE_WITHDRAW_BUFFER_SOL;
}

/**
 * SOL a withdrawal can send right now.
 *   paper: the whole virtual balance (fees were already deducted at each sell).
 *   live:  balance − fees owed − reserve, never negative. reserve = liveWithdrawReserveSol: the sell reserve while
 *          the agent holds tokens (pass holdsTokens + maxPriorityFeeLamports), else LIVE_WITHDRAW_BUFFER_SOL.
 *          Same ceiling as the worker's planLiveWithdraw.
 */
export function withdrawableSol(p: {
  mode: "paper" | "live";
  balanceSol: number;
  feeOwedSol: number;
  holdsTokens?: boolean;
  maxPriorityFeeLamports?: number;
}): number {
  const balance = Number.isFinite(p.balanceSol) ? p.balanceSol : 0;
  if (p.mode === "paper") return floorLamportsSol(balance);
  const owed = Number.isFinite(p.feeOwedSol) ? Math.max(0, p.feeOwedSol) : 0;
  const reserve = liveWithdrawReserveSol({ holdsTokens: p.holdsTokens === true, maxPriorityFeeLamports: p.maxPriorityFeeLamports ?? 0 });
  return floorLamportsSol(balance - owed - reserve);
}

export type FeeSweepPlan =
  | { amountSol: number; skip: null }
  | { amountSol: 0; skip: "nothing_owed" | "below_minimum" | "insufficient_balance" };

/**
 * How much of the owed live fee to transfer to PLATFORM_FEE_WALLET now.
 *  - Nothing owed → skip.
 *  - Below `minSweepSol` → skip, unless `force` (the worker forces a sweep before every withdrawal).
 *  - Always leaves `reserveSol` (default LIVE_WITHDRAW_BUFFER_SOL: rent + fees) in the wallet; when the balance
 *    can't cover everything owed, sweeps what it can (the rest stays owed).
 */
export function planFeeSweep(p: {
  balanceSol: number;
  feeOwedSol: number;
  minSweepSol: number;
  force?: boolean;
  reserveSol?: number;
}): FeeSweepPlan {
  const owed = floorLamportsSol(p.feeOwedSol);
  if (owed <= 0) return { amountSol: 0, skip: "nothing_owed" };
  if (!p.force && owed < p.minSweepSol) return { amountSol: 0, skip: "below_minimum" };
  const reserve = Math.max(0, p.reserveSol ?? LIVE_WITHDRAW_BUFFER_SOL);
  const available = floorLamportsSol((Number.isFinite(p.balanceSol) ? p.balanceSol : 0) - reserve);
  const amount = Math.min(owed, available);
  if (amount <= 0) return { amountSol: 0, skip: "insufficient_balance" };
  return { amountSol: amount, skip: null };
}

/** "5%" for 500 bps, "2.5%" for 250. For UI copy ("5% of profit on each winning trade"). */
export function formatFeePct(bps: number): string {
  return `${Number((bps / 100).toFixed(2))}%`;
}
