// Live agents: close the agent's empty token accounts to reclaim their rent (~0.002 SOL each) after a
// close-all and before a withdrawal's SOL transfer. Best effort — never blocks the withdrawal.
//
// Only accounts that the token program lets the agent close are touched: owned by the agent, initialized
// (not frozen), no foreign close authority, no withheld Token-2022 transfer fees, and a zero token balance.
// Native WSOL accounts are closed even with a balance (closing unwraps it into the agent's own SOL).
// The rent always goes back to the agent wallet itself.

import { ComputeBudgetProgram, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { connection, LAMPORTS_PER_SOL, SOL_MINT } from "@/lib/solana";
import { errText, logger } from "./log";
import { SendError, signAndSend } from "./send";
import type { AgentSigner } from "./wallet";

const log = logger("rent");

export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
/** SPL Token / Token-2022 instruction index of CloseAccount (same layout in both programs). */
const CLOSE_ACCOUNT_IX = 9;
/** Closes per transaction (each adds one account key + a 3-key instruction; well under the size limit). */
export const MAX_CLOSES_PER_TX = 12;
const CU_PER_CLOSE = 20_000;
const CU_BASE = 5_000;
const CU_PRICE_MICROLAMPORTS = 10_000;

export interface TokenAccountInfo {
  address: string;
  programId: string;
  mint: string;
  owner: string;
  amountRaw: bigint;
  lamports: number;
  /** "initialized" | "frozen" | … */
  state: string;
  closeAuthority: string | null;
  isNative: boolean;
  /** Token-2022 transferFeeAmount with withheld fees (CloseAccount would fail). */
  withheldFees: boolean;
  /** Token-2022 mint with a transfer hook (transferHookAccount extension): never auto-traded. */
  transferHook: boolean;
  decimals: number | null;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** One getParsedTokenAccountsByOwner row → TokenAccountInfo, or null when the parsed shape is unexpected. */
export function parseTokenAccount(address: string, programId: string, lamports: number, data: unknown): TokenAccountInfo | null {
  const parsed = isObj(data) && isObj(data.parsed) ? data.parsed : null;
  const info = parsed && isObj(parsed.info) ? parsed.info : null;
  if (!info) return null;
  const amount = isObj(info.tokenAmount) ? info.tokenAmount.amount : undefined;
  if (typeof info.mint !== "string" || typeof info.owner !== "string" || typeof amount !== "string" || !/^\d+$/.test(amount)) return null;
  let withheldFees = false;
  let transferHook = false;
  if (Array.isArray(info.extensions)) {
    for (const ext of info.extensions) {
      if (!isObj(ext)) continue;
      if (ext.extension === "transferHookAccount") transferHook = true;
      if (ext.extension !== "transferFeeAmount") continue;
      const withheld = isObj(ext.state) ? ext.state.withheldAmount : undefined;
      if (withheld === undefined || Number(withheld) !== 0) withheldFees = true;
    }
  }
  const decimals = isObj(info.tokenAmount) && typeof info.tokenAmount.decimals === "number" ? info.tokenAmount.decimals : null;
  return {
    address,
    programId,
    mint: info.mint,
    owner: info.owner,
    amountRaw: BigInt(amount),
    lamports: Number.isFinite(lamports) ? lamports : 0,
    state: typeof info.state === "string" ? info.state : "unknown",
    closeAuthority: typeof info.closeAuthority === "string" ? info.closeAuthority : null,
    isNative: info.isNative === true,
    withheldFees,
    transferHook,
    decimals,
  };
}

/** Accounts the agent (`owner`) can close right now without losing tokens. */
export function closableTokenAccounts(accounts: readonly TokenAccountInfo[], owner: string): TokenAccountInfo[] {
  return accounts.filter(
    (a) =>
      (a.programId === TOKEN_PROGRAM || a.programId === TOKEN_2022_PROGRAM) &&
      a.owner === owner &&
      a.state === "initialized" &&
      (a.closeAuthority === null || a.closeAuthority === owner) &&
      !a.withheldFees &&
      (a.amountRaw === BigInt(0) || (a.isNative && a.mint === SOL_MINT)),
  );
}

export function closeAccountInstruction(programId: string, account: string, owner: string): TransactionInstruction {
  const ownerPk = new PublicKey(owner);
  return new TransactionInstruction({
    programId: new PublicKey(programId),
    keys: [
      { pubkey: new PublicKey(account), isSigner: false, isWritable: true },
      { pubkey: ownerPk, isSigner: false, isWritable: true }, // destination: the agent wallet itself
      { pubkey: ownerPk, isSigner: true, isWritable: false },
    ],
    data: Buffer.from([CLOSE_ACCOUNT_IX]),
  });
}

export interface RentReclaim {
  closed: number;
  failed: number;
  /** Rent returned to the agent wallet (sum of the closed accounts' lamports). */
  reclaimedSol: number;
  signatures: string[];
  errors: string[];
}

/** Every token account `owner` holds (Token + Token-2022), parsed. */
export async function listTokenAccounts(owner: PublicKey): Promise<TokenAccountInfo[]> {
  const conn = connection();
  const out: TokenAccountInfo[] = [];
  for (const programId of [TOKEN_PROGRAM, TOKEN_2022_PROGRAM]) {
    const res = await conn.getParsedTokenAccountsByOwner(owner, { programId: new PublicKey(programId) }, "confirmed");
    for (const { pubkey, account } of res.value) {
      const info = parseTokenAccount(pubkey.toBase58(), programId, account.lamports, account.data);
      if (info) out.push(info);
    }
  }
  return out;
}

async function sendCloses(signer: AgentSigner, accounts: readonly TokenAccountInfo[]): Promise<string> {
  const owner = signer.address;
  const { blockhash } = await connection().getLatestBlockhash("confirmed");
  const instructions = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: CU_BASE + CU_PER_CLOSE * accounts.length }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: CU_PRICE_MICROLAMPORTS }),
    ...accounts.map((a) => closeAccountInstruction(a.programId, a.address, owner)),
  ];
  const message = new TransactionMessage({ payerKey: signer.publicKey, recentBlockhash: blockhash, instructions }).compileToV0Message();
  return (await signAndSend(new VersionedTransaction(message), signer)).signature;
}

/**
 * Rejected before broadcast, landed and failed, or really expired (send.ts checks the chain before saying so):
 * nothing changed, so smaller retries are safe.
 */
function isCleanFailure(err: unknown): boolean {
  return err instanceof SendError && (err.outcome === "rejected" || err.outcome === "failed" || err.outcome === "expired");
}

const isUnconfirmed = (err: unknown) => err instanceof SendError && err.outcome === "unconfirmed";

/**
 * Close every closable token account of the agent wallet (`signer`), in batches of MAX_CLOSES_PER_TX. A batch that
 * fails cleanly is retried one account at a time; an unconfirmed send stops the run (the caller re-reads the
 * balance anyway). Never throws for per-account problems — they are counted and returned.
 */
export async function closeEmptyTokenAccounts(signer: AgentSigner): Promise<RentReclaim> {
  const owner = signer.address;
  const result: RentReclaim = { closed: 0, failed: 0, reclaimedSol: 0, signatures: [], errors: [] };
  const closable = closableTokenAccounts(await listTokenAccounts(signer.publicKey), owner);
  if (closable.length === 0) return result;

  const done = (batch: readonly TokenAccountInfo[], sig: string) => {
    result.closed += batch.length;
    result.reclaimedSol += batch.reduce((s, a) => s + a.lamports, 0) / LAMPORTS_PER_SOL;
    result.signatures.push(sig);
  };

  for (let i = 0; i < closable.length; i += MAX_CLOSES_PER_TX) {
    const batch = closable.slice(i, i + MAX_CLOSES_PER_TX);
    try {
      done(batch, await sendCloses(signer, batch));
      continue;
    } catch (err) {
      if (!isCleanFailure(err) || batch.length === 1) {
        result.failed += batch.length;
        result.errors.push(errText(err, 120));
        if (isUnconfirmed(err)) break;
        continue;
      }
      log.debug("batch close failed; retrying one by one", { owner, n: batch.length, err: errText(err) });
    }
    for (const a of batch) {
      try {
        done([a], await sendCloses(signer, [a]));
      } catch (err) {
        result.failed++;
        result.errors.push(`${a.mint.slice(0, 6)}: ${errText(err, 100)}`);
        if (isUnconfirmed(err)) return result;
      }
    }
  }
  if (result.closed > 0 || result.failed > 0) {
    log.info("token accounts closed", { owner, closed: result.closed, failed: result.failed, sol: result.reclaimedSol.toFixed(6) });
  }
  return result;
}
