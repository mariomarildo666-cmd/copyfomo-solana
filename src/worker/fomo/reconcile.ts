// Daily position reconciliation (design §4.2 reconcile), P2: for wallets ranked ≤ 100, read the on-chain token
// balances (getTokenAccountsByOwner for the Token and Token-2022 programs, 2 credits). When the chain holds less
// than an open FIFO position (tokens moved out by transfer, sold elsewhere…), the position is capped and its
// cost scaled (stats.ts applies the override until the wallet trades that mint again). Only affects open
// positions / unrealized PnL, never realized PnL or ranks.

import { z } from "zod";
import { kvGet, kvSet, prisma } from "@/lib/db";
import { canSpend, HELIUS_PRIORITY, rpc } from "@/lib/helius";
import { logger } from "../log";
import { DAY_MS, type ReconcileOverride } from "./policy";
import { safeErr } from "./state";

const log = logger("fomo-reconcile");

const RECONCILE_KV_KEY = "fomo:reconcile";
const TOP_RANK = 100;
/** Overrides older than this are ignored (the next daily run refreshes them). */
const OVERRIDE_MAX_AGE_MS = 3 * DAY_MS;
const PROGRAMS = ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"];

type StoredOverrides = Record<string, Record<string, { raw: string; at: number }>>;

const tokenAccountsSchema = z.object({ value: z.array(z.unknown()) });
const tokenAccountSchema = z.object({
  account: z.object({
    data: z.object({
      parsed: z.object({ info: z.object({ mint: z.string(), tokenAmount: z.object({ amount: z.string().regex(/^\d+$/) }) }) }),
    }),
  }),
});

async function loadStored(): Promise<StoredOverrides> {
  const row = await kvGet<unknown>(RECONCILE_KV_KEY).catch(() => null);
  const v = row?.value;
  return v && typeof v === "object" && !Array.isArray(v) ? (v as StoredOverrides) : {};
}

/** Fresh overrides by wallet → mint (read by the stats job). */
export async function loadReconcileOverrides(): Promise<Map<string, Map<string, ReconcileOverride>>> {
  const stored = await loadStored();
  const now = Date.now();
  const out = new Map<string, Map<string, ReconcileOverride>>();
  for (const [wallet, mints] of Object.entries(stored)) {
    if (!mints || typeof mints !== "object") continue;
    const m = new Map<string, ReconcileOverride>();
    for (const [mint, o] of Object.entries(mints)) {
      if (!o || typeof o.raw !== "string" || !/^\d+$/.test(o.raw) || typeof o.at !== "number" || now - o.at > OVERRIDE_MAX_AGE_MS) continue;
      m.set(mint, { raw: BigInt(o.raw), atMs: o.at });
    }
    if (m.size > 0) out.set(wallet, m);
  }
  return out;
}

async function onchainBalances(owner: string): Promise<Map<string, bigint>> {
  const out = new Map<string, bigint>();
  for (const programId of PROGRAMS) {
    const res = await rpc<unknown>("getTokenAccountsByOwner", [owner, { programId }, { encoding: "jsonParsed", commitment: "confirmed" }], {
      priority: HELIUS_PRIORITY.backfill,
    });
    const parsed = tokenAccountsSchema.safeParse(res);
    if (!parsed.success) throw new Error("getTokenAccountsByOwner: unexpected result shape");
    for (const item of parsed.data.value) {
      const a = tokenAccountSchema.safeParse(item);
      if (!a.success) continue;
      const { mint, tokenAmount } = a.data.account.data.parsed.info;
      out.set(mint, (out.get(mint) ?? BigInt(0)) + BigInt(tokenAmount.amount));
    }
  }
  return out;
}

export async function reconcileDaily(): Promise<void> {
  const ranked = await prisma.fomoWalletStats.findMany({ where: { rank: { lte: TOP_RANK } }, select: { wallet: true }, distinct: ["wallet"] });
  const stored: StoredOverrides = {};
  let capped = 0;
  let checked = 0;
  for (const { wallet } of ranked) {
    const positions = await prisma.fomoPosition.findMany({ where: { wallet }, select: { mint: true, rawAmount: true } });
    if (positions.length === 0) continue;
    if (!canSpend(HELIUS_PRIORITY.backfill, PROGRAMS.length)) {
      log.info("reconciliation paused by the daily credit cap", { checked });
      break;
    }
    let balances: Map<string, bigint>;
    try {
      balances = await onchainBalances(wallet);
    } catch (err) {
      log.debug("balance read failed", { wallet, err: safeErr(err) });
      continue;
    }
    checked++;
    const now = Date.now();
    for (const p of positions) {
      const onchain = balances.get(p.mint) ?? BigInt(0);
      if (onchain < BigInt(p.rawAmount)) {
        (stored[wallet] ??= {})[p.mint] = { raw: onchain.toString(), at: now };
        capped++;
      }
    }
    if (stored[wallet]) await prisma.fomoWallet.updateMany({ where: { wallet }, data: { statsDirty: true } });
  }
  await kvSet(RECONCILE_KV_KEY, stored);
  log.info("positions reconciled with on-chain balances", { wallets: checked, capped });
}
