// In-flight transaction journal (findings F2, F3, F4). Every transaction that moves an agent's funds is written
// here (Kv "inflight:<signature>") AFTER it is signed and BEFORE it is broadcast, together with the row it belongs
// to (CopyTrade status "sending" + signature, FeeSweep "sent", a running withdraw Command). So a restart, a crash,
// an "unconfirmed" send or a DB error after the swap landed can always be finished from the chain:
//
//   landed   → the owner module records it from the transaction's own metadata (txmeta.ts)
//   failed   → on-chain failure: the row is failed (only the network fee moved)
//   expired  → the chain passed the tx's last valid block height and history lookups can't find it: failed
//   unknown  → try again on the next pass
//
// The in-process task that sent a transaction owns its record until it returns (markActive / markDone); the
// reconcile loop only touches records nobody owns. Handlers run on the agent's serial queue.

import { prisma } from "@/lib/db";
import { connection } from "@/lib/solana";
import { errText, logger } from "./log";
import { enqueueForAgent } from "./queue";
import { EXPIRY_MARGIN_BLOCKS, finalOutcome, lookupSignature, type SignatureState } from "./send";

const log = logger("inflight");

export type InflightKind = "copy_buy" | "copy_sell" | "fee_sweep" | "withdraw";

export interface InflightRecord {
  kind: InflightKind;
  signature: string;
  agentId: string;
  /** Agent wallet (fee payer). */
  owner: string;
  /** Upper bound of the tx's last valid block height (see send.ts). */
  lastValidBlockHeight: number;
  sentAt: number;
  /** Swaps. */
  mint?: string;
  tradeId?: string;
  positionId?: string;
  traderId?: string;
  symbol?: string | null;
  decimals?: number;
  /** Reference time of the copied event (ms), for latency. */
  refMs?: number | null;
  /** Fee sweeps / withdrawals. */
  feeSweepId?: string;
  commandId?: string;
  amountSol?: number;
  to?: string;
}

export type InflightResolution = { state: "landed"; slot: number | null } | { state: "failed"; err: unknown } | { state: "expired" };

export type InflightHandler = (rec: InflightRecord, res: InflightResolution) => Promise<void>;

export const INFLIGHT_PREFIX = "inflight:";
export const inflightKey = (signature: string) => `${INFLIGHT_PREFIX}${signature}`;

/** Journal row data (for prisma.kv.create / upsert inside a caller's transaction). */
export function journalRow(rec: InflightRecord): { key: string; value: string } {
  return { key: inflightKey(rec.signature), value: JSON.stringify(rec) };
}

export async function readJournal(): Promise<InflightRecord[]> {
  const rows = await prisma.kv.findMany({ where: { key: { startsWith: INFLIGHT_PREFIX } } });
  const out: InflightRecord[] = [];
  for (const r of rows) {
    try {
      const v = JSON.parse(r.value) as InflightRecord;
      if (v && typeof v.signature === "string" && typeof v.agentId === "string") out.push(v);
    } catch {
      log.warn("unreadable journal row", { key: r.key });
    }
  }
  return out;
}

export async function dropJournal(signature: string): Promise<void> {
  await prisma.kv.deleteMany({ where: { key: inflightKey(signature) } });
}

// Signatures whose sending task is still running in this process.
const active = new Set<string>();
export function markActive(signature: string): void {
  active.add(signature);
}
export function markDone(signature: string): void {
  active.delete(signature);
}

/** Journal records not younger than this are reconciled (the sending task normally finishes first). */
const MIN_AGE_MS = 5_000;
const LOOP_MS = 10_000;

/** Resolve one record against the chain. null = not decidable yet. */
export async function resolveOnChain(rec: InflightRecord): Promise<InflightResolution | null> {
  const s: SignatureState = await lookupSignature(rec.signature);
  if (s.state === "landed") return { state: "landed", slot: s.slot };
  if (s.state === "failed") return { state: "failed", err: s.err };
  if (s.state === "unknown") return null;
  // Not found: only final once the chain is past the tx's last valid block height.
  const height = await connection().getBlockHeight("confirmed").catch(() => null);
  if (height === null || height <= rec.lastValidBlockHeight + EXPIRY_MARGIN_BLOCKS) return null;
  const final = await finalOutcome(rec.signature);
  if (final.state === "landed") return { state: "landed", slot: final.slot };
  if (final.state === "failed") return { state: "failed", err: final.err };
  if (final.state === "missing") return { state: "expired" };
  return null;
}

const queued = new Set<string>();

/**
 * One reconcile pass over the journal: records nobody in this process owns are looked up on-chain and, once
 * decidable, handed to their handler on the agent's queue. Resolves when every handler it queued has run.
 * Exported for tests and for startup.
 */
export async function reconcileInflight(handlers: Record<InflightKind, InflightHandler>, now = Date.now()): Promise<number> {
  const records = await readJournal();
  let resolved = 0;
  const runs: Promise<void>[] = [];
  for (const rec of records) {
    if (active.has(rec.signature) || queued.has(rec.signature) || now - rec.sentAt < MIN_AGE_MS) continue;
    let res: InflightResolution | null;
    try {
      res = await resolveOnChain(rec);
    } catch (err) {
      log.warn("status lookup failed", { sig: rec.signature, err: errText(err) });
      continue;
    }
    if (!res) continue;
    const handler = handlers[rec.kind];
    if (!handler) {
      log.warn("no handler for journal record; dropping", { kind: rec.kind, sig: rec.signature });
      await dropJournal(rec.signature);
      continue;
    }
    const outcome = res;
    queued.add(rec.signature);
    runs.push(
      enqueueForAgent(rec.agentId, async () => {
        // Re-check under the queue: the sending task may have finished it meanwhile.
        const still = await prisma.kv.findUnique({ where: { key: inflightKey(rec.signature) } });
        if (!still || active.has(rec.signature)) return;
        await handler(rec, outcome);
        resolved++;
        log.info("in-flight transaction resolved", { kind: rec.kind, sig: rec.signature, state: outcome.state });
      })
        .catch((err: unknown) => log.warn("in-flight handler failed; will retry", { kind: rec.kind, sig: rec.signature, err: errText(err) }))
        .finally(() => queued.delete(rec.signature)),
    );
  }
  await Promise.all(runs);
  return resolved;
}

/** Starts the reconcile loop (first pass right away). Returns a stop function. */
export function startInflightLoop(handlers: Record<InflightKind, InflightHandler>): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const tick = async () => {
    try {
      await reconcileInflight(handlers);
    } catch (err) {
      log.warn("reconcile pass failed", { err: errText(err) });
    }
    if (!stopped) timer = setTimeout(() => void tick(), LOOP_MS);
  };
  void tick();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
