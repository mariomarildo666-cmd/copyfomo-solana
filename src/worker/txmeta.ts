// Exact fill measurement from a landed transaction's own metadata (getTransaction), findings F2 / F8.
// Balance reads after a swap lag behind (load-balanced RPC nodes, token-by-owner index) and read the whole
// wallet; the tx meta is the ledger's own record of what THIS transaction changed:
//   - tokens: Σ post − Σ pre token balances of the agent's accounts for the mint (owner === agent);
//   - SOL value: the agent wallet's lamport change (it is the fee payer, account 0) plus the lamport change of every
//     token account the agent owns that the tx touched. Rent parked in a new token account is reclaimable (rent.ts
//     closes empty accounts) and WSOL is SOL, so neither counts as spent; network fees, priority fees and venue
//     fees do. Buy cost = −value change; sell proceeds = +value change.

import type { Connection } from "@solana/web3.js";
import { connection } from "@/lib/solana";
import { sleep } from "./util";

export interface TokenBalanceLike {
  accountIndex: number;
  mint: string;
  owner?: string | null;
  uiTokenAmount: { amount: string; decimals: number };
}

/** The parts of a VersionedTransactionResponse / TransactionResponse this module reads. */
export interface TxResponseLike {
  slot: number;
  transaction: { message: { staticAccountKeys?: { toBase58(): string }[]; accountKeys?: { toBase58(): string }[] } };
  meta: {
    err: unknown;
    fee: number;
    preBalances: number[];
    postBalances: number[];
    preTokenBalances?: TokenBalanceLike[] | null;
    postTokenBalances?: TokenBalanceLike[] | null;
  } | null;
}

export interface AgentTxEffect {
  slot: number;
  /** On-chain error (the tx landed and failed), else null. */
  err: unknown;
  feeLamports: number;
  /** Net change of the agent's SOL value in lamports (negative for a buy). */
  valueDeltaLamports: bigint;
  tokenBefore: bigint;
  tokenAfter: bigint;
  /** tokenAfter − tokenBefore (positive for a buy). */
  tokenDelta: bigint;
  decimals: number | null;
}

const ZERO = BigInt(0);

/**
 * What `tx` did to `owner` for `mint`. null when the response can't be attributed: no meta, the agent is not the
 * fee payer, or token balances carry no owner (old RPC).
 */
export function analyzeAgentTx(tx: TxResponseLike, owner: string, mint: string): AgentTxEffect | null {
  const meta = tx.meta;
  if (!meta) return null;
  const msg = tx.transaction.message;
  const payer = (msg.staticAccountKeys ?? msg.accountKeys)?.[0]?.toBase58();
  if (payer !== owner) return null;
  const pre = meta.preTokenBalances ?? [];
  const post = meta.postTokenBalances ?? [];
  if ([...pre, ...post].some((b) => b.owner === undefined || b.owner === null)) return null;

  const agentAccounts = new Set<number>();
  let tokenBefore = ZERO;
  let tokenAfter = ZERO;
  let decimals: number | null = null;
  for (const b of pre) {
    if (b.owner !== owner) continue;
    agentAccounts.add(b.accountIndex);
    if (b.mint === mint) {
      tokenBefore += BigInt(b.uiTokenAmount.amount);
      decimals = b.uiTokenAmount.decimals;
    }
  }
  for (const b of post) {
    if (b.owner !== owner) continue;
    agentAccounts.add(b.accountIndex);
    if (b.mint === mint) {
      tokenAfter += BigInt(b.uiTokenAmount.amount);
      decimals = b.uiTokenAmount.decimals;
    }
  }

  const lamportDelta = (i: number): bigint => BigInt(meta.postBalances[i] ?? 0) - BigInt(meta.preBalances[i] ?? 0);
  let value = lamportDelta(0);
  for (const i of agentAccounts) if (i !== 0) value += lamportDelta(i);

  return {
    slot: tx.slot,
    err: meta.err ?? null,
    feeLamports: meta.fee,
    valueDeltaLamports: value,
    tokenBefore,
    tokenAfter,
    tokenDelta: tokenAfter - tokenBefore,
    decimals,
  };
}

/**
 * The transaction's effect on the agent. getTransaction can be null for a moment right after "confirmed", so it is
 * retried a few times. "unavailable": not served yet (try again later); "unattributable": served but can't be
 * measured (see analyzeAgentTx) — retrying will not help.
 */
export async function fetchAgentTxEffect(
  signature: string,
  owner: string,
  mint: string,
  opts: { tries?: number; delayMs?: number; conn?: Connection } = {},
): Promise<AgentTxEffect | "unavailable" | "unattributable"> {
  const conn = opts.conn ?? connection();
  const tries = opts.tries ?? 8;
  for (let i = 0; i < tries; i++) {
    try {
      const tx = await conn.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      if (tx) return analyzeAgentTx(tx as unknown as TxResponseLike, owner, mint) ?? "unattributable";
    } catch {
      // retry
    }
    if (i < tries - 1) await sleep((opts.delayMs ?? 750) * Math.min(i + 1, 4));
  }
  return "unavailable";
}
