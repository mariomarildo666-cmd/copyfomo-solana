// Turn validated trader inputs into Trader rows + ordered Follow rows.

import type { Trader } from "@prisma/client";
import { upsertTrader } from "@/lib/fomo";
import type { TraderInput } from "./schemas";
import { assertFollowableTraders, type TraderGuardOptions } from "./traderGuard";

/**
 * Check every wallet can be followed (traderGuard: no relayer / mint / program / PDA / agent wallet; finding
 * F13), then upsert one Trader row per input, in input order. Sequential on purpose: SQLite serializes writes
 * anyway, and parallel upserts on the same table just contend for the lock. Only the wallet is passed on:
 * upsertTrader copies labels from our seed file / Helius labels (never from the client), so nobody can label a
 * wallet "@someone". It records a new wallet as a candidate; the worker starts indexing it once a funded agent
 * follows it.
 */
export async function resolveTraders(inputs: readonly TraderInput[], guard: TraderGuardOptions = {}): Promise<Trader[]> {
  await assertFollowableTraders(
    inputs.map((t) => t.wallet),
    guard,
  );
  const rows: Trader[] = [];
  for (const t of inputs) {
    rows.push(await upsertTrader({ wallet: t.wallet }));
  }
  return rows;
}

/**
 * Follow rows with strictly increasing createdAt, so `orderBy createdAt` (agentInclude) returns the
 * traders in the order the owner picked them rather than an arbitrary tie order.
 */
export function followRows(traders: readonly Trader[], now = Date.now()): { traderId: string; createdAt: Date }[] {
  return traders.map((t, i) => ({ traderId: t.id, createdAt: new Date(now + i) }));
}
