// One-click funding: the server builds an unsigned SOL transfer owner wallet → agent deposit address, the
// owner's wallet signs it (signTransaction), and the server relays it ONLY after proving it is exactly that
// transfer. The browser never gets an RPC URL, and this endpoint can never be used to relay anything else.
//
// A valid deposit transaction has:
//   - one required signature: the fee payer, which is the owner wallet, with a valid ed25519 signature;
//   - no address lookup tables; no accounts besides {owner, deposit address, System, ComputeBudget};
//   - exactly one SystemProgram.transfer from the owner (account 0) to the deposit address for exactly the
//     requested lamports;
//   - optionally ComputeBudget SetComputeUnitLimit / SetComputeUnitPrice (at most one each, bounded fee);
//   - nothing else.
// Paper mode never moves SOL: creditPaperDeposit adds simulated SOL instead.

import { randomBytes } from "node:crypto";
import { Prisma, type Agent } from "@prisma/client";
import {
  ComputeBudgetProgram,
  PublicKey,
  SendTransactionError,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";
import { config } from "./config";
import { prisma } from "./db";
import { floorLamportsSol } from "./fees";
import { HELIUS_PRIORITY } from "./helius";
import { HttpError } from "./http";
import { verifyEd25519 } from "./crypto";
import { agentKeyVerified } from "./sealguard";
import { connection, getSolBalanceBudgeted, isValidSolanaAddress, LAMPORTS_PER_SOL, sendAndConfirmRaw, SolanaTxError } from "./solana";

const SYSTEM_PROGRAM_ID = SystemProgram.programId.toBase58();
const COMPUTE_BUDGET_PROGRAM_ID = ComputeBudgetProgram.programId.toBase58();
/** SystemProgram instruction index of Transfer. */
const SYSTEM_TRANSFER = 2;
/** ComputeBudget instruction discriminators. */
const CB_SET_LIMIT = 2;
const CB_SET_PRICE = 3;
/** A transfer + 2 compute-budget instructions use ~450 CU. */
const DEPOSIT_CU_LIMIT = 1_000;
const DEPOSIT_CU_PRICE_MICROLAMPORTS = 100_000; // 1,000 CU × 0.1 lamport = 100 lamports priority fee
/** Wallets may rewrite the compute budget; cap what we relay (the owner pays it, but keep it sane). */
const MAX_CU_LIMIT = 1_400_000;
const MAX_PRIORITY_FEE_LAMPORTS = 10_000_000; // 0.01 SOL
const MAX_TX_BYTES = 1232;

/** Smallest top-up worth a transaction; the first deposit must also reach config.minDepositSol. */
export const MIN_TOPUP_SOL = 0.001;
/** Upper bound per deposit transaction (limits the damage of a UI or parsing mistake). */
export const MAX_DEPOSIT_SOL = 1_000;
/** Keeps paper balances (and the public floor's equity numbers) in a believable range. */
export const MAX_PAPER_BALANCE_SOL = 1_000;

export interface DepositExpectation {
  /** Owner wallet (fee payer and source). */
  from: string;
  /** Agent deposit address. */
  to: string;
  lamports: bigint | number;
}

export interface ValidatedDeposit {
  /** base58 first signature (the tx id). */
  signature: string;
  from: string;
  to: string;
  lamports: bigint;
  blockhash: string;
  /** The exact bytes to broadcast. */
  raw: Uint8Array;
}

/** SOL → lamports, rejecting non-finite, negative and sub-lamport amounts. */
export function solToLamports(sol: number): bigint {
  if (typeof sol !== "number" || !Number.isFinite(sol) || sol <= 0) {
    throw new HttpError(400, "invalid input", { amountSol: "must be a positive number" });
  }
  const lamports = Math.round(sol * LAMPORTS_PER_SOL);
  if (lamports <= 0) throw new HttpError(400, "invalid input", { amountSol: "must be at least 1 lamport" });
  return BigInt(lamports);
}

function toBig(v: bigint | number): bigint {
  if (typeof v === "bigint") return v;
  if (!Number.isSafeInteger(v) || v <= 0) throw new Error(`invalid lamports ${v}`);
  return BigInt(v);
}

/**
 * Unsigned transfer from → to for `lamports`, fee payer = from, recent blockhash from our RPC. The wallet
 * deserializes it (VersionedTransaction.deserialize), signs (signTransaction) and hands it back.
 */
export async function buildDepositTx(p: DepositExpectation): Promise<{ txBase64: string; lastValidBlockHeight: number; blockhash: string }> {
  if (!isValidSolanaAddress(p.from) || !isValidSolanaAddress(p.to)) throw new HttpError(400, "invalid deposit address");
  if (p.from === p.to) throw new HttpError(400, "the agent can't fund itself");
  const lamports = toBig(p.lamports);
  const from = new PublicKey(p.from);
  const { blockhash, lastValidBlockHeight } = await connection().getLatestBlockhash("confirmed");
  const message = new TransactionMessage({
    payerKey: from,
    recentBlockhash: blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: DEPOSIT_CU_LIMIT }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: DEPOSIT_CU_PRICE_MICROLAMPORTS }),
      SystemProgram.transfer({ fromPubkey: from, toPubkey: new PublicKey(p.to), lamports }),
    ],
  }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  return { txBase64: Buffer.from(tx.serialize()).toString("base64"), lastValidBlockHeight, blockhash };
}

const reject = (why: string) => new HttpError(400, `invalid deposit transaction: ${why}`);

function readU32(data: Uint8Array, at: number): number {
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength).readUInt32LE(at);
}
function readU64(data: Uint8Array, at: number): bigint {
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength).readBigUInt64LE(at);
}

/**
 * Structural checks shared by validateSignedDeposit and submitDeposit: a single SOL transfer signed by its
 * own fee payer, nothing else. Throws HttpError(400) with the reason.
 */
function inspectDeposit(txBase64: string): ValidatedDeposit {
  if (typeof txBase64 !== "string" || txBase64.length === 0 || txBase64.length > 2_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(txBase64)) {
    throw reject("not base64");
  }
  const raw = Buffer.from(txBase64, "base64");
  if (raw.length === 0 || raw.length > MAX_TX_BYTES) throw reject("wrong size");

  let tx: VersionedTransaction;
  try {
    tx = VersionedTransaction.deserialize(raw);
  } catch {
    throw reject("not a Solana transaction");
  }
  // Re-serialization must give the same bytes (no trailing data, canonical encoding).
  if (!Buffer.from(tx.serialize()).equals(raw)) throw reject("non-canonical encoding");

  const msg = tx.message;
  if (msg.version !== "legacy" && msg.addressTableLookups.length > 0) throw reject("address lookup tables are not allowed");
  const { numRequiredSignatures, numReadonlySignedAccounts, numReadonlyUnsignedAccounts } = msg.header;
  if (numRequiredSignatures !== 1 || numReadonlySignedAccounts !== 0) throw reject("exactly one signer (your wallet) is allowed");
  if (tx.signatures.length !== 1) throw reject("exactly one signature is allowed");

  const keys = msg.staticAccountKeys.map((k) => k.toBase58());
  if (new Set(keys).size !== keys.length) throw reject("duplicate accounts");
  const from = keys[0];
  if (!from) throw reject("no fee payer");

  // Signature: the fee payer signed exactly these message bytes.
  const sig = tx.signatures[0]!;
  if (sig.every((b) => b === 0)) throw reject("not signed");
  if (!verifyEd25519(msg.serialize(), sig, new PublicKey(from).toBytes())) throw reject("signature does not match the fee payer");

  let transfer: { to: string; lamports: bigint } | null = null;
  let cuLimit: number | null = null;
  let cuPrice: bigint | null = null;
  const usedPrograms = new Set<string>();
  for (const ix of msg.compiledInstructions) {
    const program = keys[ix.programIdIndex];
    if (!program) throw reject("unknown program");
    usedPrograms.add(program);
    const data = ix.data;
    if (program === COMPUTE_BUDGET_PROGRAM_ID) {
      if (ix.accountKeyIndexes.length !== 0) throw reject("unexpected compute budget accounts");
      if (data.length === 5 && data[0] === CB_SET_LIMIT && cuLimit === null) {
        cuLimit = readU32(data, 1);
        if (cuLimit > MAX_CU_LIMIT) throw reject("compute unit limit too high");
      } else if (data.length === 9 && data[0] === CB_SET_PRICE && cuPrice === null) {
        cuPrice = readU64(data, 1);
      } else {
        throw reject("unexpected compute budget instruction");
      }
      continue;
    }
    if (program === SYSTEM_PROGRAM_ID) {
      if (transfer !== null) throw reject("more than one transfer");
      if (data.length !== 12 || readU32(data, 0) !== SYSTEM_TRANSFER) throw reject("only a plain SOL transfer is allowed");
      if (ix.accountKeyIndexes.length !== 2 || ix.accountKeyIndexes[0] !== 0) throw reject("the transfer must come from your wallet");
      const toIndex = ix.accountKeyIndexes[1]!;
      const to = keys[toIndex];
      if (!to || toIndex === 0) throw reject("bad transfer destination");
      // The destination must be a writable non-signer (index below the read-only unsigned block).
      if (toIndex >= keys.length - numReadonlyUnsignedAccounts) throw reject("transfer destination is read-only");
      transfer = { to, lamports: readU64(data, 4) };
      continue;
    }
    throw reject("only a SOL transfer (plus compute budget) is allowed");
  }
  if (!transfer) throw reject("no SOL transfer");
  if (transfer.lamports <= BigInt(0)) throw reject("zero amount");

  // Priority fee bound: limit (default 200k CU per instruction when unset) × price.
  const limit = BigInt(cuLimit ?? 200_000 * msg.compiledInstructions.length);
  const priorityLamports = cuPrice === null ? BigInt(0) : (limit * cuPrice + BigInt(999_999)) / BigInt(1_000_000);
  if (priorityLamports > BigInt(MAX_PRIORITY_FEE_LAMPORTS)) throw reject("priority fee too high");

  // No stray accounts: only the payer, the destination and the programs actually invoked.
  const allowed = new Set([from, transfer.to, ...usedPrograms]);
  if (keys.some((k) => !allowed.has(k))) throw reject("unexpected accounts");

  return { signature: bs58.encode(sig), from, to: transfer.to, lamports: transfer.lamports, blockhash: msg.recentBlockhash, raw };
}

/**
 * Prove a wallet-signed transaction is EXACTLY the expected deposit (see the header). Returns what to
 * broadcast; throws HttpError(400) on anything unexpected.
 */
export function validateSignedDeposit(txBase64: string, expected: DepositExpectation): ValidatedDeposit {
  const v = inspectDeposit(txBase64);
  if (v.from !== expected.from) throw reject("fee payer is not your signed-in wallet");
  if (v.to !== expected.to) throw reject("recipient is not this agent's deposit address");
  if (v.lamports !== toBig(expected.lamports)) throw reject("amount does not match the requested deposit");
  return v;
}

/** The deposit was broadcast but its confirmation is not known yet (it may still land). */
export class DepositPendingError extends HttpError {
  readonly signature: string;
  constructor(signature: string, detail: string) {
    super(504, `deposit sent but not confirmed yet (${detail}) — it will show up once it lands`);
    this.name = "DepositPendingError";
    this.signature = signature;
  }
}

function sendErrorDetail(err: SendTransactionError): string {
  const text = err.message.replace(/\s+/g, " ");
  if (/insufficient (funds|lamports)|0x1\b/i.test(text)) return "not enough SOL in your wallet for this amount plus the network fee";
  if (/blockhash not found|block height exceeded/i.test(text)) return "the transaction expired — sign it again";
  if (/already been processed/i.test(text)) return "this transaction was already sent";
  return text.slice(0, 160);
}

/**
 * Broadcast a wallet-signed deposit and wait for confirmation (blockhash strategy). Always re-runs the
 * structural checks; with `expected` it also checks sender, recipient and amount (routes should pass it).
 * Returns the signature. Throws HttpError(400) when the network rejects or fails it, DepositPendingError (504)
 * when it was sent but not confirmed.
 */
export async function submitDeposit(txBase64: string, expected?: DepositExpectation): Promise<string> {
  const v = expected ? validateSignedDeposit(txBase64, expected) : inspectDeposit(txBase64);
  try {
    return await sendAndConfirmRaw(v.raw, v.signature, v.blockhash);
  } catch (err) {
    if (err instanceof SendTransactionError) throw new HttpError(400, `deposit rejected: ${sendErrorDetail(err)}`);
    if (err instanceof SolanaTxError) {
      if (err.outcome === "failed") throw new HttpError(400, "deposit failed on-chain (nothing was transferred)");
      if (err.outcome === "expired") throw new HttpError(400, "deposit expired before it landed — sign it again");
      throw new DepositPendingError(v.signature, "network confirmation timed out");
    }
    throw new DepositPendingError(v.signature, err instanceof Error ? err.message.slice(0, 120) : "unknown error");
  }
}

// ── Agent-level flows (used by the API routes) ──────────────────────────────────────────────────────

type FundableAgent = Pick<Agent, "id" | "mode" | "status" | "ownerWallet" | "depositAddress">;

function assertLiveFundable(agent: FundableAgent): string {
  if (agent.mode !== "live") throw new HttpError(400, "paper agents are funded with simulated SOL, not real transfers");
  if (agent.status === "stopped") throw new HttpError(409, "this agent is stopped for good — create a new one to copy again");
  if (!agent.ownerWallet) {
    throw new HttpError(400, "this agent has no owner wallet — send SOL to its deposit address from any wallet");
  }
  return agent.ownerWallet;
}

function checkAmount(amountSol: number): bigint {
  const lamports = solToLamports(amountSol);
  if (amountSol < MIN_TOPUP_SOL) throw new HttpError(400, "invalid input", { amountSol: `at least ${MIN_TOPUP_SOL} SOL` });
  if (amountSol > MAX_DEPOSIT_SOL) throw new HttpError(400, "invalid input", { amountSol: `at most ${MAX_DEPOSIT_SOL} SOL per deposit` });
  return lamports;
}

/** DepositTxDTO for a live agent owned by a wallet: the unsigned transfer owner → deposit address. */
export async function prepareDeposit(p: {
  agent: FundableAgent;
  amountSol: number;
}): Promise<{ txBase64: string; lastValidBlockHeight: number; amountSol: number }> {
  const owner = assertLiveFundable(p.agent);
  const lamports = checkAmount(p.amountSol);
  const built = await buildDepositTx({ from: owner, to: p.agent.depositAddress, lamports });
  return { txBase64: built.txBase64, lastValidBlockHeight: built.lastValidBlockHeight, amountSol: Number(lamports) / LAMPORTS_PER_SOL };
}

/**
 * Relay a wallet-signed deposit for a live agent: validate it is exactly owner → deposit address for
 * `amountSol`, record a Deposit row (signature unique: a replay gets 409), send + confirm, then refresh the
 * stored balance and switch an awaiting agent on once it holds minDepositSol.
 * Returns status "confirmed", or "submitted" when it was sent but not confirmed yet (the worker's balance loop
 * will see it land). Throws HttpError 400/409 otherwise.
 */
export async function relayDeposit(p: {
  agent: FundableAgent;
  txBase64: string;
  amountSol: number;
}): Promise<{ signature: string; status: "confirmed" | "submitted"; balanceSol: number | null }> {
  const owner = assertLiveFundable(p.agent);
  const lamports = checkAmount(p.amountSol);
  const expected = { from: owner, to: p.agent.depositAddress, lamports };
  const v = validateSignedDeposit(p.txBase64, expected);
  const amountSol = Number(lamports) / LAMPORTS_PER_SOL;

  let depositId: string;
  try {
    const row = await prisma.deposit.create({
      data: { agentId: p.agent.id, fromWallet: owner, amountSol, signature: v.signature, status: "submitted" },
      select: { id: true },
    });
    depositId = row.id;
  } catch (err) {
    if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")) throw err;
    // Same signed transaction again: only a FAILED attempt of this agent's may be retried (e.g. a transient
    // RPC rejection); anything else is a replay.
    const retried = await prisma.deposit.updateMany({
      where: { signature: v.signature, agentId: p.agent.id, status: "failed" },
      data: { status: "submitted", error: null },
    });
    if (retried.count !== 1) throw new HttpError(409, "this deposit was already submitted");
    depositId = (await prisma.deposit.findUniqueOrThrow({ where: { signature: v.signature }, select: { id: true } })).id;
  }

  try {
    await submitDeposit(p.txBase64, expected);
  } catch (err) {
    if (err instanceof DepositPendingError) {
      return { signature: v.signature, status: "submitted", balanceSol: null };
    }
    const message = err instanceof Error ? err.message.slice(0, 200) : "failed";
    await prisma.deposit.update({ where: { id: depositId }, data: { status: "failed", error: message } }).catch(() => undefined);
    throw err;
  }

  await prisma.deposit.update({ where: { id: depositId }, data: { status: "confirmed", confirmedAt: new Date() } });
  const balanceSol = await refreshStoredBalance(p.agent).catch(() => null);
  return { signature: v.signature, status: "confirmed", balanceSol };
}

/**
 * Re-read a live agent's on-chain balance (P1: a deposit just landed, the owner is waiting), store it, and flip
 * awaiting_deposit → active once it reaches minDepositSol — but only after the worker proved it can open this
 * agent's key (Kv "sealcheck:<id>" ok, finding F12). Otherwise the balance is stored and the worker's balance loop
 * verifies the key and switches the agent on within seconds. Returns the balance.
 */
export async function refreshStoredBalance(agent: Pick<Agent, "id" | "depositAddress">): Promise<number> {
  const sol = await getSolBalanceBudgeted(agent.depositAddress, HELIUS_PRIORITY.live);
  await prisma.agent.updateMany({ where: { id: agent.id }, data: { lastBalanceSol: sol, balanceAt: new Date() } });
  if (sol >= config.minDepositSol && (await agentKeyVerified(agent.id))) {
    await prisma.agent.updateMany({ where: { id: agent.id, status: "awaiting_deposit" }, data: { status: "active" } });
  }
  return sol;
}

/**
 * Paper mode: credit `amountSol` of simulated SOL (never a real transfer), record it as a confirmed Deposit
 * ("paper_…" signature) and switch an awaiting agent on once it holds minDepositSol. Capped at
 * MAX_PAPER_BALANCE_SOL. Returns the new paper balance.
 */
export async function creditPaperDeposit(p: {
  agent: Pick<Agent, "id" | "mode" | "status">;
  amountSol: number;
  fromWallet: string;
}): Promise<number> {
  if (p.agent.mode !== "paper") {
    throw new HttpError(400, "simulated deposits are only for paper-mode agents — live agents are funded from your wallet");
  }
  if (p.agent.status === "stopped") throw new HttpError(409, "this agent is stopped for good — create a new one to copy again");
  const amount = floorLamportsSol(Number(solToLamports(p.amountSol)) / LAMPORTS_PER_SOL);
  if (amount <= 0) throw new HttpError(400, "invalid input", { amountSol: "must be at least 1 lamport" });
  if (amount > MAX_PAPER_BALANCE_SOL) {
    throw new HttpError(400, "invalid input", { amountSol: `at most ${MAX_PAPER_BALANCE_SOL} SOL` });
  }

  return prisma.$transaction(async (tx) => {
    // Conditional increment: re-checks mode/status/cap atomically with the write.
    const res = await tx.agent.updateMany({
      where: { id: p.agent.id, mode: "paper", status: { not: "stopped" }, paperSol: { lte: MAX_PAPER_BALANCE_SOL - amount } },
      data: { paperSol: { increment: amount } },
    });
    if (res.count === 0) {
      const now = await tx.agent.findUnique({ where: { id: p.agent.id }, select: { status: true, paperSol: true } });
      if (!now || now.status === "stopped") throw new HttpError(409, "this agent is stopped for good — create a new one to copy again");
      const room = Math.max(0, Math.floor((MAX_PAPER_BALANCE_SOL - now.paperSol) * 1e4) / 1e4);
      const msg = `paper balance is capped at ${MAX_PAPER_BALANCE_SOL} SOL (room for ${room} more)`;
      throw new HttpError(400, msg, { amountSol: msg });
    }
    await tx.deposit.create({
      data: {
        agentId: p.agent.id,
        fromWallet: p.fromWallet,
        amountSol: amount,
        signature: `paper_${randomBytes(12).toString("hex")}`,
        status: "confirmed",
        confirmedAt: new Date(),
      },
    });
    await tx.agent.updateMany({
      where: { id: p.agent.id, status: "awaiting_deposit", paperSol: { gte: config.minDepositSol } },
      data: { status: "active" },
    });
    const after = await tx.agent.findUniqueOrThrow({ where: { id: p.agent.id }, select: { paperSol: true } });
    return after.paperSol;
  });
}

// ── The signed-in wallet's own balance (wizard: "you have X SOL") ───────────────────────────────────

const WALLET_BALANCE_TTL_MS = 10_000;
const walletBalanceCache = new Map<string, { sol: number; at: number }>();
const walletBalanceInflight = new Map<string, Promise<number>>();

/**
 * SOL balance of a (signed-in) wallet, cached 10 s and single-flight per wallet. Budget-checked at P2 (backfill
 * level): it pauses before the copy engine ever would. Routes add a per-IP / per-wallet rate limit on top.
 */
export async function walletSolBalance(wallet: string): Promise<number> {
  if (!isValidSolanaAddress(wallet)) throw new HttpError(400, "invalid wallet");
  const now = Date.now();
  const hit = walletBalanceCache.get(wallet);
  if (hit && now - hit.at < WALLET_BALANCE_TTL_MS) return hit.sol;
  const running = walletBalanceInflight.get(wallet);
  if (running) return running;
  const p = getSolBalanceBudgeted(wallet, HELIUS_PRIORITY.backfill)
    .then((sol) => {
      if (walletBalanceCache.size > 5_000) walletBalanceCache.clear();
      walletBalanceCache.set(wallet, { sol, at: Date.now() });
      return sol;
    })
    .finally(() => walletBalanceInflight.delete(wallet));
  walletBalanceInflight.set(wallet, p);
  return p;
}
