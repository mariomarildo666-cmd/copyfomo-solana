// Every transaction the worker signs goes through signAndSend: sign → persist the signature (onSigned, BEFORE the
// first broadcast) → send with preflight → confirm by POLLING getSignatureStatuses while rebroadcasting the same
// bytes until the blockhash can no longer land.
//
// Why not Connection.confirmTransaction: web3.js 1.99 races a WebSocket signatureSubscribe against block-height
// polling and checks the status only once. A dropped or stalled socket then reports "block height exceeded" for a
// transaction that LANDED (finding F3). Here "expired" is only returned after the chain passed the tx's last valid
// block height AND a history lookup still can't find the signature.
//
// Outcomes (SendError.outcome):
//   rejected    — refused in preflight (or never broadcast): nothing moved.
//   failed      — landed and failed on-chain: only the network fee moved.
//   expired     — can no longer land and was not found: nothing moved.
//   unconfirmed — broadcast, outcome unknown (RPC trouble). It MAY have landed: never treat as "nothing moved";
//                 the in-flight journal (inflight.ts) resolves it later from the signature.

import {
  ComputeBudgetProgram,
  PublicKey,
  SendTransactionError,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
  type Connection,
} from "@solana/web3.js";
import bs58 from "bs58";
import { connection } from "@/lib/solana";
import { errText } from "./log";
import { sleep } from "./util";
import type { AgentSigner } from "./wallet";

export type SendFailure = "rejected" | "failed" | "expired" | "unconfirmed";

export class SendError extends Error {
  readonly outcome: SendFailure;
  /** null only when nothing was ever signed / broadcast. */
  readonly signature: string | null;
  readonly txError: unknown;
  constructor(outcome: SendFailure, signature: string | null, detail: string, txError: unknown = null) {
    super(`transaction ${outcome}: ${detail}`);
    this.name = "SendError";
    this.outcome = outcome;
    this.signature = signature;
    this.txError = txError;
  }
}

export interface Landed {
  signature: string;
  /** Slot the transaction landed in (from the signature status), when reported. */
  slot: number | null;
  lastValidBlockHeight: number;
}

export interface SendOptions {
  /**
   * Awaited after signing and before the first broadcast (e.g. write the in-flight journal). A throw aborts the
   * send: nothing is broadcast and SendError("rejected") is thrown.
   */
  onSigned?: (p: { signature: string; lastValidBlockHeight: number }) => Promise<void>;
  /** Tunables (tests). */
  pollMs?: number;
  rebroadcastMs?: number;
  maxWaitMs?: number;
}

/** Blocks past the fetched lastValidBlockHeight before a missing signature counts as expired (RPC-node skew). */
export const EXPIRY_MARGIN_BLOCKS = 30;
/** Block-height expiry is ~60–90 s after the blockhash; give the confirm loop comfortably more. */
export const MAX_CONFIRM_WAIT_MS = 150_000;
/** Confirmation cadence (tests shorten it). */
export const sendTiming = { pollMs: 1_500, rebroadcastMs: 3_000, maxWaitMs: MAX_CONFIRM_WAIT_MS };
const HEIGHT_EVERY_POLLS = 3;
const FINAL_LOOKUPS = 3;

export type SignatureState =
  | { state: "landed"; slot: number | null }
  | { state: "failed"; slot: number | null; err: unknown }
  | { state: "missing" }
  | { state: "unknown"; detail: string };

/**
 * One status lookup with history (so an old landed tx is still found). "processed" is not final → "unknown".
 * RPC errors → "unknown". Never "missing" unless the node answered null.
 */
export async function lookupSignature(signature: string, conn: Connection = connection()): Promise<SignatureState> {
  try {
    const { value } = await conn.getSignatureStatuses([signature], { searchTransactionHistory: true });
    const st = value[0];
    if (!st) return { state: "missing" };
    if (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized") {
      return st.err ? { state: "failed", slot: st.slot ?? null, err: st.err } : { state: "landed", slot: st.slot ?? null };
    }
    return { state: "unknown", detail: `status ${st.confirmationStatus ?? "processed"}` };
  } catch (err) {
    return { state: "unknown", detail: errText(err, 120) };
  }
}

/**
 * After the chain passed the last valid block height: look the signature up a few times (a load-balanced RPC
 * node can briefly lag). landed / failed as found; "expired" only if every lookup answered "not found".
 */
export async function finalOutcome(signature: string, conn: Connection = connection(), gapMs = sendTiming.pollMs): Promise<SignatureState> {
  let sawUnknown: SignatureState | null = null;
  for (let i = 0; i < FINAL_LOOKUPS; i++) {
    const s = await lookupSignature(signature, conn);
    if (s.state === "landed" || s.state === "failed") return s;
    if (s.state === "unknown") sawUnknown = s;
    if (i < FINAL_LOOKUPS - 1) await sleep(gapMs);
  }
  return sawUnknown ?? { state: "missing" };
}

/** Fee payer must be the signer, and the signer the only required signature. */
function assertSignable(tx: VersionedTransaction, signer: AgentSigner): void {
  const payer = tx.message.staticAccountKeys[0];
  if (!payer || !payer.equals(signer.publicKey)) throw new SendError("rejected", null, "fee payer is not the agent wallet");
  if (tx.message.header.numRequiredSignatures !== 1) throw new SendError("rejected", null, "transaction requires other signers");
}

/**
 * Sign `tx` with the agent key, persist the signature (onSigned), broadcast, and confirm. Resolves once the tx
 * landed successfully; otherwise throws SendError (see the header for the outcomes).
 */
export async function signAndSend(tx: VersionedTransaction, signer: AgentSigner, opts: SendOptions = {}): Promise<Landed> {
  const conn = connection();
  const pollMs = opts.pollMs ?? sendTiming.pollMs;
  const rebroadcastMs = opts.rebroadcastMs ?? sendTiming.rebroadcastMs;
  const maxWaitMs = opts.maxWaitMs ?? sendTiming.maxWaitMs;
  assertSignable(tx, signer);

  // Upper bound of the tx's own expiry: the current latest blockhash is at least as new as the tx's.
  let lastValidBlockHeight: number;
  try {
    lastValidBlockHeight = (await conn.getLatestBlockhash("confirmed")).lastValidBlockHeight;
  } catch (err) {
    throw new SendError("rejected", null, `could not read the block height: ${errText(err, 120)}`);
  }

  tx.addSignature(signer.publicKey, signer.sign(tx.message.serialize()));
  const sigBytes = tx.signatures[0];
  if (!sigBytes) throw new SendError("rejected", null, "transaction has no signature slot");
  const signature = bs58.encode(sigBytes);
  const raw = tx.serialize();

  if (opts.onSigned) {
    try {
      await opts.onSigned({ signature, lastValidBlockHeight });
    } catch (err) {
      throw new SendError("rejected", null, `could not record the send (nothing was broadcast): ${errText(err, 120)}`);
    }
  }

  try {
    await conn.sendRawTransaction(raw, { skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 0 });
  } catch (err) {
    // The RPC answered with an error (preflight/simulation failure, bad blockhash): nothing was broadcast.
    if (err instanceof SendTransactionError) throw new SendError("rejected", signature, errText(err, 200), err);
    // Network trouble: it may or may not have gone out. Keep confirming (and rebroadcasting).
  }

  const started = Date.now();
  let lastBroadcast = Date.now();
  let polls = 0;
  const expiryBound = lastValidBlockHeight + EXPIRY_MARGIN_BLOCKS;
  while (Date.now() - started < maxWaitMs) {
    await sleep(pollMs);
    polls++;
    try {
      const { value } = await conn.getSignatureStatuses([signature]);
      const st = value[0];
      if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) {
        if (st.err) throw new SendError("failed", signature, JSON.stringify(st.err), st.err);
        return { signature, slot: st.slot ?? null, lastValidBlockHeight };
      }
    } catch (err) {
      if (err instanceof SendError) throw err;
      // RPC hiccup: keep polling until the window closes.
    }
    if (polls % HEIGHT_EVERY_POLLS === 0) {
      const height = await conn.getBlockHeight("confirmed").catch(() => null);
      if (height !== null && height > expiryBound) {
        const final = await finalOutcome(signature, conn, pollMs);
        if (final.state === "landed") return { signature, slot: final.slot, lastValidBlockHeight };
        if (final.state === "failed") throw new SendError("failed", signature, JSON.stringify(final.err), final.err);
        if (final.state === "missing") throw new SendError("expired", signature, "not found after its blockhash expired");
        throw new SendError("unconfirmed", signature, `status unknown after expiry (${final.detail})`);
      }
    }
    if (Date.now() - lastBroadcast >= rebroadcastMs) {
      lastBroadcast = Date.now();
      // Same bytes, same signature: a rebroadcast can never double-spend.
      conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }).catch(() => undefined);
    }
  }
  throw new SendError("unconfirmed", signature, "confirmation timed out");
}

// ── Plain SOL transfers (withdrawals, fee sweeps) ──────────────────────────────────────────────────

const TRANSFER_CU_LIMIT = 1_000; // a transfer + 2 compute-budget instructions use ~450 CU
const TRANSFER_CU_PRICE_MICROLAMPORTS = 100_000; // 1,000 CU × 0.1 lamport = 100 lamports
const BASE_FEE_LAMPORTS = 5_000;
/** Exact network fee of buildTransferTx's transaction (one signature). */
export const TRANSFER_FEE_LAMPORTS = BASE_FEE_LAMPORTS + Math.ceil((TRANSFER_CU_LIMIT * TRANSFER_CU_PRICE_MICROLAMPORTS) / 1_000_000);

/** Unsigned v0 SOL transfer from → to (fee payer = from) with a small priority fee. */
export async function buildTransferTx(from: PublicKey, to: string, lamports: bigint): Promise<VersionedTransaction> {
  if (lamports <= BigInt(0)) throw new Error(`transfer amount must be positive, got ${lamports}`);
  const toPk = new PublicKey(to);
  if (toPk.equals(from)) throw new Error("transfer to itself");
  const { blockhash } = await connection().getLatestBlockhash("confirmed");
  const message = new TransactionMessage({
    payerKey: from,
    recentBlockhash: blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: TRANSFER_CU_LIMIT }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: TRANSFER_CU_PRICE_MICROLAMPORTS }),
      SystemProgram.transfer({ fromPubkey: from, toPubkey: toPk, lamports }),
    ],
  }).compileToV0Message();
  return new VersionedTransaction(message);
}
