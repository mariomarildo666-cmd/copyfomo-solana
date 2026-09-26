// zod schemas for every /api body and query string. Field paths match the DTO field names so the UI
// can pin `fields` messages to its inputs (e.g. "traders.1.wallet", "depositSol", "fixedSol").

import { z } from "zod";
import { config } from "@/lib/config";
import { isValidSolanaAddress } from "@/lib/solana";
import type { CreateAgentInput, LeaderboardWindow, UpdateAgentInput, WithdrawInput } from "@/lib/types";

export const MIN_TRADE_SOL = 0.001;
/** Largest single simulated (paper) deposit. The paper balance itself is capped at 1,000 SOL (lib/deposit). */
export const MAX_PAPER_DEPOSIT_SOL = 100;
/**
 * Largest single live deposit. Must equal lib/deposit MAX_DEPOSIT_SOL (pinned by schemas.test.ts); kept here so
 * this module stays free of Prisma / web3.js imports (UI tests import it). lib/deposit re-checks the range.
 */
export const MAX_DEPOSIT_SOL = 1_000;
export const MIN_WITHDRAW_SOL = 0.0001;
export const AGENT_NAME_MAX = 24;
export const MAX_SLIPPAGE_BPS = 5000;
/**
 * Live agents may not set more slippage than this (finding F18: defense in depth against rule changes that
 * extract funds through trades). Paper agents keep the full range.
 */
export const LIVE_MAX_SLIPPAGE_BPS = 1500;

// ── Building blocks ─────────────────────────────────────────────────────────────────────────────────

export const solanaAddress = z
  .string({ required_error: "required", invalid_type_error: "must be a Solana address" })
  .trim()
  .refine(isValidSolanaAddress, "not a valid Solana address");

/**
 * Client-supplied trader labels are ignored (fomo.upsertTrader copies labels from our seed file / Helius labels
 * only), so they are trimmed instead of rejected: old clients keep working.
 */
function hint(max: number) {
  return z
    .string()
    .max(2048)
    .nullish()
    .transform((v) => {
      const t = v?.trim();
      return t ? t.slice(0, max) : null;
    });
}

const traderInput = z
  .object({
    wallet: z
      .string({
        required_error: "wallet is required",
        invalid_type_error: "this trader has no Solana wallet to copy",
      })
      .trim()
      .refine(isValidSolanaAddress, "not a valid Solana address"),
    handle: hint(40),
    displayName: hint(64),
    avatarUrl: hint(512),
  })
  .strict();

export type TraderInput = z.output<typeof traderInput>;

const tradersList = z
  .array(traderInput, { required_error: "pick at least one trader", invalid_type_error: "must be a list of traders" })
  .min(1, "pick at least one trader")
  .max(config.maxTradersPerAgent, `at most ${config.maxTradersPerAgent} traders per agent`)
  .superRefine((list, ctx) => {
    const seen = new Set<string>();
    list.forEach((t, i) => {
      if (seen.has(t.wallet)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [i, "wallet"], message: "this trader is already in the list" });
      }
      seen.add(t.wallet);
    });
  });

const tradeSol = z
  .number({ invalid_type_error: "must be a number" })
  .finite("must be a number")
  .min(MIN_TRADE_SOL, `at least ${MIN_TRADE_SOL} SOL`)
  .max(config.hardMaxPerTradeSol, `at most ${config.hardMaxPerTradeSol} SOL`);

const slippageBps = z
  .number({ invalid_type_error: "must be a number" })
  .int("whole basis points only")
  .min(10, "at least 10 bps (0.1%)")
  .max(MAX_SLIPPAGE_BPS, `at most ${MAX_SLIPPAGE_BPS} bps (50%)`);

const sizingMode = z.enum(["mirror", "fixed", "proportional"], {
  errorMap: () => ({ message: "must be mirror, fixed or proportional" }),
});

const copySells = z.boolean({ invalid_type_error: "must be true or false" });

/** Lowercased; "" means "pick a default". */
const agentName = z
  .string({ invalid_type_error: "must be text" })
  .trim()
  .toLowerCase()
  .max(AGENT_NAME_MAX, `at most ${AGENT_NAME_MAX} characters`)
  .refine((s) => s === "" || /^[a-z0-9_.-]+$/.test(s), "only a-z, 0-9, _ . - allowed")
  .refine((s) => s === "" || /[a-z0-9]/.test(s), "needs at least one letter or digit")
  .transform((s) => s || undefined);

const solAmount = z
  .number({ required_error: "required", invalid_type_error: "must be a number" })
  .finite("must be a number")
  .gt(0, "must be above 0");

/** The first deposit (create wizard "Fund" step): at least minDepositSol, so the agent switches on. */
const depositSol = solAmount
  .min(config.minDepositSol, `at least ${config.minDepositSol} SOL to switch the agent on`)
  .max(
    config.mode === "paper" ? MAX_PAPER_DEPOSIT_SOL : MAX_DEPOSIT_SOL,
    config.mode === "paper"
      ? `at most ${MAX_PAPER_DEPOSIT_SOL} simulated SOL per deposit`
      : `at most ${MAX_DEPOSIT_SOL} SOL per deposit`,
  );

/** base58 ed25519 signature (64 bytes → 86-88 chars). */
const base58Signature = z
  .string({ required_error: "required", invalid_type_error: "must be a base58 signature" })
  .trim()
  .min(64, "not a signature")
  .max(100, "not a signature")
  .regex(/^[1-9A-HJ-NP-Za-km-z]+$/, "not a base58 signature");

const nonceString = z
  .string({ required_error: "required", invalid_type_error: "must be text" })
  .trim()
  .regex(/^[1-9A-HJ-NP-Za-km-z]{10,40}$/, "not a valid nonce");

// ── Bodies ──────────────────────────────────────────────────────────────────────────────────────────

/** POST /api/agents. The owner and payout wallet are the signed-in session wallet: there is no payout field. */
export const createAgentSchema = z
  .object({
    name: agentName.optional(),
    traders: tradersList,
    sizingMode,
    fixedSol: tradeSol.optional(),
    maxPerTradeSol: tradeSol.optional(),
    slippageBps: slippageBps.optional(),
    copySells: copySells.optional(),
    depositSol,
  })
  .strict()
  .superRefine((v, ctx) => {
    if (config.mode === "live" && v.slippageBps !== undefined && v.slippageBps > LIVE_MAX_SLIPPAGE_BPS) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["slippageBps"], message: liveSlippageMessage() });
    }
  });

export function liveSlippageMessage(): string {
  return `live agents allow at most ${LIVE_MAX_SLIPPAGE_BPS} bps (${LIVE_MAX_SLIPPAGE_BPS / 100}%)`;
}

/**
 * Wallet confirmation of a risk-raising rule change on a live agent (step-up, finding F18): the nonce from the
 * 428 challenge and the wallet's signMessage signature over its `message`.
 */
export const stepUpConfirm = z
  .object({ nonce: nonceString, signature: base58Signature })
  .strict();

export const updateAgentSchema = z
  .object({
    status: z.enum(["active", "paused"], { errorMap: () => ({ message: "must be active or paused" }) }).optional(),
    sizingMode: sizingMode.optional(),
    fixedSol: tradeSol.optional(),
    maxPerTradeSol: tradeSol.optional(),
    slippageBps: slippageBps.optional(),
    copySells: copySells.optional(),
    traders: tradersList.optional(),
    confirm: stepUpConfirm.optional(),
  })
  .strict();

export type UpdateAgentBody = z.output<typeof updateAgentSchema>;

/** Paper top-up (simulated SOL). */
export const paperDepositSchema = z
  .object({
    amountSol: solAmount.max(MAX_PAPER_DEPOSIT_SOL, `at most ${MAX_PAPER_DEPOSIT_SOL} SOL per paper deposit`),
  })
  .strict();

/** POST /api/agents/[id]/deposit-tx (live): the unsigned transfer to build. Range is checked by lib/deposit. */
export const depositTxSchema = z
  .object({ amountSol: solAmount.max(MAX_DEPOSIT_SOL, `at most ${MAX_DEPOSIT_SOL} SOL per deposit`) })
  .strict();

/** POST /api/agents/[id]/deposit-submit (live): the wallet-signed transfer + the amount the owner approved. */
export const depositSubmitSchema = z
  .object({
    txBase64: z
      .string({ required_error: "required", invalid_type_error: "must be a base64 transaction" })
      .trim()
      .min(1, "required")
      .max(2_000, "not a deposit transaction"),
    amountSol: solAmount.max(MAX_DEPOSIT_SOL, `at most ${MAX_DEPOSIT_SOL} SOL per deposit`),
  })
  .strict();

export const withdrawSchema = z
  .object({
    amountSol: z
      .number({ invalid_type_error: "must be a number" })
      .finite("must be a number")
      .min(MIN_WITHDRAW_SOL, `at least ${MIN_WITHDRAW_SOL} SOL`)
      .optional(),
    all: z.boolean({ invalid_type_error: "must be true or false" }).optional(),
    closePositions: z.boolean({ invalid_type_error: "must be true or false" }).optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.all === true && v.amountSol !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["amountSol"], message: "leave the amount empty when withdrawing everything" });
    }
    if (v.all !== true && v.amountSol === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["amountSol"], message: "enter an amount, or withdraw everything" });
    }
  });

/** close-all / logout take no input; an empty body or `{}` only. */
export const emptySchema = z.object({}).strict();

/** POST /api/auth/nonce */
export const nonceSchema = z.object({ wallet: solanaAddress }).strict();

/** POST /api/auth/verify */
export const verifySchema = z
  .object({
    wallet: solanaAddress,
    message: z
      .string({ required_error: "required", invalid_type_error: "must be text" })
      .min(1, "required")
      .max(2_000, "too long"),
    signature: base58Signature,
  })
  .strict();

// ── Query strings ───────────────────────────────────────────────────────────────────────────────────

/** Coerced integer clamped into [min, max]; non-numeric input is a 400. */
function limitParam(fallback: number, max: number) {
  return z.coerce
    .number({ invalid_type_error: "must be a number" })
    .finite("must be a number")
    .transform((n) => Math.min(Math.max(Math.floor(n), 1), max))
    .default(fallback);
}

/** Rolling windows we rank over. "all" is still accepted from old links and means the longest window (30d). */
export const tradersQuery = z
  .object({
    window: z
      .enum(["24h", "7d", "30d", "all"], { errorMap: () => ({ message: "must be 24h, 7d or 30d" }) })
      .default("24h")
      .transform((w): LeaderboardWindow => (w === "all" ? "30d" : w)),
    limit: limitParam(50, 150),
  })
  .strict();

export const lookupQuery = z
  .object({
    q: z.string({ required_error: "enter a wallet or @handle" }).trim().min(1, "enter a wallet or @handle").max(100, "too long"),
  })
  .strict();

/** GET /api/traders/[wallet]?view=summary: trader + window stats only (a light poll for open profile tabs). */
export const traderDetailQuery = z
  .object({
    view: z.enum(["full", "summary"], { errorMap: () => ({ message: "must be full or summary" }) }).default("full"),
  })
  .strict();

/** GET /api/agents/[id]/commands?type=withdraw|close_all&limit=5 */
export const commandsQuery = z
  .object({
    type: z.enum(["withdraw", "close_all"], { errorMap: () => ({ message: "must be withdraw or close_all" }) }).optional(),
    limit: limitParam(5, 20),
  })
  .strict();

export const floorQuery = z.object({ limit: limitParam(24, 100) }).strict();
export const feedQuery = z.object({ limit: limitParam(30, 100) }).strict();

// ── Contract drift guards: fail typecheck if src/lib/types.ts inputs stop fitting these schemas ─────

type Assert<T extends true> = T;
export type _CreateFits = Assert<CreateAgentInput extends z.input<typeof createAgentSchema> ? true : false>;
export type _UpdateFits = Assert<UpdateAgentInput extends z.input<typeof updateAgentSchema> ? true : false>;
export type _WithdrawFits = Assert<WithdrawInput extends z.input<typeof withdrawSchema> ? true : false>;
