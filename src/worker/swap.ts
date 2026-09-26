// Swap execution primitives. Paper fills at a real Jupiter quote; live signs and sends a Jupiter swap (PumpPortal
// fallback for unroutable pump.fun mints). Every externally built transaction passes txguard.ts before the agent key
// signs it, is journaled before broadcast (the caller's onSigned hook), and is measured from its own transaction
// metadata (txmeta.ts) — never from lagging balance reads.
// Every failure surfaces as a TradeError whose `reason` is short and human-readable (stored on CopyTrade).

import { randomBytes } from "node:crypto";
import { PublicKey, type VersionedTransaction } from "@solana/web3.js";
import { config } from "@/lib/config";
import { buildSwap, getQuote, JUP_PRIORITY, type JupQuote } from "@/lib/jupiter";
import { connection, getTokenBalanceRaw, LAMPORTS_PER_SOL, SOL_MINT } from "@/lib/solana";
import { errText } from "./log";
import { buildPumpPortalTx, isPumpMint } from "./pumpportal";
import { TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from "./rent";
import { SendError, signAndSend, type SendOptions } from "./send";
import { ataAddress, checkJupiterQuote, decodeTokenAccount, GuardError, guardSwapTx, type GuardSpec, type SimulationReport } from "./txguard";
import { fetchAgentTxEffect } from "./txmeta";
import { sleep } from "./util";
import type { AgentSigner } from "./wallet";

export type Venue = "paper" | "jupiter" | "pumpportal";

export interface Fill {
  /** Buy: SOL spent (live: measured, incl. network / priority / venue fees, excl. reclaimable rent). Sell: SOL received (live: net of fees). */
  solAmount: number;
  /** Buy: tokens received. Sell: tokens sold. Raw base units. */
  tokenRaw: bigint;
  /** Known when measured on-chain; null for paper fills. */
  decimals: number | null;
  signature: string;
  venue: Venue;
}

export interface SellFill extends Fill {
  /** Live only: the wallet holds none of the token after the sell. */
  exhausted: boolean;
}

export class TradeError extends Error {
  readonly reason: string;
  readonly signature: string | null;
  /** Nothing landed and a later attempt may succeed (sells are retried, see sellretry.ts). */
  readonly retryable: boolean;
  constructor(reason: string, signature: string | null = null, retryable = false) {
    super(reason);
    this.name = "TradeError";
    this.reason = reason;
    this.signature = signature;
    this.retryable = retryable;
  }
}

/** Not a failure: the copy is deliberately not made (recorded as "skipped"). */
export class TradeSkip extends TradeError {
  constructor(reason: string) {
    super(reason);
    this.name = "TradeSkip";
  }
}

/** Repeated reads agree the live wallet holds none of the token: the sleeve is stale. */
export class NothingOnChainError extends TradeError {
  constructor() {
    super("no tokens on-chain");
    this.name = "NothingOnChainError";
  }
}

/**
 * The transaction was broadcast (it is in the in-flight journal) but is not settled or not measured yet. The row
 * stays "sending"; inflight.ts records it from the chain. Never retry or fail such a trade.
 */
export class InFlightError extends TradeError {
  constructor(reason: string, signature: string) {
    super(reason, signature);
    this.name = "InFlightError";
  }
}

const ZERO = BigInt(0);
/** PumpPortal fee on top of the order (its builds show ~0.5%, some routes 1%). */
const PUMPPORTAL_FEE_FRACTION = 0.01;
const PUMPPORTAL_PRIORITY_FEE_LAMPORTS = 500_000;
/** Allowance on top of a buy's input: base fee + a new token account's rent (Token-2022 accounts can be larger). */
const BUY_EXTRA_LAMPORTS = BigInt(4_000_000);
/** A sell may cost at most this (+ the priority fee) before proceeds: base fee + transient WSOL account rent. */
const SELL_EXTRA_LAMPORTS = BigInt(3_000_000);

/** Copy buys whose quote shows more price impact than this (fraction, Jupiter's priceImpactPct) are skipped. */
export const MAX_PRICE_IMPACT = 0.25;
/** Copy buys filling this much worse than the trader's own fill (tokens per SOL) are skipped (finding F22). */
export const MAX_WORSE_THAN_TRADER = 0.25;

function paperSignature(): string {
  return `paper_${randomBytes(12).toString("hex")}`;
}

function lamportsToSol(l: bigint | number): number {
  return Number(l) / LAMPORTS_PER_SOL;
}

function formatUnits(raw: bigint, decimals: number): string {
  if (decimals <= 0) return raw.toString();
  const s = raw.toString().padStart(decimals + 1, "0");
  const int = s.slice(0, -decimals);
  const frac = s.slice(-decimals).replace(/0+$/, "");
  return frac ? `${int}.${frac}` : int;
}

export function isNoRouteError(err: unknown): boolean {
  return /COULD_NOT_FIND_ANY_ROUTE|NO_ROUTES_FOUND|could not find any route|no routes? found|TOKEN_NOT_TRADABLE|not tradable|no liquidity|empty route plan/i.test(
    errText(err, 400),
  );
}

async function quoteOrNoRoute(p: Parameters<typeof getQuote>[0]): Promise<JupQuote | "no_route"> {
  try {
    return await getQuote(p);
  } catch (err) {
    if (isNoRouteError(err)) return "no_route";
    throw new TradeError(`quote failed: ${errText(err, 140)}`, null, true);
  }
}

// ── Price sanity (finding F22) ─────────────────────────────────────────────────────────────────────

/** What the copied trader got: `tokenRaw` for `lamports` (SOL or SOL-equivalent). */
export interface PriceRef {
  tokenRaw: bigint;
  lamports: bigint;
}

/** Why a copy buy filling `outRaw` for `inLamports` is too expensive, or null when it is acceptable. Pure. */
export function buyPriceSkipReason(outRaw: bigint, inLamports: bigint, ref: PriceRef | null, priceImpactPct: string | null = null): string | null {
  const impact = priceImpactPct === null ? Number.NaN : Number(priceImpactPct);
  if (Number.isFinite(impact) && impact > MAX_PRICE_IMPACT) return `price impact ${(impact * 100).toFixed(1)}% is too high`;
  if (ref && ref.tokenRaw > ZERO && ref.lamports > ZERO && inLamports > ZERO && outRaw > ZERO) {
    // (our tokens per lamport) / (trader's tokens per lamport)
    const ratio = (Number(outRaw) * Number(ref.lamports)) / (Number(inLamports) * Number(ref.tokenRaw));
    if (ratio < 1 - MAX_WORSE_THAN_TRADER) return `price ${Math.round((1 - ratio) * 100)}% worse than the trader's fill`;
  }
  return null;
}

// ── Paper ──────────────────────────────────────────────────────────────────────────────────────

export async function paperBuy(mint: string, lamports: bigint, slippageBps: number, ref: PriceRef | null = null): Promise<Fill> {
  const q = await quoteOrNoRoute({ inputMint: SOL_MINT, outputMint: mint, amount: lamports, slippageBps });
  if (q === "no_route") throw new TradeError(isPumpMint(mint) ? "no route (paper)" : "no route");
  const skip = buyPriceSkipReason(BigInt(q.outAmount), lamports, ref, q.priceImpactPct);
  if (skip) throw new TradeSkip(skip);
  return { solAmount: lamportsToSol(lamports), tokenRaw: BigInt(q.outAmount), decimals: null, signature: paperSignature(), venue: "paper" };
}

export async function paperSell(mint: string, raw: bigint, slippageBps: number): Promise<Fill> {
  const q = await quoteOrNoRoute({ inputMint: mint, outputMint: SOL_MINT, amount: raw, slippageBps });
  if (q === "no_route") throw new TradeError(isPumpMint(mint) ? "no route (paper)" : "no route", null, true);
  return { solAmount: lamportsToSol(BigInt(q.outAmount)), tokenRaw: raw, decimals: null, signature: paperSignature(), venue: "paper" };
}

// ── Live ───────────────────────────────────────────────────────────────────────────────────────

export interface LiveSendHooks {
  /** Journal the signed swap (row "sending" + in-flight record) BEFORE it is broadcast. */
  onSigned: NonNullable<SendOptions["onSigned"]>;
}

/** Sign + journal + send + confirm; maps every failure to a TradeError (InFlightError when the outcome is open). */
async function sendSwap(tx: VersionedTransaction, signer: AgentSigner, hooks: LiveSendHooks): Promise<string> {
  try {
    return (await signAndSend(tx, signer, { onSigned: hooks.onSigned })).signature;
  } catch (err) {
    if (!(err instanceof SendError)) throw new TradeError(`send failed: ${errText(err, 140)}`, null, true);
    if (err.outcome === "rejected") throw new TradeError(`swap rejected in simulation: ${errText(err, 140)}`, err.signature, true);
    if (err.outcome === "failed") throw new TradeError("swap failed on-chain", err.signature, true);
    if (err.outcome === "expired" || !err.signature) throw new TradeError("swap expired before landing", err.signature, true);
    throw new InFlightError("swap sent; waiting for confirmation", err.signature);
  }
}

/**
 * PumpPortal priority fee (it takes a fixed fee, no quote): scaled with the trade like Jupiter's cap (finding F23)
 * — at most priorityFeeMaxBps of the SOL size (sells: twice the share, exits must land), never below the floor,
 * never above 500k lamports or MAX_PRIORITY_FEE_LAMPORTS. Unknown size (a sell without a cost estimate): the cap.
 */
export function pumpPriorityLamports(
  sizeLamports: bigint | null,
  side: "buy" | "sell",
  opts: { maxLamports: number; bps: number; floorLamports: number } = {
    maxLamports: config.maxPriorityFeeLamports,
    bps: config.priorityFeeMaxBps,
    floorLamports: config.priorityFeeFloorLamports,
  },
): number {
  const max = Math.min(Math.max(0, Math.floor(opts.maxLamports)), PUMPPORTAL_PRIORITY_FEE_LAMPORTS);
  if (sizeLamports === null || sizeLamports <= ZERO) return max;
  const share = side === "sell" ? opts.bps * 2 : opts.bps;
  const relative = Math.floor((Number(sizeLamports) * share) / 10_000);
  return Math.min(max, Math.max(Math.floor(opts.floorLamports), relative));
}

async function guarded(tx: VersionedTransaction, spec: GuardSpec): Promise<SimulationReport> {
  try {
    return await guardSwapTx(tx, spec);
  } catch (err) {
    const why = err instanceof GuardError ? err.message : `guard unavailable: ${errText(err, 100)}`;
    throw new TradeError(`refused ${spec.venue} transaction: ${why}`.slice(0, 190), null, true);
  }
}

/**
 * PumpPortal buys fix the token amount and cap the SOL cost at size × (1 + slippage) + its fee: size the ORDER so
 * that worst case stays within `lamports` (finding F8: the caps apply to the real outflow, not the nominal size).
 */
export function pumpPortalOrderSol(lamports: bigint, slippageBps: number): number {
  const factor = 1 + slippageBps / 10_000 + PUMPPORTAL_FEE_FRACTION;
  return Math.floor(Number(lamports) / factor) / LAMPORTS_PER_SOL;
}

async function buildPump(order: Parameters<typeof buildPumpPortalTx>[0]): Promise<VersionedTransaction> {
  try {
    return await buildPumpPortalTx(order);
  } catch (err) {
    throw new TradeError(`no Jupiter route; ${errText(err, 140)}`, null, true);
  }
}

async function measure(signature: string, owner: string, mint: string) {
  const effect = await fetchAgentTxEffect(signature, owner, mint);
  if (effect === "unavailable") throw new InFlightError("swap landed; waiting for its details", signature);
  if (effect !== "unattributable" && effect.err) throw new TradeError("swap failed on-chain", signature, true);
  return effect;
}

export async function liveBuy(
  signer: AgentSigner,
  mint: string,
  lamports: bigint,
  slippageBps: number,
  opts: { ref: PriceRef | null; hooks: LiveSendHooks },
): Promise<Fill> {
  const owner = signer.address;
  const q = await quoteOrNoRoute({ inputMint: SOL_MINT, outputMint: mint, amount: lamports, slippageBps, priority: JUP_PRIORITY.entry });
  let tx: VersionedTransaction;
  let venue: Venue;
  let sim: SimulationReport;
  if (q !== "no_route") {
    const skip = buyPriceSkipReason(BigInt(q.outAmount), lamports, opts.ref, q.priceImpactPct);
    if (skip) throw new TradeSkip(skip);
    let minOut: bigint;
    let cap: number;
    try {
      minOut = checkJupiterQuote(q.raw, { slippageBps, inAmount: lamports });
      const built = await buildSwap(q, owner);
      tx = built.tx;
      cap = built.priorityFeeCapLamports;
    } catch (err) {
      throw new TradeError(`swap build failed: ${errText(err, 140)}`, null, true);
    }
    sim = await guarded(tx, {
      venue: "jupiter",
      side: "buy",
      owner,
      mint,
      amount: lamports,
      minOut,
      maxValueOut: lamports + BigInt(cap) + BUY_EXTRA_LAMPORTS,
      maxPriorityFeeLamports: cap,
    });
    venue = "jupiter";
  } else if (isPumpMint(mint)) {
    const orderSol = pumpPortalOrderSol(lamports, slippageBps);
    if (!(orderSol > 0)) throw new TradeError("buy too small for PumpPortal");
    const priority = pumpPriorityLamports(lamports, "buy");
    tx = await buildPump({
      publicKey: owner,
      action: "buy",
      mint,
      amount: orderSol,
      denominatedInSol: true,
      slippagePct: slippageBps / 100,
      priorityFeeSol: priority / LAMPORTS_PER_SOL,
    });
    sim = await guarded(tx, {
      venue: "pumpportal",
      side: "buy",
      owner,
      mint,
      amount: BigInt(Math.round(orderSol * LAMPORTS_PER_SOL)),
      minOut: BigInt(1),
      maxValueOut: lamports + BigInt(priority) + BUY_EXTRA_LAMPORTS,
      maxPriorityFeeLamports: Math.ceil(priority * 1.05) + 1_000,
    });
    // No quote on this venue: judge the simulated fill against the trader's price instead.
    const skip = buyPriceSkipReason(sim.tokenDelta, lamports, opts.ref);
    if (skip) throw new TradeSkip(skip);
    venue = "pumpportal";
  } else {
    throw new TradeError("no route", null, true);
  }

  const signature = await sendSwap(tx, signer, opts.hooks);
  const effect = await measure(signature, owner, mint);
  if (effect === "unattributable") {
    // Old RPC without token-balance owners: fall back to the simulated amounts (tokens) and the order size (SOL).
    return { solAmount: lamportsToSol(lamports), tokenRaw: sim.tokenDelta, decimals: null, signature, venue };
  }
  if (effect.tokenDelta <= ZERO) throw new TradeError("swap landed but no tokens arrived", signature);
  const spent = -effect.valueDeltaLamports;
  return { solAmount: lamportsToSol(spent > ZERO ? spent : ZERO), tokenRaw: effect.tokenDelta, decimals: effect.decimals, signature, venue };
}

/** Raw balance of `owner`'s associated token accounts for `mint` (both token programs), read directly. */
async function directAtaBalance(owner: string, mint: string): Promise<{ raw: bigint; decimals: number | null }> {
  const addrs = [ataAddress(owner, mint, TOKEN_PROGRAM), ataAddress(owner, mint, TOKEN_2022_PROGRAM)];
  const infos = await connection().getMultipleAccountsInfo(addrs.map((a) => new PublicKey(a)), "confirmed");
  let raw = ZERO;
  for (const info of infos) {
    const dec = info ? decodeTokenAccount(info.data) : null;
    if (dec && dec.mint === mint && dec.owner === owner) raw += dec.amount;
  }
  return { raw, decimals: null };
}

/**
 * Tokens the wallet holds (finding F5): a single empty read is not proof of nothing — RPC nodes lag and the
 * token-by-owner index trails account creation. Reads the owner index AND the associated accounts directly, up to
 * three times; NothingOnChainError only when at least two reads succeeded and all saw zero.
 */
export async function readHeldTokens(owner: string, mint: string, gapMs = 600): Promise<{ raw: bigint; decimals: number | null }> {
  let zeroReads = 0;
  let lastErr: unknown = null;
  for (let i = 0; i < 3; i++) {
    try {
      const [byOwner, direct] = await Promise.all([getTokenBalanceRaw(owner, mint), directAtaBalance(owner, mint)]);
      const raw = byOwner.raw > direct.raw ? byOwner.raw : direct.raw;
      if (raw > ZERO) return { raw, decimals: byOwner.decimals ?? direct.decimals };
      zeroReads++;
    } catch (err) {
      lastErr = err;
    }
    if (i < 2) await sleep(gapMs * (i + 1));
  }
  if (zeroReads >= 2) throw new NothingOnChainError();
  throw new TradeError(`token balance unavailable${lastErr ? `: ${errText(lastErr, 100)}` : ""}`, null, true);
}

export async function liveSell(
  signer: AgentSigner,
  mint: string,
  rawWanted: bigint,
  slippageBps: number,
  opts: {
    hooks: LiveSendHooks;
    /** Rough SOL value of what is sold (the sleeve's cost basis share), for PumpPortal's priority fee. */
    estSolOutLamports?: bigint | null;
  },
): Promise<SellFill> {
  const owner = signer.address;
  const held = await readHeldTokens(owner, mint);
  const amount = rawWanted > held.raw ? held.raw : rawWanted;
  if (amount <= ZERO) throw new TradeError("sell size rounds to zero");

  const q = await quoteOrNoRoute({ inputMint: mint, outputMint: SOL_MINT, amount, slippageBps, priority: JUP_PRIORITY.exit });
  let tx: VersionedTransaction;
  let venue: Venue;
  let sim: SimulationReport;
  if (q !== "no_route") {
    let cap: number;
    try {
      checkJupiterQuote(q.raw, { slippageBps, inAmount: amount });
      const built = await buildSwap(q, owner);
      tx = built.tx;
      cap = built.priorityFeeCapLamports;
    } catch (err) {
      throw new TradeError(`swap build failed: ${errText(err, 140)}`, null, true);
    }
    sim = await guarded(tx, {
      venue: "jupiter",
      side: "sell",
      owner,
      mint,
      amount,
      minOut: ZERO,
      maxValueOut: BigInt(cap) + SELL_EXTRA_LAMPORTS,
      maxPriorityFeeLamports: cap,
    });
    venue = "jupiter";
  } else if (isPumpMint(mint)) {
    if (held.decimals === null && amount !== held.raw) throw new TradeError("token decimals unknown", null, true);
    const uiAmount = amount === held.raw ? "100%" : Number(formatUnits(amount, held.decimals ?? 0));
    // No quote on this venue: size the fee on the sleeve's cost basis of what is sold (estimate), if known.
    const priority = pumpPriorityLamports(opts.estSolOutLamports ?? null, "sell");
    tx = await buildPump({
      publicKey: owner,
      action: "sell",
      mint,
      amount: uiAmount,
      denominatedInSol: false,
      slippagePct: slippageBps / 100,
      priorityFeeSol: priority / LAMPORTS_PER_SOL,
    });
    sim = await guarded(tx, {
      venue: "pumpportal",
      side: "sell",
      owner,
      mint,
      amount,
      minOut: ZERO,
      maxValueOut: BigInt(priority) + SELL_EXTRA_LAMPORTS,
      maxPriorityFeeLamports: Math.ceil(priority * 1.05) + 1_000,
    });
    venue = "pumpportal";
  } else {
    throw new TradeError("no route", null, true);
  }

  const signature = await sendSwap(tx, signer, opts.hooks);
  const effect = await measure(signature, owner, mint);
  if (effect === "unattributable") {
    const proceeds = sim.valueDelta > ZERO ? sim.valueDelta : ZERO;
    return { solAmount: lamportsToSol(proceeds), tokenRaw: -sim.tokenDelta, decimals: held.decimals, signature, venue, exhausted: false };
  }
  const sold = -effect.tokenDelta;
  if (sold <= ZERO) throw new TradeError("sell landed but no tokens left the wallet", signature);
  const proceeds = effect.valueDeltaLamports > ZERO ? effect.valueDeltaLamports : ZERO;
  return {
    solAmount: lamportsToSol(proceeds),
    tokenRaw: sold,
    decimals: effect.decimals ?? held.decimals,
    signature,
    venue,
    exhausted: effect.tokenAfter === ZERO && sold >= held.raw,
  };
}
