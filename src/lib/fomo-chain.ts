// FOMO trade detection from public Solana data (design §2). No FOMO API is used.
//
// Rule R — a transaction is a FOMO trade when ALL hold:
//   1. it succeeded;
//   2. the fee payer (keys[0]) is FOMO's gas relayer;
//   3. it has exactly two signers: [relayer, trader];
//   4. FOMO's marker account is in the FULL account list (static + address-lookup-table keys);
//   5. the trader's balances moved USDC against exactly one token (second-token dust tolerated).
// SOL⇄USDC conversions are "convert" and relayer-paid Relay deposits are "xchain": neither is ever a trade.
// The marker only exists since 2026-01-06 (FOMO_MARKER_SINCE): never apply rule R to older history.
//
// Pure parts (normalizeTx / classifyFomoTx / logsLookLikeFomoCandidate / toFomoSwapRow) are shared by the
// worker indexer and the copy-engine watcher. checkFomoActivity is the one networked helper (pasted wallets).

import { config } from "./config";
import { prisma } from "./db";
import {
  getCachedCaps,
  getSignatures,
  getTransaction,
  getTransactionsForAddress,
  HELIUS_CREDITS,
  HELIUS_PRIORITY,
  canSpend,
  heliusConfigured,
  isHeliusError,
  meter,
} from "./helius";
import { isValidSolanaAddress, SOL_MINT, USDC_MINT, USDT_MINT } from "./solana";

// ── Constants (§2.1) ────────────────────────────────────────────────────────────────────────────────

export type FomoRouter = "dflow" | "jupiter" | "okx" | "fomo_legacy" | "unknown";

/** FOMO's gas relayer (fee payer, signer #0). Override with FOMO_RELAYERS to hot-fix a change. */
export const FOMO_RELAYERS: readonly string[] = Object.freeze([...config.fomoRelayers]);
/** FOMO's trade marker account (read-only, usually loaded from a lookup table). Override with FOMO_MARKERS. */
export const FOMO_MARKERS: readonly string[] = Object.freeze([...config.fomoMarkers]);
/** Primary relayer / marker, for subscription filters. */
export const FOMO_RELAYER: string = FOMO_RELAYERS[0]!;
export const FOMO_MARKER: string = FOMO_MARKERS[0]!;
/** Rule R is invalid before this (the marker did not exist): never backfill earlier. */
export const FOMO_MARKER_SINCE = Date.parse("2026-01-06T00:00:00Z");

/** Swap routers seen in FOMO trades. Recorded and monitored, never a gate. */
export const FOMO_ROUTERS: Readonly<Record<string, Exclude<FomoRouter, "unknown">>> = Object.freeze({
  DF1ow4tspfHX9JwWJsAb9epbkA8hmpSEAtxXy1V27QBH: "dflow",
  JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4: "jupiter",
  proVF4pMXVaYqmy4NjniPh4pqKNfMmsihgd4wdkCX3u: "okx",
  "6m2CDdhRgxpH4WjvdzxAYbGxwdGUz5MziiL5jek2kBma": "fomo_legacy",
});
/** Relay bridge depository: relayer-paid deposits here are cross-chain FOMO orders ("xchain"). */
export const RELAY_DEPOSITORY = "99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2";
/** FOMO's fee treasury and its USDC account. Informational only — never polled, never a gate. */
export const FOMO_FEE_WALLET = "R4rNJHaffSUotNmqSKNEfDcJE8A7zJUkaoM5Jkd7cYX";
export const FOMO_FEE_USDC_ATA = "HrTf9CzXR1dRH4Sof5QrpmGWwpwAf3qZzwCsEjQpXcSq";

/** Below 0.01 USDC the USDC leg is noise ("no_usdc_leg"). */
export const MIN_USDC_RAW = BigInt(10_000);
/** A SOL⇄USDC conversion must move at least 0.001 SOL. */
export const MIN_CONVERT_LAMPORTS = BigInt(1_000_000);
/** A second token that moved ≤ 1e-5 × the primary amount is leftover dust. */
export const DUST_RATIO = 1e-5;
export const USDC_DECIMALS = 6;
export const SOL_DECIMALS = 9;

// ── Normalization (§2.2) ────────────────────────────────────────────────────────────────────────────

export interface MiniTokenBalance {
  accountIndex: number;
  mint: string;
  owner: string | null;
  /** Raw base units (integer string). */
  raw: string;
  decimals: number;
}

export interface MiniTx {
  signature: string;
  slot: number | null;
  txIndex: number | null;
  /** null for transactionSubscribe payloads → callers use their receive time. */
  blockTimeMs: number | null;
  err: unknown | null;
  /** Static AND lookup-table keys, in message order (aligned with the lamport arrays). */
  keys: { pubkey: string; signer: boolean }[];
  preLamports: number[];
  postLamports: number[];
  preToken: MiniTokenBalance[];
  postToken: MiniTokenBalance[];
}

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const finiteOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function pubkeyString(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (isObj(v) && typeof (v as { toBase58?: unknown }).toBase58 === "function") {
    const s = (v as { toBase58: () => unknown }).toBase58();
    return typeof s === "string" ? s : null;
  }
  return null;
}

function numberArray(v: unknown): number[] | null {
  if (!Array.isArray(v)) return null;
  const out: number[] = [];
  for (const x of v) {
    if (typeof x !== "number" || !Number.isFinite(x)) return null;
    out.push(x);
  }
  return out;
}

function tokenBalances(v: unknown): MiniTokenBalance[] | null {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) return null;
  const out: MiniTokenBalance[] = [];
  for (const b of v) {
    if (!isObj(b) || typeof b.accountIndex !== "number" || typeof b.mint !== "string") return null;
    const ui = b.uiTokenAmount;
    if (!isObj(ui) || typeof ui.amount !== "string" || !/^\d+$/.test(ui.amount) || typeof ui.decimals !== "number") return null;
    out.push({
      accountIndex: b.accountIndex,
      mint: b.mint,
      owner: typeof b.owner === "string" ? b.owner : null,
      raw: ui.amount,
      decimals: ui.decimals,
    });
  }
  return out;
}

/** Keys from a jsonParsed / "accounts" list ({pubkey, signer}), or a plain "json" list + header + loadedAddresses. */
function accountKeys(inner: Obj, meta: Obj): MiniTx["keys"] | null {
  const message = isObj(inner.message) ? inner.message : null;
  const list = (message?.accountKeys ?? inner.accountKeys) as unknown;
  if (!Array.isArray(list) || list.length === 0) return null;

  if (list.every((k) => isObj(k))) {
    const keys: MiniTx["keys"] = [];
    for (const k of list as Obj[]) {
      const pubkey = pubkeyString(k.pubkey);
      if (!pubkey) return null;
      keys.push({ pubkey, signer: k.signer === true });
    }
    return keys;
  }

  // encoding "json": string keys; signers are the first header.numRequiredSignatures; lookup keys in meta.
  if (!list.every((k) => typeof k === "string")) return null;
  const header = message && isObj(message.header) ? message.header : null;
  const nSigners = header && typeof header.numRequiredSignatures === "number" ? header.numRequiredSignatures : 0;
  const keys = (list as string[]).map((pubkey, i) => ({ pubkey, signer: i < nSigners }));
  const loaded = isObj(meta.loadedAddresses) ? meta.loadedAddresses : null;
  for (const group of [loaded?.writable, loaded?.readonly]) {
    if (!Array.isArray(group)) continue;
    for (const pk of group) if (typeof pk === "string") keys.push({ pubkey: pk, signer: false });
  }
  return keys;
}

/**
 * Normalize any transaction payload we receive into a MiniTx, or null when it is not a usable
 * transaction (missing meta, malformed balances, keys not aligned with balances). Accepts:
 *  - getTransaction (jsonParsed, maxSupportedTransactionVersion 1), bare or inside a JSON-RPC {result}
 *  - a getTransactionsForAddress "full" item (+ transactionIndex; signature at transaction.signatures[0])
 *  - a transactionSubscribe notification (whole message, or its params.result), "full" or "accounts" details
 *  - web3.js ParsedTransactionWithMeta (PublicKey objects)
 */
export function normalizeTx(x: unknown): MiniTx | null {
  let r: unknown = x;
  if (isObj(r) && isObj(r.params) && isObj(r.params.result)) r = r.params.result; // notification message
  if (isObj(r) && !("transaction" in r) && isObj(r.result)) r = r.result; // JSON-RPC envelope
  if (!isObj(r) || !isObj(r.transaction)) return null;

  let inner: Obj;
  let meta: unknown;
  if (isObj(r.transaction.transaction)) {
    // transactionSubscribe: result.transaction = { transaction, meta, version }
    inner = r.transaction.transaction;
    meta = r.transaction.meta;
  } else {
    inner = r.transaction;
    meta = r.meta;
  }
  if (!isObj(meta)) return null;

  const sigs = Array.isArray(inner.signatures) ? inner.signatures : [];
  const signature = typeof r.signature === "string" ? r.signature : typeof sigs[0] === "string" ? sigs[0] : null;
  if (!signature) return null;

  const keys = accountKeys(inner, meta);
  const preLamports = numberArray(meta.preBalances);
  const postLamports = numberArray(meta.postBalances);
  const preToken = tokenBalances(meta.preTokenBalances);
  const postToken = tokenBalances(meta.postTokenBalances);
  if (!keys || !preLamports || !postLamports || !preToken || !postToken) return null;
  if (preLamports.length !== keys.length || postLamports.length !== keys.length) return null;

  const blockTime = finiteOrNull(r.blockTime);
  return {
    signature,
    slot: finiteOrNull(r.slot),
    txIndex: finiteOrNull(r.transactionIndex),
    blockTimeMs: blockTime !== null ? blockTime * 1000 : null,
    err: meta.err === undefined ? null : meta.err,
    keys,
    preLamports,
    postLamports,
    preToken,
    postToken,
  };
}

// ── Rule R (§2.3) ───────────────────────────────────────────────────────────────────────────────────

export type NotFomoReason =
  | "failed"
  | "fee_payer"
  | "signers"
  | "other_user"
  | "no_marker"
  | "multi_token"
  | "no_usdc_leg"
  | "same_direction"
  | "no_token_leg";

export type FomoClass =
  | { kind: "trade"; user: string; side: "buy" | "sell"; mint: string; tokenRaw: bigint; decimals: number; usdcRaw: bigint; router: FomoRouter }
  | { kind: "convert"; user: string; direction: "sol_to_usdc" | "usdc_to_sol"; usdcRaw: bigint; lamports: bigint; router: FomoRouter }
  | { kind: "xchain"; user: string; usdcRaw: bigint }
  | { kind: "not_fomo"; reason: NotFomoReason };

export type FomoTrade = Extract<FomoClass, { kind: "trade" }>;

const abs = (v: bigint) => (v < BigInt(0) ? -v : v);

/**
 * Classify a normalized transaction with rule R. `wallet` (optional) must be the trader (signer #1),
 * otherwise "other_user". Returned amounts are absolute values; `side` / `direction` carry the sign.
 */
export function classifyFomoTx(tx: MiniTx, wallet?: string): FomoClass {
  const ZERO = BigInt(0);
  if (tx.err !== null && tx.err !== undefined) return { kind: "not_fomo", reason: "failed" };

  const feePayer = tx.keys[0]?.pubkey;
  if (!feePayer || !FOMO_RELAYERS.includes(feePayer)) return { kind: "not_fomo", reason: "fee_payer" };

  const signers = tx.keys.filter((k) => k.signer).map((k) => k.pubkey);
  if (signers.length !== 2 || signers[0] !== feePayer || signers[1] === feePayer) return { kind: "not_fomo", reason: "signers" };
  const user = signers[1]!;
  if (wallet !== undefined && user !== wallet) return { kind: "not_fomo", reason: "other_user" };

  // Trader balance changes per mint: Σ(post) − Σ(pre) over every token account the trader owns.
  const delta = new Map<string, bigint>();
  const decimals = new Map<string, number>();
  for (const [list, sign] of [
    [tx.preToken, BigInt(-1)],
    [tx.postToken, BigInt(1)],
  ] as const) {
    for (const b of list) {
      if (b.owner !== user) continue;
      delta.set(b.mint, (delta.get(b.mint) ?? ZERO) + sign * BigInt(b.raw));
      decimals.set(b.mint, b.decimals);
    }
  }
  const usdc = delta.get(USDC_MINT) ?? ZERO;
  const uiAmount = (mint: string) => Number(delta.get(mint) ?? ZERO) / 10 ** (decimals.get(mint) ?? 0);
  // USDT is a stable leg, not a traded token: a FOMO USDT→USDC deposit conversion is never a "trade" (no_token_leg).
  let tokens = [...delta.entries()]
    .filter(([mint, v]) => mint !== USDC_MINT && mint !== SOL_MINT && mint !== USDT_MINT && v !== ZERO)
    .map(([mint]) => mint)
    .sort((a, b) => Math.abs(uiAmount(b)) - Math.abs(uiAmount(a)));

  const hasKey = (pk: string) => tx.keys.some((k) => k.pubkey === pk);

  if (!tx.keys.some((k) => FOMO_MARKERS.includes(k.pubkey))) {
    if (hasKey(RELAY_DEPOSITORY) && usdc < ZERO && tokens.length === 0) return { kind: "xchain", user, usdcRaw: -usdc };
    return { kind: "not_fomo", reason: "no_marker" };
  }

  let router: FomoRouter = "unknown";
  for (const k of tx.keys) {
    const r = FOMO_ROUTERS[k.pubkey];
    if (r) {
      router = r;
      break;
    }
  }

  if (tokens.length > 1) {
    const primary = Math.abs(uiAmount(tokens[0]!));
    if (tokens.slice(1).every((m) => Math.abs(uiAmount(m)) <= DUST_RATIO * primary)) tokens = [tokens[0]!];
    else return { kind: "not_fomo", reason: "multi_token" };
  }

  if (abs(usdc) < MIN_USDC_RAW) return { kind: "not_fomo", reason: "no_usdc_leg" };

  if (tokens.length === 1) {
    const mint = tokens[0]!;
    const v = delta.get(mint)!;
    const dec = decimals.get(mint) ?? 0;
    if (v > ZERO && usdc < ZERO) return { kind: "trade", user, side: "buy", mint, tokenRaw: v, decimals: dec, usdcRaw: -usdc, router };
    if (v < ZERO && usdc > ZERO) return { kind: "trade", user, side: "sell", mint, tokenRaw: -v, decimals: dec, usdcRaw: usdc, router };
    return { kind: "not_fomo", reason: "same_direction" };
  }

  const ui = tx.keys.findIndex((k) => k.pubkey === user);
  const lamports = ui >= 0 ? BigInt(tx.postLamports[ui]! - tx.preLamports[ui]!) : ZERO;
  const sol = lamports + (delta.get(SOL_MINT) ?? ZERO);
  if (sol >= MIN_CONVERT_LAMPORTS && usdc < ZERO) return { kind: "convert", user, direction: "usdc_to_sol", usdcRaw: -usdc, lamports: sol, router };
  if (sol <= -MIN_CONVERT_LAMPORTS && usdc > ZERO) return { kind: "convert", user, direction: "sol_to_usdc", usdcRaw: usdc, lamports: -sol, router };
  return { kind: "not_fomo", reason: "no_token_leg" };
}

/** Relayer-paid, two-signer, marker present — i.e. FOMO built it (used by drift monitoring). */
export function hasFomoFingerprint(tx: MiniTx): boolean {
  const signers = tx.keys.filter((k) => k.signer);
  return (
    FOMO_RELAYERS.includes(tx.keys[0]?.pubkey ?? "") &&
    signers.length === 2 &&
    tx.keys.some((k) => FOMO_MARKERS.includes(k.pubkey))
  );
}

/**
 * Drift signal (§2.7 noMarkerSwaps1h): relayer-paid, two-signer and swap-shaped (USDC vs one token) but
 * WITHOUT the marker. Baseline since 2026-01-06 is 0 — a rise means FOMO may have changed its marker.
 */
export function isUnmarkedFomoSwap(tx: MiniTx): boolean {
  const cls = classifyFomoTx(tx);
  if (cls.kind !== "not_fomo" || cls.reason !== "no_marker") return false;
  const withMarker: MiniTx = {
    ...tx,
    keys: [...tx.keys, { pubkey: FOMO_MARKER, signer: false }],
    preLamports: [...tx.preLamports, 0],
    postLamports: [...tx.postLamports, 0],
  };
  return classifyFomoTx(withMarker).kind === "trade";
}

// ── Log pre-filter (§2.3) ───────────────────────────────────────────────────────────────────────────

const CANDIDATE_PROGRAMS = [...Object.keys(FOMO_ROUTERS), RELAY_DEPOSITORY];
const CANDIDATE_LOG_RE = new RegExp(`^Program (${CANDIDATE_PROGRAMS.join("|")}) invoke`);

/**
 * True when a logsNotification's lines show a FOMO router or the Relay depository being invoked — i.e.
 * the transaction is worth a getTransaction to run rule R on. False for plain transfers, spam, etc.
 */
export function logsLookLikeFomoCandidate(logs: readonly string[] | null | undefined): boolean {
  if (!logs) return false;
  for (const line of logs) if (CANDIDATE_LOG_RE.test(line)) return true;
  return false;
}

// ── FomoSwap row mapping ────────────────────────────────────────────────────────────────────────────

export type FomoSwapSource = "stream" | "logs" | "backfill" | "gapfill" | "sample" | "watcher" | "check";

/** Shape of a Prisma FomoSwap create input (kept structural so this file needs no Prisma types). */
export interface FomoSwapRow {
  signature: string;
  wallet: string;
  slot: number;
  txIndex: number | null;
  blockTime: Date;
  kind: "buy" | "sell" | "convert" | "xchain";
  mint: string;
  tokenRaw: string;
  decimals: number;
  usd: number;
  solUsd: number | null;
  router: string;
  direction: "sol_to_usdc" | "usdc_to_sol" | null;
  source: FomoSwapSource;
}

/**
 * Map a classified trade / convert / xchain to a FomoSwap row (null for not_fomo or a missing slot).
 * blockTime = tx blockTime, else `receivedAtMs` (transactionSubscribe carries no blockTime).
 * usd = |USDC change| (includes FOMO's fee). convert: mint WSOL, tokenRaw = lamports. xchain: mint USDC, router "relay".
 */
export function toFomoSwapRow(
  tx: MiniTx,
  cls: FomoClass,
  source: FomoSwapSource,
  opts: { receivedAtMs?: number; solUsd?: number | null } = {},
): FomoSwapRow | null {
  if (cls.kind === "not_fomo" || tx.slot === null) return null;
  const blockTime = new Date(tx.blockTimeMs ?? opts.receivedAtMs ?? Date.now());
  const base = { signature: tx.signature, wallet: cls.user, slot: tx.slot, txIndex: tx.txIndex, blockTime, solUsd: opts.solUsd ?? null, source };
  const usd = Number(cls.usdcRaw) / 10 ** USDC_DECIMALS;
  switch (cls.kind) {
    case "trade":
      return { ...base, kind: cls.side, mint: cls.mint, tokenRaw: cls.tokenRaw.toString(), decimals: cls.decimals, usd, router: cls.router, direction: null };
    case "convert":
      return { ...base, kind: "convert", mint: SOL_MINT, tokenRaw: cls.lamports.toString(), decimals: SOL_DECIMALS, usd, router: cls.router, direction: cls.direction };
    case "xchain":
      return { ...base, kind: "xchain", mint: USDC_MINT, tokenRaw: cls.usdcRaw.toString(), decimals: USDC_DECIMALS, usd, router: "relay", direction: null };
  }
}

// ── On-demand check for pasted wallets (§3.4) ──────────────────────────────────────────────────────

export interface FomoActivityResult {
  /** "found": a FOMO trade was seen · "none": none in recent history · "unavailable": no key / over budget / rate-limited / error. */
  status: "found" | "none" | "unavailable";
  /** Answered from FomoWallet (evidence or a check < 6 h old) without calling Helius. */
  cached: boolean;
  evidenceSig: string | null;
  /** FOMO trades seen in the sampled transactions (0 when cached). */
  trades: number;
  lastTradeAt: Date | null;
  checkedAt: Date | null;
}

export const CHECK_TTL_MS = 6 * 3600_000;
const CHECK_SIG_LIMIT = 25;
const CHECK_TX_LIMIT = 8;
const CHECK_RPC_CREDITS = 1 + CHECK_TX_LIMIT;

async function sampleViaGtfa(wallet: string): Promise<MiniTx[]> {
  const page = await getTransactionsForAddress(wallet, {
    priority: HELIUS_PRIORITY.identity,
    transactionDetails: "full",
    limit: CHECK_SIG_LIMIT,
    filters: { status: "succeeded" },
  });
  return page.data.map(normalizeTx).filter((t): t is MiniTx => t !== null);
}

async function sampleViaRpc(wallet: string): Promise<MiniTx[]> {
  const sigs = await getSignatures(wallet, { priority: HELIUS_PRIORITY.identity, limit: CHECK_SIG_LIMIT });
  const picks = sigs
    .filter((s) => (s.err === null || s.err === undefined) && (s.blockTime === null || s.blockTime * 1000 >= FOMO_MARKER_SINCE))
    .slice(0, CHECK_TX_LIMIT);
  const out: MiniTx[] = [];
  for (const s of picks) {
    const raw = await getTransaction(s.signature, { priority: HELIUS_PRIORITY.identity });
    const tx = raw ? normalizeTx(raw) : null;
    if (tx) out.push(tx);
  }
  return out;
}

/**
 * Does this wallet trade on FOMO? Answers from FomoWallet when it has evidence or was checked < 6 h ago;
 * otherwise samples its recent history through Helius at P4 (gTFA full, 25 tx ≈ 10 credits, when the
 * cached caps say gTFA works; else getSignaturesForAddress(25) + ≤ 8 getTransaction ≈ 9 credits),
 * classifies it with rule R and records the outcome on FomoWallet (created as origin "user",
 * status "candidate" when new). Counts against the global daily lookup cap (HeliusUsage.lookupChecks).
 * `beforeNetwork` runs right before Helius is called (e.g. a per-IP rate limit that may throw).
 * Never throws for Helius problems: those return "unavailable" (and are not cached).
 */
export async function checkFomoActivity(
  wallet: string,
  opts: { force?: boolean; beforeNetwork?: () => void } = {},
): Promise<FomoActivityResult> {
  if (!isValidSolanaAddress(wallet)) throw new Error(`checkFomoActivity: invalid wallet "${wallet}"`);
  const now = Date.now();
  const row = await prisma.fomoWallet.findUnique({ where: { wallet } });

  if (!opts.force && row) {
    if (row.evidenceSig) {
      return { status: "found", cached: true, evidenceSig: row.evidenceSig, trades: 0, lastTradeAt: row.lastTradeAt, checkedAt: row.checkedAt };
    }
    if (row.checkedAt && now - row.checkedAt.getTime() < CHECK_TTL_MS) {
      return { status: "none", cached: true, evidenceSig: null, trades: 0, lastTradeAt: row.lastTradeAt, checkedAt: row.checkedAt };
    }
  }

  const unavailable: FomoActivityResult = {
    status: "unavailable",
    cached: false,
    evidenceSig: null,
    trades: 0,
    lastTradeAt: row?.lastTradeAt ?? null,
    checkedAt: row?.checkedAt ?? null,
  };
  if (!heliusConfigured()) return unavailable;
  await meter.sync();
  if (meter.lookupChecksToday() >= config.fomoLookupChecksPerDay) return unavailable;

  const caps = await getCachedCaps();
  const useGtfa = caps?.gtfa === true;
  if (!canSpend(HELIUS_PRIORITY.identity, useGtfa ? HELIUS_CREDITS.gtfa : CHECK_RPC_CREDITS)) return unavailable;

  opts.beforeNetwork?.();
  meter.recordLookupCheck();

  let txs: MiniTx[];
  try {
    try {
      txs = useGtfa ? await sampleViaGtfa(wallet) : await sampleViaRpc(wallet);
    } catch (err) {
      // gTFA refused (plan change, bad filter…): fall back to plain RPC once.
      if (!useGtfa || !isHeliusError(err, "rpc", "http", "invalid_response")) throw err;
      txs = await sampleViaRpc(wallet);
    }
  } catch (err) {
    console.warn(`[fomo-chain] activity check failed for ${wallet}: ${err instanceof Error ? err.message : String(err)}`);
    return unavailable;
  }

  let evidenceSig: string | null = null;
  let lastTradeMs: number | null = null;
  let trades = 0;
  for (const tx of txs) {
    const cls = classifyFomoTx(tx, wallet);
    if (cls.kind !== "trade") continue;
    trades++;
    evidenceSig ??= tx.signature;
    if (tx.blockTimeMs !== null && (lastTradeMs === null || tx.blockTimeMs > lastTradeMs)) lastTradeMs = tx.blockTimeMs;
  }

  const checkedAt = new Date(now);
  const lastTradeAt = lastTradeMs !== null ? new Date(lastTradeMs) : null;
  const newerLastTrade = lastTradeAt && (!row?.lastTradeAt || lastTradeAt > row.lastTradeAt) ? lastTradeAt : undefined;
  await prisma.fomoWallet.upsert({
    where: { wallet },
    create: { wallet, origin: "user", status: "candidate", checkedAt, evidenceSig, lastTradeAt },
    update: { checkedAt, ...(evidenceSig && !row?.evidenceSig ? { evidenceSig } : {}), ...(newerLastTrade ? { lastTradeAt: newerLastTrade } : {}) },
  });

  return {
    status: evidenceSig ? "found" : "none",
    cached: false,
    evidenceSig: evidenceSig ?? row?.evidenceSig ?? null,
    trades,
    lastTradeAt: newerLastTrade ?? row?.lastTradeAt ?? lastTradeAt,
    checkedAt,
  };
}
