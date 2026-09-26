// Jupiter Swap API (Metis v1): GET /swap/v1/quote → POST /swap/v1/swap.
// Base URL from config.jupiterUrl (lite-api.jup.ag keyless, api.jup.ag with x-api-key; live mode requires the key).
//
// Every Jupiter call in this process (quotes, swap builds, prices, token metadata) shares ONE token bucket sized
// to the plan (config.jupiterRps / jupiterBurst), served by priority: exits (sell quotes and builds) first, then
// builds for quoted buys (so a new quote can't take the slot an already-quoted trade needs), then buy quotes,
// then background calls. A 429 pauses the bucket until Jupiter's x-ratelimit-reset / Retry-After and the call is
// retried within a per-priority wait budget (finding F24).

import { VersionedTransaction } from "@solana/web3.js";
import { z } from "zod";
import { config } from "./config";
import { fetchJson, UpstreamError, type FetchJsonOptions } from "./http";
import { isValidSolanaAddress, SOL_MINT } from "./solana";

export interface JupQuote {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  priceImpactPct: string;
  /** The untouched upstream quote JSON; sent back verbatim as `quoteResponse` when building the swap. */
  raw: unknown;
}

const TIMEOUT_MS = 8000;

// ── Rate budget ─────────────────────────────────────────────────────────────────────────────────────

/** Lower number = served first. */
export const JUP_PRIORITY = Object.freeze({
  /** Sell quotes and sell builds: an agent must always be able to exit. */
  exit: 0,
  /** Swap builds for buys that already hold a quote. */
  build: 1,
  /** Buy quotes (paper and live). */
  entry: 2,
  /** Prices and token metadata (dashboards, valuation). */
  background: 3,
} as const);
export type JupPriority = (typeof JUP_PRIORITY)[keyof typeof JUP_PRIORITY];

/** How long a call may wait (queue + 429 pauses) before giving up. Buys go stale fast; exits keep trying. */
const MAX_WAIT_MS: Record<JupPriority, number> = { 0: 45_000, 1: 20_000, 2: 10_000, 3: 6_000 };
const MAX_ATTEMPTS = 4;
/** Pause after a 429 that carried no reset hint. */
const DEFAULT_429_PAUSE_MS = 2_000;

export class JupiterBudgetError extends UpstreamError {
  constructor(label: string, waitedMs: number) {
    super(`${label}: Jupiter rate budget exhausted (waited ${Math.round(waitedMs / 100) / 10}s)`, 429);
    this.name = "JupiterBudgetError";
  }
}

/** Token bucket with a priority queue and a shared 429 pause. Exported for tests. */
export class JupiterGate {
  private tokens: number;
  private refilledAt: number;
  private pausedUntil = 0;
  private seq = 0;
  private readonly queue: { p: number; seq: number; deadline: number; resolve: () => void; reject: (e: Error) => void }[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly rps: number,
    private readonly burst: number,
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = burst;
    this.refilledAt = now();
  }

  /** Resolves when the call may go out; rejects with JupiterBudgetError once `deadline` (ms) passes. */
  acquire(priority: number, deadline: number, label = "jupiter"): Promise<void> {
    return new Promise((resolve, reject) => {
      const started = this.now();
      const item = {
        p: priority,
        seq: this.seq++,
        deadline,
        resolve,
        reject: () => reject(new JupiterBudgetError(label, this.now() - started)),
      };
      let i = this.queue.length;
      while (i > 0 && this.queue[i - 1]!.p > priority) i--;
      this.queue.splice(i, 0, item);
      this.pump();
    });
  }

  /** 429 seen: nobody sends until `untilMs`; then one probe goes out and the bucket refills at `rps`. */
  pause(untilMs: number): void {
    this.pausedUntil = Math.max(this.pausedUntil, untilMs);
    this.tokens = Math.min(this.tokens, 1);
    this.refilledAt = Math.max(this.refilledAt, untilMs);
    this.pump();
  }

  get queued(): number {
    return this.queue.length;
  }

  private pump(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const now = this.now();
    // Expire callers whose deadline passed while waiting.
    for (let i = this.queue.length - 1; i >= 0; i--) {
      if (this.queue[i]!.deadline <= now) this.queue.splice(i, 1)[0]!.reject(new Error("deadline"));
    }
    while (this.queue.length > 0) {
      if (now < this.pausedUntil) return this.wake(this.pausedUntil - now);
      this.tokens = Math.min(this.burst, this.tokens + ((now - this.refilledAt) / 1000) * this.rps);
      this.refilledAt = now;
      if (this.tokens < 1) return this.wake(Math.ceil(((1 - this.tokens) / this.rps) * 1000));
      this.tokens -= 1;
      this.queue.shift()!.resolve();
    }
  }

  private wake(ms: number): void {
    const nextDeadline = this.queue.reduce((m, q) => Math.min(m, q.deadline), Infinity);
    const wait = Math.max(1, Math.min(ms, nextDeadline - this.now()));
    this.timer = setTimeout(() => {
      this.timer = null;
      this.pump();
    }, wait);
    // Never keep a process alive just for a queued Jupiter call.
    (this.timer as { unref?: () => void }).unref?.();
  }
}

const globalForJup = globalThis as unknown as { __copyfomoJupiterGate?: JupiterGate };
const gate: JupiterGate = (globalForJup.__copyfomoJupiterGate ??= new JupiterGate(config.jupiterRps, config.jupiterBurst));

function base(): string {
  return config.jupiterUrl.replace(/\/+$/, "");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * GET/POST against the Jupiter API with the optional x-api-key, through the process-wide rate budget.
 * Shared by prices.ts / tokens.ts (default priority: background).
 */
export async function jupiterRequest<Out, In>(
  path: string,
  schema: z.ZodType<Out, z.ZodTypeDef, In>,
  opts: Omit<FetchJsonOptions, "headers" | "timeoutMs"> & { priority?: JupPriority },
) {
  const headers: Record<string, string> = {};
  if (config.jupiterApiKey) headers["x-api-key"] = config.jupiterApiKey;
  const priority = opts.priority ?? JUP_PRIORITY.background;
  const started = Date.now();
  const deadline = started + MAX_WAIT_MS[priority];

  for (let attempt = 1; ; attempt++) {
    await gate.acquire(priority, deadline, opts.label);
    try {
      return await fetchJson(`${base()}${path}`, schema, { ...opts, headers, timeoutMs: TIMEOUT_MS });
    } catch (err) {
      if (!(err instanceof UpstreamError) || err.status !== 429) throw err;
      const wait = err.retryAfterMs ?? DEFAULT_429_PAUSE_MS;
      gate.pause(Date.now() + wait);
      if (attempt >= MAX_ATTEMPTS || Date.now() + wait >= deadline) throw err;
      await sleep(Math.min(wait, 250)); // the gate holds the rest of the pause
    }
  }
}

// ── Quote ───────────────────────────────────────────────────────────────────────────────────────────

const uintString = z.string().regex(/^\d+$/, "expected an unsigned integer string");

const quoteSchema = z
  .object({
    inputMint: z.string(),
    outputMint: z.string(),
    inAmount: uintString,
    outAmount: uintString,
    otherAmountThreshold: uintString,
    swapMode: z.string(),
    slippageBps: z.number(),
    priceImpactPct: z.union([z.string(), z.number()]).transform(String),
    routePlan: z.array(z.unknown()).min(1, "empty route plan"),
  })
  .passthrough();

/** Default priority of a quote: selling into SOL is an exit, anything else an entry. */
function quotePriority(outputMint: string): JupPriority {
  return outputMint === SOL_MINT ? JUP_PRIORITY.exit : JUP_PRIORITY.entry;
}

export async function getQuote(p: {
  inputMint: string;
  outputMint: string;
  amount: bigint;
  slippageBps: number;
  priority?: JupPriority;
}): Promise<JupQuote> {
  if (!isValidSolanaAddress(p.inputMint) || !isValidSolanaAddress(p.outputMint)) {
    throw new Error("jupiter quote: invalid mint address");
  }
  if (p.inputMint === p.outputMint) throw new Error("jupiter quote: input and output mint are the same");
  if (p.amount <= BigInt(0)) throw new Error(`jupiter quote: amount must be positive, got ${p.amount}`);
  if (!Number.isInteger(p.slippageBps) || p.slippageBps < 1 || p.slippageBps > 10_000) {
    throw new Error(`jupiter quote: invalid slippageBps ${p.slippageBps}`);
  }

  const qs = new URLSearchParams({
    inputMint: p.inputMint,
    outputMint: p.outputMint,
    amount: p.amount.toString(),
    slippageBps: String(p.slippageBps),
    swapMode: "ExactIn",
    // Jupiter's recommendation for landing rates: route only through liquid intermediate tokens.
    restrictIntermediateTokens: "true",
  });
  const { data, raw } = await jupiterRequest(`/swap/v1/quote?${qs}`, quoteSchema, {
    label: "jupiter quote",
    priority: p.priority ?? quotePriority(p.outputMint),
  });

  // Never trade on a quote for something other than what we asked for.
  if (data.inputMint !== p.inputMint || data.outputMint !== p.outputMint) {
    throw new UpstreamError("jupiter quote: response mints do not match the request", null);
  }
  if (data.swapMode !== "ExactIn" || data.inAmount !== p.amount.toString()) {
    throw new UpstreamError("jupiter quote: response amount does not match the request", null);
  }
  if (BigInt(data.outAmount) <= BigInt(0)) {
    throw new UpstreamError("jupiter quote: zero output amount (no liquidity)", null);
  }

  return {
    inputMint: data.inputMint,
    outputMint: data.outputMint,
    inAmount: data.inAmount,
    outAmount: data.outAmount,
    priceImpactPct: data.priceImpactPct,
    raw,
  };
}

// ── Swap build ──────────────────────────────────────────────────────────────────────────────────────

const swapSchema = z
  .object({
    swapTransaction: z.string().min(1),
    lastValidBlockHeight: z.number().optional(),
    prioritizationFeeLamports: z.number().optional(),
    computeUnitLimit: z.number().optional(),
    simulationError: z.unknown().optional(),
  })
  .passthrough();

function describeSimulationError(e: unknown): string {
  if (typeof e === "string") return e;
  if (typeof e === "object" && e !== null) {
    const rec = e as Record<string, unknown>;
    const parts = [rec.errorCode, rec.error].filter((x): x is string => typeof x === "string");
    if (parts.length) return parts.join(": ");
  }
  return JSON.stringify(e);
}

/**
 * Priority-fee ceiling for a swap (finding F23): at most `bps` of its SOL size (buys: SOL in; sells: expected
 * SOL out, with twice the share so exits keep landing), never below `floor`, never above `max`. Swaps with no
 * SOL leg get `max`. Pure; exported for tests.
 */
export function priorityFeeCapLamports(
  q: Pick<JupQuote, "inputMint" | "outputMint" | "inAmount" | "outAmount">,
  opts: { maxLamports: number; bps: number; floorLamports: number } = {
    maxLamports: config.maxPriorityFeeLamports,
    bps: config.priorityFeeMaxBps,
    floorLamports: config.priorityFeeFloorLamports,
  },
): number {
  const max = Math.max(0, Math.floor(opts.maxLamports));
  let sizeLamports: number;
  let share = opts.bps;
  if (q.inputMint === SOL_MINT) sizeLamports = Number(q.inAmount);
  else if (q.outputMint === SOL_MINT) {
    sizeLamports = Number(q.outAmount);
    share = opts.bps * 2;
  } else return max;
  if (!Number.isFinite(sizeLamports) || sizeLamports <= 0) return Math.min(max, Math.floor(opts.floorLamports));
  const relative = Math.floor((sizeLamports * share) / 10_000);
  return Math.min(max, Math.max(Math.floor(opts.floorLamports), relative));
}

export interface BuiltSwap {
  tx: VersionedTransaction;
  /** Priority fee Jupiter set (lamports), when it reported one. Add it to the trade's cost. */
  priorityFeeLamports: number | null;
  /** The ceiling we asked for (priorityFeeCapLamports). */
  priorityFeeCapLamports: number;
  computeUnitLimit: number | null;
}

/** Build (not sign) the swap transaction for `userPublicKey` from a quote, with its priority-fee details. */
export async function buildSwap(quote: JupQuote, userPublicKey: string): Promise<BuiltSwap> {
  if (!isValidSolanaAddress(userPublicKey)) throw new Error("jupiter swap: invalid userPublicKey");
  const cap = priorityFeeCapLamports(quote);

  const { data } = await jupiterRequest("/swap/v1/swap", swapSchema, {
    label: "jupiter swap",
    method: "POST",
    priority: quote.outputMint === SOL_MINT ? JUP_PRIORITY.exit : JUP_PRIORITY.build,
    body: {
      quoteResponse: quote.raw,
      userPublicKey,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: {
        priorityLevelWithMaxLamports: {
          maxLamports: cap,
          priorityLevel: "veryHigh",
        },
      },
    },
  });

  // Jupiter simulates when sizing compute units; a failed simulation would fail on-chain too.
  if (data.simulationError !== undefined && data.simulationError !== null) {
    throw new UpstreamError(`jupiter swap: simulation failed (${describeSimulationError(data.simulationError)})`, null);
  }
  if (typeof data.prioritizationFeeLamports === "number" && data.prioritizationFeeLamports > cap + 1) {
    throw new UpstreamError(`jupiter swap: priority fee ${data.prioritizationFeeLamports} exceeds the cap ${cap}`, null);
  }

  let tx: VersionedTransaction;
  try {
    tx = VersionedTransaction.deserialize(Buffer.from(data.swapTransaction, "base64"));
  } catch (err) {
    throw new UpstreamError(`jupiter swap: could not deserialize transaction (${err instanceof Error ? err.message : err})`, null);
  }
  const feePayer = tx.message.staticAccountKeys[0];
  if (!feePayer || feePayer.toBase58() !== userPublicKey) {
    throw new UpstreamError("jupiter swap: transaction fee payer is not the agent wallet", null);
  }
  return {
    tx,
    priorityFeeLamports: typeof data.prioritizationFeeLamports === "number" ? data.prioritizationFeeLamports : null,
    priorityFeeCapLamports: cap,
    computeUnitLimit: typeof data.computeUnitLimit === "number" ? data.computeUnitLimit : null,
  };
}

/** Build (not sign) the swap transaction for `userPublicKey` from a quote. See buildSwap for the fee details. */
export async function buildSwapTx(quote: JupQuote, userPublicKey: string): Promise<VersionedTransaction> {
  return (await buildSwap(quote, userPublicKey)).tx;
}
