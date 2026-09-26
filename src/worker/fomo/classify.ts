// Ingest classification (pure): rule R on one normalized transaction, the FomoSwap row to store for a tracked
// trader, and the drift signals of §2.7. Unit-tested against the verified mainnet fixtures.

import {
  classifyFomoTx,
  isUnmarkedFomoSwap,
  toFomoSwapRow,
  type FomoClass,
  type FomoSwapRow,
  type FomoSwapSource,
  type MiniTx,
} from "@/lib/fomo-chain";

export interface IngestClassification {
  cls: FomoClass;
  /** The trader (signer #1) for trade / convert / xchain, else null. */
  user: string | null;
  /** Row to store (trade / convert / xchain of a tracked trader), else null. */
  row: FomoSwapRow | null;
  /** The trader is not in the in-memory tracked set (caller may double-check the DB). */
  untrackedUser: boolean;
  drift: { trade: boolean; unknownRouter: boolean; unmarkedSwap: boolean };
}

/**
 * Classify with rule R (the trader is signer #1, so no `wallet` is passed) and map to a FomoSwap row when the
 * trader is tracked. `receivedAtMs` is the blockTime fallback (transactionSubscribe carries none).
 */
export function classifyForIngest(
  tx: MiniTx,
  source: FomoSwapSource,
  isTracked: (wallet: string) => boolean,
  opts: { receivedAtMs: number; solUsd?: number | null },
): IngestClassification {
  const cls = classifyFomoTx(tx);
  const drift = {
    trade: cls.kind === "trade",
    unknownRouter: cls.kind === "trade" && cls.router === "unknown",
    unmarkedSwap: cls.kind === "not_fomo" && cls.reason === "no_marker" && isUnmarkedFomoSwap(tx),
  };
  if (cls.kind === "not_fomo") return { cls, user: null, row: null, untrackedUser: false, drift };
  const tracked = isTracked(cls.user);
  const row = tracked ? toFomoSwapRow(tx, cls, source, { receivedAtMs: opts.receivedAtMs, solUsd: opts.solUsd ?? null }) : null;
  return { cls, user: cls.user, row, untrackedUser: !tracked, drift };
}

/** Signer #1 (the would-be trader of a FOMO transaction), or null. Cheap: no classification. */
export function traderOf(tx: MiniTx): string | null {
  let n = 0;
  for (const k of tx.keys) {
    if (!k.signer) continue;
    if (n === 1) return k.pubkey;
    n++;
  }
  return null;
}
