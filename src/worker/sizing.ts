// Pure trade sizing and sleeve (position) math. No I/O — see sizing.test.ts.

/** Smallest copy buy we will send (SOL). */
export const MIN_TRADE_SOL = 0.001;
/** A trader selling at least this fraction of their bag is treated as a full exit. */
export const FULL_EXIT_FRACTION = 0.98;

const LAMPORTS_PER_SOL = 1_000_000_000;
/**
 * SOL a live agent wallet keeps while it holds tokens (finding F7). Lives in lib/fees so the web's withdraw
 * ceiling and the worker use the same number; re-exported here for the engine.
 */
export { liveSellReserveSol } from "@/lib/fees";
/** Fixed-point scale for fraction × bigint math. */
const FRACTION_SCALE = BigInt(1_000_000_000);
const ZERO = BigInt(0);

export interface SizingSettings {
  sizingMode: string;
  fixedSol: number;
  maxPerTradeSol: number;
  minReserveSol: number;
}

export interface BuySignal {
  solAmount: number;
  buyFraction: number | null;
}

/** `sol` is rounded down to whole lamports. On skip, `intendedSol` is the size we would have wanted (for the log). */
export type BuySize = { sol: number } | { skip: string; intendedSol: number };

function floorLamports(sol: number): number {
  return Math.floor(sol * LAMPORTS_PER_SOL) / LAMPORTS_PER_SOL;
}

function positiveOrZero(n: number): number {
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * USD → SOL at `solUsd` (USD per SOL), keeping the sign. FOMO trades are USDC-quoted, so a 1:1 mirror copies
 * the same USD value converted at the current SOL price. null when the price is missing or not a positive
 * finite number (or `usd` is not finite): callers skip rather than guess a size.
 */
export function usdToSol(usd: number, solUsd: number | null | undefined): number | null {
  if (typeof solUsd !== "number" || !Number.isFinite(solUsd) || solUsd <= 0 || !Number.isFinite(usd)) return null;
  return usd / solUsd;
}

/**
 * Buy size for one copy: mirror → trader's SOL (for USDC-quoted FOMO buys: the USD spent converted at the
 * SOL price when detected, see usdToSol), fixed → fixedSol, proportional → buyFraction × balance;
 * then capped by maxPerTradeSol, the global hard max and the spendable balance (balance − reserve).
 */
export function sizeBuy(agent: SizingSettings, event: BuySignal, balanceSol: number, hardMaxSol: number): BuySize {
  const balance = positiveOrZero(balanceSol);
  let base: number;
  switch (agent.sizingMode) {
    case "mirror":
      base = event.solAmount;
      break;
    case "fixed":
      base = agent.fixedSol;
      break;
    case "proportional":
      if (event.buyFraction === null || !(event.buyFraction > 0)) return { skip: "no buy fraction for proportional sizing", intendedSol: 0 };
      base = Math.min(event.buyFraction, 1) * balance;
      break;
    default:
      return { skip: `unknown sizing mode "${agent.sizingMode}"`, intendedSol: 0 };
  }
  if (!Number.isFinite(base) || base <= 0) return { skip: "invalid trade size", intendedSol: 0 };

  const capped = Math.min(base, positiveOrZero(agent.maxPerTradeSol), positiveOrZero(hardMaxSol));
  if (capped < MIN_TRADE_SOL) {
    // proportional on an empty wallet is really a balance problem, not a tiny trade
    const reason = agent.sizingMode === "proportional" && balance < MIN_TRADE_SOL ? "insufficient balance" : "below 0.001 SOL minimum";
    return { skip: reason, intendedSol: floorLamports(capped) };
  }

  const spendable = balance - positiveOrZero(agent.minReserveSol);
  const size = floorLamports(Math.min(capped, spendable));
  if (!(size >= MIN_TRADE_SOL)) return { skip: "insufficient balance", intendedSol: floorLamports(capped) };
  return { sol: size };
}

/** Raw token amount to sell from a sleeve: floor(sleeve × fraction); ≥ 0.98 sells the whole sleeve. */
export function sizeSell(sleeveRaw: bigint, sellFraction: number): bigint {
  if (sleeveRaw <= ZERO || !Number.isFinite(sellFraction) || sellFraction <= 0) return ZERO;
  if (sellFraction >= FULL_EXIT_FRACTION) return sleeveRaw;
  const scaled = BigInt(Math.floor(sellFraction * Number(FRACTION_SCALE)));
  const amount = (sleeveRaw * scaled) / FRACTION_SCALE;
  return amount > sleeveRaw ? sleeveRaw : amount;
}

export interface SleeveState {
  rawAmount: bigint;
  costSol: number;
  realizedSol: number;
}

/** Add a fill to a sleeve (or open one). */
export function applyBuy(pos: SleeveState | null, rawIn: bigint, solSpent: number): SleeveState {
  const cur = pos ?? { rawAmount: ZERO, costSol: 0, realizedSol: 0 };
  return {
    rawAmount: cur.rawAmount + (rawIn > ZERO ? rawIn : ZERO),
    costSol: cur.costSol + positiveOrZero(solSpent),
    realizedSol: cur.realizedSol,
  };
}

/**
 * Remove sold tokens from a sleeve. Cost basis shrinks proportionally to the share sold; realized PnL
 * gains proceeds − that cost share. Selling more than the sleeve holds is clamped to the sleeve.
 */
export function applySell(pos: SleeveState, rawSold: bigint, solReceived: number): SleeveState & { costPart: number } {
  const sold = rawSold <= ZERO ? ZERO : rawSold > pos.rawAmount ? pos.rawAmount : rawSold;
  let costPart: number;
  if (sold === pos.rawAmount) costPart = pos.costSol; // exact: no float residue on full exits
  else if (pos.rawAmount === ZERO) costPart = 0;
  else costPart = Number((sold * FRACTION_SCALE) / pos.rawAmount) / Number(FRACTION_SCALE) * pos.costSol;

  const rawAmount = pos.rawAmount - sold;
  return {
    rawAmount,
    costSol: rawAmount === ZERO ? 0 : Math.max(0, pos.costSol - costPart),
    realizedSol: pos.realizedSol + positiveOrZero(solReceived) - costPart,
    costPart,
  };
}
