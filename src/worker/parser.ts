// Pure swap detection: one confirmed transaction + the watched wallet → a buy/sell of exactly one token,
// or a skip reason. No I/O, so every rule is unit-testable (parser.test.ts).
//
// Input is a normalized MiniTx (src/lib/fomo-chain.ts normalizeTx) plus the network fee, so the same parser
// runs on web3.js getParsedTransaction results, Helius transactionSubscribe payloads and getTransaction JSON.
//
// Rules (ARCHITECTURE.md "Engine rules" #3):
//  - failed txs are skipped; the wallet must have signed;
//  - SOL delta = wallet lamport delta + wallet-owned WSOL delta (+ fee when the wallet paid it);
//  - token deltas per mint from pre/postTokenBalances owned by the wallet, excluding SOL/USDC/USDT;
//    a second token that moved ≤ DUST_RATIO × the primary amount is leftover dust (same tolerance as rule R);
//  - the quote leg is SOL, or USDC/USDT converted to SOL with the current SOL/USD price (usdToSol);
//  - BUY  = exactly one token up and the quote down; SELL = exactly one token down and the quote up;
//  - anything else (transfers, LP, token→token, SOL⇄USDC conversions, Relay deposits) is not a copyable trade.

import { DUST_RATIO, normalizeTx, type MiniTokenBalance, type MiniTx } from "@/lib/fomo-chain";
import { SOL_MINT, USDC_MINT, USDT_MINT } from "@/lib/solana";
import type { Side } from "@/lib/types";
import { usdToSol } from "./sizing";

const LAMPORTS_PER_SOL = 1_000_000_000;
/** Quote legs smaller than this are fee/rent noise, not trades. */
export const DUST_SOL = 0.0001;
/** Stablecoin legs below one cent are ignored. */
const STABLE_DUST_USD = 0.01;
/**
 * A tx that moves both SOL and stablecoins by more than MIXED_QUOTE_SOL (in SOL) is ambiguous — unless the smaller
 * leg is under MIXED_QUOTE_RATIO of the larger one (e.g. a $10,000 USDC FOMO buy that also refunded 0.04 SOL of
 * account rent to the trader): then the larger leg is the quote.
 */
const MIXED_QUOTE_SOL = 0.01;
const MIXED_QUOTE_RATIO = 0.1;
/** Fractions are clamped to (0, 1]; this is the floor. */
const MIN_FRACTION = 1e-9;

const QUOTE_MINTS = new Set([SOL_MINT, USDC_MINT, USDT_MINT]);
const ZERO = BigInt(0);

/** A normalized transaction plus its network fee in lamports (0 when the payload did not carry it). */
export interface SwapTx extends MiniTx {
  fee: number;
}

export interface ParsedSwap {
  signature: string;
  /** Unix ms of the block, null when the payload did not carry one (transactionSubscribe). */
  blockTimeMs: number | null;
  side: Side;
  mint: string;
  decimals: number;
  /** |raw token delta| of the trader. */
  tokenRaw: bigint;
  /** SOL (or SOL-equivalent for stablecoin quotes) spent on a buy / received on a sell. */
  solAmount: number;
  /** Stablecoin-quoted swaps: |USD| moved (USDC + USDT at $1). null for SOL quotes. */
  usdAmount: number | null;
  /** Sells: tokens sold / pre-tx token balance, (0, 1]. */
  sellFraction: number | null;
  /** Buys: quote spent / pre-tx balance of the quote asset (SOL-equivalent), (0, 1]. */
  buyFraction: number | null;
  quote: "SOL" | "STABLE";
}

export type SwapAnalysis =
  | { swap: ParsedSwap }
  /** `needsSolUsd`: a stablecoin leg was found; retry with a SOL/USD price. */
  | { skip: string; needsSolUsd?: boolean };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** meta.fee from any payload shape normalizeTx accepts; 0 when absent. */
function payloadFee(x: unknown): number {
  let r: unknown = x;
  if (isObj(r) && isObj(r.params) && isObj(r.params.result)) r = r.params.result;
  if (isObj(r) && !("transaction" in r) && isObj(r.result)) r = r.result;
  if (!isObj(r) || !isObj(r.transaction)) return 0;
  const meta = isObj(r.transaction.transaction) ? r.transaction.meta : r.meta;
  const fee = isObj(meta) ? meta.fee : undefined;
  return typeof fee === "number" && Number.isFinite(fee) && fee >= 0 ? fee : 0;
}

/**
 * Normalize a transaction payload for the parser: web3.js ParsedTransactionWithMeta, getTransaction JSON,
 * a gTFA item or a transactionSubscribe notification/result. null when it is not a usable transaction.
 */
export function toSwapTx(raw: unknown): SwapTx | null {
  const mini = normalizeTx(raw);
  return mini ? { ...mini, fee: payloadFee(raw) } : null;
}

interface MintBalance {
  raw: bigint;
  decimals: number;
}

function sumOwnedByMint(balances: readonly MiniTokenBalance[], wallet: string): Map<string, MintBalance> {
  const out = new Map<string, MintBalance>();
  for (const b of balances) {
    if (b.owner !== wallet || !/^\d+$/.test(b.raw)) continue;
    const prev = out.get(b.mint);
    out.set(b.mint, { raw: (prev?.raw ?? ZERO) + BigInt(b.raw), decimals: b.decimals });
  }
  return out;
}

function clampFraction(x: number): number {
  if (!Number.isFinite(x)) return 1;
  return Math.min(1, Math.max(MIN_FRACTION, x));
}

function rawToUnits(raw: bigint, decimals: number): number {
  return Number(raw) / 10 ** decimals;
}

/** Full analysis with a human-readable reason when the tx is not a copyable swap. */
export function analyzeSwap(tx: SwapTx, wallet: string, solUsd: number | null): SwapAnalysis {
  if (tx.err !== null && tx.err !== undefined) return { skip: "failed transaction" };

  const idx = tx.keys.findIndex((k) => k.pubkey === wallet);
  if (idx < 0) return { skip: "wallet not in transaction" };
  // Only the trader's own actions are copyable: a third party cannot spend the wallet's SOL or tokens.
  if (!tx.keys[idx]!.signer) return { skip: "wallet did not sign" };

  const preLamports = tx.preLamports[idx];
  const postLamports = tx.postLamports[idx];
  if (preLamports === undefined || postLamports === undefined) return { skip: "missing lamport balances" };

  let lamportDelta = BigInt(postLamports - preLamports);
  if (idx === 0) lamportDelta += BigInt(tx.fee); // account 0 is the fee payer

  const pre = sumOwnedByMint(tx.preToken, wallet);
  const post = sumOwnedByMint(tx.postToken, wallet);
  const delta = (mint: string) => (post.get(mint)?.raw ?? ZERO) - (pre.get(mint)?.raw ?? ZERO);
  const decimalsOf = (mint: string, fallback: number) => post.get(mint)?.decimals ?? pre.get(mint)?.decimals ?? fallback;

  // ── SOL leg (native + WSOL) ─────────────────────────────────────────────────────────────
  const solDeltaSol = Number(lamportDelta + delta(SOL_MINT)) / LAMPORTS_PER_SOL;
  const preSol = (preLamports + Number(pre.get(SOL_MINT)?.raw ?? ZERO)) / LAMPORTS_PER_SOL;

  // ── Stablecoin leg (USDC + USDT, both valued at $1) ─────────────────────────────────────
  let stableDeltaUsd = 0;
  let preStableUsd = 0;
  for (const mint of [USDC_MINT, USDT_MINT]) {
    const decimals = decimalsOf(mint, 6);
    stableDeltaUsd += rawToUnits(delta(mint), decimals);
    preStableUsd += rawToUnits(pre.get(mint)?.raw ?? ZERO, decimals);
  }

  // ── Exactly one non-quote token must have moved (leftover dust of a second token tolerated) ──
  const units = (mint: string) => Math.abs(rawToUnits(delta(mint), decimalsOf(mint, 0)));
  let changed: string[] = [];
  for (const mint of new Set([...pre.keys(), ...post.keys()])) {
    if (!QUOTE_MINTS.has(mint) && delta(mint) !== ZERO) changed.push(mint);
  }
  if (changed.length === 0) return { skip: "no token balance change" };
  if (changed.length > 1) {
    changed.sort((a, b) => units(b) - units(a));
    const primary = units(changed[0]!);
    if (!changed.slice(1).every((m) => units(m) <= DUST_RATIO * primary)) {
      return { skip: `${changed.length} tokens changed (token→token / LP)` };
    }
    changed = [changed[0]!];
  }
  const mint = changed[0]!;
  const tokenDelta = delta(mint);
  const decimals = decimalsOf(mint, 0);

  // ── Pick the quote leg ──────────────────────────────────────────────────────────────────
  let quoteDeltaSol = solDeltaSol;
  let preQuoteSol = preSol;
  let quote: ParsedSwap["quote"] = "SOL";
  let usdAmount: number | null = null;
  if (Math.abs(stableDeltaUsd) >= STABLE_DUST_USD) {
    const stableDeltaSol = usdToSol(stableDeltaUsd, solUsd);
    if (stableDeltaSol === null) return { skip: "stablecoin quote needs a SOL/USD price", needsSolUsd: true };
    const small = Math.min(Math.abs(solDeltaSol), Math.abs(stableDeltaSol));
    const large = Math.max(Math.abs(solDeltaSol), Math.abs(stableDeltaSol));
    if (small >= MIXED_QUOTE_SOL && small >= MIXED_QUOTE_RATIO * large) {
      return { skip: "mixed SOL and stablecoin legs" };
    }
    if (Math.abs(stableDeltaSol) > Math.abs(solDeltaSol)) {
      quoteDeltaSol = stableDeltaSol;
      preQuoteSol = usdToSol(preStableUsd, solUsd) ?? 0;
      quote = "STABLE";
      usdAmount = Math.abs(stableDeltaUsd);
    }
  }
  if (Math.abs(quoteDeltaSol) < DUST_SOL) return { skip: "quote leg is dust" };

  const base = {
    signature: tx.signature,
    blockTimeMs: tx.blockTimeMs,
    mint,
    decimals,
    tokenRaw: tokenDelta < ZERO ? -tokenDelta : tokenDelta,
    solAmount: Math.abs(quoteDeltaSol),
    usdAmount,
    quote,
  };

  if (tokenDelta > ZERO && quoteDeltaSol < 0) {
    const buyFraction = preQuoteSol > 0 ? clampFraction(base.solAmount / preQuoteSol) : 1;
    return { swap: { ...base, side: "buy", buyFraction, sellFraction: null } };
  }
  if (tokenDelta < ZERO && quoteDeltaSol > 0) {
    const preToken = pre.get(mint)?.raw ?? ZERO;
    if (preToken <= ZERO) return { skip: "sell without a prior token balance" };
    const sellFraction = clampFraction(Number(base.tokenRaw) / Number(preToken));
    return { swap: { ...base, side: "sell", sellFraction, buyFraction: null } };
  }
  return { skip: "token and quote moved the same way (transfer, not a swap)" };
}

/** The copyable swap in `tx` for `wallet`, or null. `solUsd` is only needed for USDC/USDT-quoted swaps. */
export function parseSwap(tx: SwapTx, wallet: string, solUsd: number | null): ParsedSwap | null {
  const r = analyzeSwap(tx, wallet, solUsd);
  return "swap" in r ? r.swap : null;
}
