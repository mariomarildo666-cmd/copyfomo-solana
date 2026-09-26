import {
  Connection,
  LAMPORTS_PER_SOL as WEB3_LAMPORTS_PER_SOL,
  PublicKey,
  SendTransactionError,
  TransactionExpiredBlockheightExceededError,
} from "@solana/web3.js";
import bs58 from "bs58";
import { z } from "zod";
import { config, deriveWsUrl } from "./config";
import { heliusConfigured, heliusFetch, rpc, type HeliusPriority } from "./helius";

export const SOL_MINT = "So11111111111111111111111111111111111111112";
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const USDT_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
export const LAMPORTS_PER_SOL: number = WEB3_LAMPORTS_PER_SOL;

const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

const globalForSolana = globalThis as unknown as { __copyfomoConnection?: Connection };

export function connection(): Connection {
  if (!globalForSolana.__copyfomoConnection) {
    globalForSolana.__copyfomoConnection = new Connection(config.rpcUrl, {
      commitment: "confirmed",
      wsEndpoint: config.wsUrl || deriveWsUrl(config.rpcUrl),
      // Helius hosts: metered (HeliusUsage) + shared rate gate at P0. Other RPC hosts pass straight through.
      fetch: heliusFetch,
    });
  }
  return globalForSolana.__copyfomoConnection;
}

/** Base58 string that decodes to exactly 32 bytes. Does not require the key to be on-curve (PDAs are valid). */
export function isValidSolanaAddress(s: string): boolean {
  if (typeof s !== "string" || s.length < 32 || s.length > 44) return false;
  try {
    return bs58.decode(s).length === 32;
  } catch {
    return false;
  }
}

function toPublicKey(address: string, what: string): PublicKey {
  if (!isValidSolanaAddress(address)) throw new Error(`${what} is not a valid Solana address: "${address}"`);
  return new PublicKey(address);
}

export async function getSolBalance(address: string): Promise<number> {
  const lamports = await connection().getBalance(toPublicKey(address, "address"), "confirmed");
  return lamports / LAMPORTS_PER_SOL;
}

const balanceResultSchema = z.object({ value: z.number().int().nonnegative() }).passthrough();

/**
 * SOL balance read that respects the Helius daily budget: through helius.rpc at `priority` (P2+ pause when the
 * cap is near; throws HeliusError "throttled"). For the WEB process (owner dashboards, deposits, the wallet
 * balance in the wizard), so visitors can never spend the copy engine's P0 budget (finding F26). Falls back to
 * the plain Connection when no Helius key is configured.
 */
export async function getSolBalanceBudgeted(address: string, priority: HeliusPriority): Promise<number> {
  toPublicKey(address, "address");
  if (!heliusConfigured()) return getSolBalance(address);
  const res = await rpc<unknown>("getBalance", [address, { commitment: "confirmed" }], { priority, retries: 1, timeoutMs: 10_000 });
  const parsed = balanceResultSchema.safeParse(res);
  if (!parsed.success) throw new Error("getBalance: unexpected result shape");
  return parsed.data.value / LAMPORTS_PER_SOL;
}

const parsedTokenAccountSchema = z.object({
  parsed: z.object({
    info: z.object({
      mint: z.string(),
      tokenAmount: z.object({ amount: z.string().regex(/^\d+$/), decimals: z.number().int().min(0) }),
    }),
  }),
});

const parsedMintSchema = z.object({
  parsed: z.object({ info: z.object({ decimals: z.number().int().min(0) }) }),
});

// Decimals never change for a mint; remember them so a zero balance still reports correct decimals.
const decimalsCache = new Map<string, number>();

async function fetchMintDecimals(mint: PublicKey): Promise<number | null> {
  const info = await connection().getParsedAccountInfo(mint, "confirmed");
  const parsed = parsedMintSchema.safeParse(info.value?.data);
  return parsed.success ? parsed.data.parsed.info.decimals : null;
}

/**
 * Sum of every token account `owner` holds for `mint`, across both the Token and Token-2022 programs.
 * `decimals` comes from a token account for the mint, else the mint account (cached per process), else it is
 * null: UNKNOWN. Never default it to 0 (finding F9: a 0 persisted on a Position inflated its value by
 * 10^decimals). When `raw > 0` the decimals always come from a real token account.
 */
export async function getTokenBalanceRaw(owner: string, mint: string): Promise<{ raw: bigint; decimals: number | null }> {
  const ownerPk = toPublicKey(owner, "owner");
  const mintPk = toPublicKey(mint, "mint");
  const conn = connection();
  const cachedDecimals = decimalsCache.get(mint);

  const [legacy, t22, mintDecimals] = await Promise.all([
    conn.getParsedTokenAccountsByOwner(ownerPk, { programId: TOKEN_PROGRAM_ID }, "confirmed"),
    conn.getParsedTokenAccountsByOwner(ownerPk, { programId: TOKEN_2022_PROGRAM_ID }, "confirmed"),
    cachedDecimals === undefined ? fetchMintDecimals(mintPk).catch(() => null) : Promise.resolve(cachedDecimals),
  ]);

  let raw = BigInt(0);
  let decimals: number | null = mintDecimals;
  for (const { account } of [...legacy.value, ...t22.value]) {
    const parsed = parsedTokenAccountSchema.safeParse(account.data);
    if (!parsed.success) continue;
    const { info } = parsed.data.parsed;
    if (info.mint !== mint) continue;
    raw += BigInt(info.tokenAmount.amount);
    decimals = info.tokenAmount.decimals;
  }
  if (decimals !== null) decimalsCache.set(mint, decimals);
  return { raw, decimals };
}

/**
 * A transaction was signed and (possibly) broadcast, so it carries the signature:
 *  - "failed":      landed and failed on-chain (no state change besides the fee).
 *  - "expired":     block height passed its last valid height AND a history lookup (3 tries) never found the
 *                   signature — it can never land.
 *  - "unconfirmed": outcome unknown (network error / confirmation timeout / lookup error). It MAY still land;
 *                   callers must not assume nothing happened (reconcile from the chain).
 * Errors thrown before broadcast (e.g. web3.js SendTransactionError from a failed preflight) are rethrown as-is.
 */
export class SolanaTxError extends Error {
  signature: string;
  outcome: "failed" | "expired" | "unconfirmed";
  txError: unknown;
  constructor(signature: string, outcome: SolanaTxError["outcome"], detail: string, txError: unknown = null) {
    super(`transaction ${signature} ${outcome}: ${detail}`);
    this.name = "SolanaTxError";
    this.signature = signature;
    this.outcome = outcome;
    this.txError = txError;
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const EXPIRY_LOOKUPS = 3;
const EXPIRY_LOOKUP_GAP_MS = 1_500;

/**
 * web3.js reports "block height exceeded" when its confirmation polling missed the status — a transaction that
 * landed can still be reported that way. Before calling it expired, look the signature up in history: landed →
 * return it; failed → "failed"; never found (every try) → "expired"; RPC errors or only "processed" → "unconfirmed".
 * Never tells a caller "expired, sign again" for a deposit that actually landed (double-deposit risk).
 */
async function settleAfterExpiry(signature: string): Promise<string> {
  const conn = connection();
  let unknown = false;
  for (let i = 0; i < EXPIRY_LOOKUPS; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, EXPIRY_LOOKUP_GAP_MS));
    try {
      const { value } = await conn.getSignatureStatuses([signature], { searchTransactionHistory: true });
      const st = value[0];
      if (!st) continue;
      if (st.err) throw new SolanaTxError(signature, "failed", JSON.stringify(st.err), st.err);
      if (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized") return signature;
      unknown = true; // "processed": may still be rolled back or confirm
    } catch (err) {
      if (err instanceof SolanaTxError) throw err;
      unknown = true;
    }
  }
  if (unknown) throw new SolanaTxError(signature, "unconfirmed", "block height exceeded; status unknown");
  throw new SolanaTxError(signature, "expired", "block height exceeded and the signature was never found");
}

async function broadcastAndConfirm(
  raw: Uint8Array,
  signature: string,
  blockhash: string,
  lastValidBlockHeight: Promise<number>,
): Promise<string> {
  const conn = connection();
  try {
    await conn.sendRawTransaction(raw, { skipPreflight: false, maxRetries: 3, preflightCommitment: "confirmed" });
  } catch (err) {
    // The RPC answered with an error (preflight/simulation failure, bad blockhash): nothing was broadcast.
    if (err instanceof SendTransactionError) throw err;
    throw new SolanaTxError(signature, "unconfirmed", `send failed: ${errMessage(err)}`);
  }

  let result: Awaited<ReturnType<Connection["confirmTransaction"]>>;
  try {
    result = await conn.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight: await lastValidBlockHeight },
      "confirmed",
    );
  } catch (err) {
    if (err instanceof TransactionExpiredBlockheightExceededError) return settleAfterExpiry(signature);
    throw new SolanaTxError(signature, "unconfirmed", `confirmation failed: ${errMessage(err)}`);
  }
  if (result.value.err) {
    throw new SolanaTxError(signature, "failed", JSON.stringify(result.value.err), result.value.err);
  }
  return signature;
}

/**
 * Send an already fully signed transaction (e.g. a deposit the owner's wallet signed) and confirm it with the
 * blockhash strategy. `signature` is its first signature (base58), `blockhash` its recentBlockhash. Errors:
 * SendTransactionError (rejected in preflight, nothing broadcast) or
 * SolanaTxError ("failed" | "expired" | "unconfirmed"). (The worker signs and confirms its own transactions in
 * src/worker/send.ts; this module only relays wallet-signed deposits.)
 */
export async function sendAndConfirmRaw(raw: Uint8Array, signature: string, blockhash: string): Promise<string> {
  const lastValid = connection()
    .getLatestBlockhash("confirmed")
    .then((b) => b.lastValidBlockHeight);
  lastValid.catch(() => {}); // surfaced when awaited in broadcastAndConfirm
  return broadcastAndConfirm(raw, signature, blockhash, lastValid);
}
