// Client-side guard for one-click funding: before the wallet is asked to sign, prove the transaction the
// server handed us is EXACTLY "transfer N lamports from my wallet to this agent's deposit address" (plus an
// optional compute budget). The server validates the signed transaction again before relaying it; this check
// means a tampered or buggy response can never get a signature for anything else. Pure: unit-tested.

import { ComputeBudgetProgram, SystemProgram, type VersionedTransaction } from "@solana/web3.js";

const SYSTEM_PROGRAM = SystemProgram.programId.toBase58();
const COMPUTE_BUDGET_PROGRAM = ComputeBudgetProgram.programId.toBase58();
const SYSTEM_TRANSFER = 2;
const CB_SET_LIMIT = 2;
const CB_SET_PRICE = 3;
/** The server asks ~100 lamports of priority fee; anything above 0.001 SOL is not something we built. */
const MAX_PRIORITY_FEE_LAMPORTS = BigInt(1_000_000);
const DEFAULT_CU_PER_IX = BigInt(200_000);
const LAMPORTS_PER_SOL = 1_000_000_000;

export interface DepositExpectation {
  /** Owner wallet: fee payer and source. */
  from: string;
  /** Agent deposit address. */
  to: string;
  lamports: bigint;
}

export class DepositTxMismatch extends Error {
  constructor(reason: string) {
    super(`This transfer isn't what we expected (${reason}). Nothing was sent.`);
    this.name = "DepositTxMismatch";
  }
}

export function solToLamports(sol: number): bigint {
  if (!Number.isFinite(sol) || sol <= 0) throw new RangeError("amount must be a positive number of SOL");
  return BigInt(Math.round(sol * LAMPORTS_PER_SOL));
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function view(data: Uint8Array): DataView {
  return new DataView(data.buffer, data.byteOffset, data.byteLength);
}

/**
 * Throws DepositTxMismatch unless `tx` is a deposit of exactly `expected.lamports` from `expected.from` to
 * `expected.to`, paid by `expected.from`, with nothing else but at most one SetComputeUnitLimit and one
 * SetComputeUnitPrice (bounded priority fee).
 */
export function checkDepositTx(tx: VersionedTransaction, expected: DepositExpectation): void {
  const msg = tx.message;
  const keys = msg.staticAccountKeys.map((k) => k.toBase58());
  const fail = (why: string): never => {
    throw new DepositTxMismatch(why);
  };

  if (msg.header.numRequiredSignatures !== 1) fail("it asks for more than one signature");
  if (keys[0] !== expected.from) fail("the fee payer is not your wallet");
  if (msg.addressTableLookups.length > 0) fail("it uses address lookup tables");
  if (expected.from === expected.to) fail("it sends to your own wallet");

  let transfers = 0;
  let limits = 0;
  let prices = 0;
  let cuLimit: bigint | null = null;
  let cuPrice = BigInt(0);

  for (const ix of msg.compiledInstructions) {
    const program = keys[ix.programIdIndex];
    if (program === SYSTEM_PROGRAM) {
      transfers++;
      const d = ix.data;
      if (d.length !== 12 || view(d).getUint32(0, true) !== SYSTEM_TRANSFER) fail("it is not a plain SOL transfer");
      if (ix.accountKeyIndexes.length !== 2) fail("the transfer has unexpected accounts");
      const [src, dst] = ix.accountKeyIndexes;
      if (keys[src] !== expected.from) fail("the SOL does not come from your wallet");
      if (keys[dst] !== expected.to) fail("the recipient is not this agent's deposit address");
      if (view(d).getBigUint64(4, true) !== expected.lamports) fail("the amount differs from what you asked for");
    } else if (program === COMPUTE_BUDGET_PROGRAM) {
      const d = ix.data;
      if (ix.accountKeyIndexes.length !== 0) fail("the compute budget instruction has accounts");
      if (d[0] === CB_SET_LIMIT && d.length === 5) {
        limits++;
        cuLimit = BigInt(view(d).getUint32(1, true));
      } else if (d[0] === CB_SET_PRICE && d.length === 9) {
        prices++;
        cuPrice = view(d).getBigUint64(1, true);
      } else {
        fail("it carries an unexpected compute budget instruction");
      }
    } else {
      fail("it calls a program other than the System and Compute Budget programs");
    }
  }

  if (transfers !== 1) fail("it must contain exactly one transfer");
  if (limits > 1 || prices > 1) fail("it repeats compute budget instructions");
  const units = cuLimit ?? DEFAULT_CU_PER_IX * BigInt(msg.compiledInstructions.length);
  const priorityFee = (units * cuPrice + BigInt(999_999)) / BigInt(1_000_000);
  if (priorityFee > MAX_PRIORITY_FEE_LAMPORTS) fail("its priority fee is unusually high");

  const allowed = new Set([expected.from, expected.to, SYSTEM_PROGRAM, COMPUTE_BUDGET_PROGRAM]);
  if (keys.some((k) => !allowed.has(k))) fail("it touches other accounts");
}

/** True when two serialized messages are byte-identical (did the wallet change what it signed?). */
export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
