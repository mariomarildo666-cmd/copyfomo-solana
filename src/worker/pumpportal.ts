// PumpPortal local-transaction API: fallback venue for pump.fun bonding-curve tokens Jupiter cannot route yet.
//   POST https://pumpportal.fun/api/trade-local
//   { publicKey, action: "buy"|"sell", mint, amount, denominatedInSol: "true"|"false", slippage (percent),
//     priorityFee (SOL), pool: "auto" }  →  200 with a serialized VersionedTransaction (binary body).
// Sell amounts may also be a percentage string such as "100%".
// The transaction is built by a third party. This module only fetches and shape-checks it (fee payer = agent, one
// signer); swap.ts then runs txguard.ts on it — program/instruction allowlist plus a simulation diff of the
// wallet and every agent token account — before the agent key signs anything (finding F1).

import { VersionedTransaction } from "@solana/web3.js";

const ENDPOINT = "https://pumpportal.fun/api/trade-local";
const TIMEOUT_MS = 8000;
/** Solana packet size: a real transaction never exceeds it. */
const MAX_TX_BYTES = 1232;

export interface PumpPortalOrder {
  publicKey: string;
  action: "buy" | "sell";
  mint: string;
  /** Buys: SOL to spend. Sells: UI token amount, or "100%". */
  amount: number | string;
  denominatedInSol: boolean;
  slippagePct: number;
  priorityFeeSol: number;
}

/** pump.fun mints are vanity addresses ending in "pump". */
export function isPumpMint(mint: string): boolean {
  return mint.endsWith("pump");
}

export async function buildPumpPortalTx(order: PumpPortalOrder): Promise<VersionedTransaction> {
  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        publicKey: order.publicKey,
        action: order.action,
        mint: order.mint,
        amount: order.amount,
        denominatedInSol: order.denominatedInSol ? "true" : "false",
        slippage: order.slippagePct,
        priorityFee: order.priorityFeeSol,
        pool: "auto",
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`pumpportal: request failed (${err instanceof Error ? err.message : String(err)})`);
  }
  if (res.status !== 200) {
    const text = (await res.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 160);
    throw new Error(`pumpportal: HTTP ${res.status} ${text}`);
  }

  let tx: VersionedTransaction;
  try {
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length > MAX_TX_BYTES) throw new Error("oversized");
    tx = VersionedTransaction.deserialize(bytes);
  } catch {
    throw new Error("pumpportal: response is not a serialized transaction");
  }
  const feePayer = tx.message.staticAccountKeys[0];
  if (!feePayer || feePayer.toBase58() !== order.publicKey) throw new Error("pumpportal: fee payer is not the agent wallet");
  if (tx.message.header.numRequiredSignatures !== 1) throw new Error("pumpportal: transaction requires extra signers");
  return tx;
}
