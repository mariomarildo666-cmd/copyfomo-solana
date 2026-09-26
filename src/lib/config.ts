// Server-side configuration. Read once, validated, frozen.
// Used by both the Next.js server (API routes) and the worker (`npm run worker`).
// Never import this from a client component.

import bs58 from "bs58";
import type { Mode } from "./types";

function str(name: string, fallback = ""): string {
  const v = process.env[name];
  return v === undefined || v.trim() === "" ? fallback : v.trim();
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`Env ${name} must be a number, got "${raw}"`);
  return n;
}

function oneOf<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
  const v = str(name, fallback).toLowerCase();
  if (!(allowed as readonly string[]).includes(v)) {
    throw new Error(`${name} must be one of ${allowed.map((a) => `"${a}"`).join(", ")}, got "${v}"`);
  }
  return v as T;
}

const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Comma/space separated list of base58 addresses; empty → fallback. Hotfix overrides for FOMO's fingerprint. */
function addressList(name: string, fallback: readonly string[]): string[] {
  const raw = str(name, "");
  if (!raw) return [...fallback];
  const items = raw.split(/[\s,]+/).filter(Boolean);
  for (const item of items) {
    if (!BASE58_ADDRESS.test(item)) throw new Error(`${name}: "${item}" is not a base58 Solana address`);
  }
  return [...new Set(items)];
}

const mode = str("COPYFOMO_MODE", "paper");
if (mode !== "paper" && mode !== "live") {
  throw new Error(`COPYFOMO_MODE must be "paper" or "live", got "${mode}"`);
}

/** Base58 that decodes to exactly 32 bytes (a Solana address). config.ts can't import solana.ts (cycle). */
function isAddress(s: string): boolean {
  if (!BASE58_ADDRESS.test(s)) return false;
  try {
    return bs58.decode(s).length === 32;
  } catch {
    return false;
  }
}

/** Optional base58 Solana address; "" when unset. A malformed value is a startup error, never silently ignored. */
function address(name: string): string {
  const v = str(name, "");
  if (v && !isAddress(v)) throw new Error(`${name} must be a base58 Solana address, got "${v}"`);
  return v;
}

function intInRange(name: string, fallback: number, min: number, max: number): number {
  const n = num(name, fallback);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${name} must be an integer in ${min}..${max}, got "${process.env[name]}"`);
  }
  return n;
}

// ── Process role (seal-key split, finding F11) ─────────────────────────────────────────────────────
// Next.js replaces `process.env.NEXT_RUNTIME` in every server bundle ("nodejs" | "edge"); the worker (tsx)
// and scripts never have it. The web process must NEVER hold WALLET_SEAL_PRIVATE_KEY: it would sit in
// process.env, in config, and in Turbopack's persisted env snapshots under .next/cache. Keep the private key
// in `.env.worker` (Next.js never loads that file; `npm run worker` does).
export const IS_NEXT_SERVER = typeof process.env.NEXT_RUNTIME === "string" && process.env.NEXT_RUNTIME !== "";

function sealPrivateKey(): string {
  const v = str("WALLET_SEAL_PRIVATE_KEY", "");
  if (!IS_NEXT_SERVER) return v;
  if (v) {
    // Scrub it from this process either way; refuse to serve in live mode (fail closed).
    delete process.env.WALLET_SEAL_PRIVATE_KEY;
    const msg =
      "WALLET_SEAL_PRIVATE_KEY is set in the web process environment. Only the worker may hold it: move it to " +
      ".env.worker (npm run worker loads that file; Next.js never does), delete .next/cache (it snapshots env) " +
      "and rebuild.";
    if (mode === "live") throw new Error(`FATAL: ${msg}`);
    console.error(`[config] ${msg} Ignored in paper mode: the web process will not use it.`);
  }
  return "";
}

// ── Client IP source for per-IP rate limits (finding F27) ──────────────────────────────────────────
export type TrustedIpSource = "xff" | "x-real-ip" | "cf-connecting-ip" | "x-vercel-forwarded-for" | "fly-client-ip" | "none";

// ── Jupiter rate budget (finding F24) ──────────────────────────────────────────────────────────────
const jupiterUrl = str("JUPITER_API_URL", "https://lite-api.jup.ag");
const jupiterApiKey = str("JUPITER_API_KEY", "");
const JUPITER_LITE = /(^|\/\/)lite-api\.jup\.ag/i;
/**
 * Default request budget per process. Measured / documented (2026-09): keyless api.jup.ag ≈ 5 requests per
 * 10 s, a free key 1 RPS; lite-api (being retired progressively) currently tolerates bursts. Set JUPITER_RPS /
 * JUPITER_BURST for a paid tier.
 */
const jupiterDefaults = JUPITER_LITE.test(jupiterUrl)
  ? { rps: 10, burst: 20 }
  : jupiterApiKey
    ? { rps: 1, burst: 10 }
    : { rps: 0.5, burst: 5 };

// ── Helius plan profiles (design §5.1). The plan sets budgets; features are probed at startup. ──────────
export type HeliusPlan = "free" | "developer" | "business";
export type FomoDiscovery = "off" | "sample" | "stream";

interface PlanProfile {
  maxTracked: number;
  /** Backfill window without / with getTransactionsForAddress (gTFA). */
  backfillDays: number;
  backfillDaysGtfa: number;
  /** Per-wallet backfill cap in transactions (Free 2,000; paid 80 pages × 100). */
  backfillMaxTx: number;
  promotePerDay: number;
  promoteMinHits: number;
  dailyCreditCap: number;
  rps: number;
  concurrency: number;
  discovery: FomoDiscovery;
  sampleIntervalMs: number;
  /** Global cap on uncached pasted-wallet checks per UTC day. */
  lookupChecksPerDay: number;
  /** Daily Helius batch-identity labels (paid plans only). */
  identity: boolean;
}

const PLAN_PROFILES: Record<HeliusPlan, PlanProfile> = {
  free: {
    maxTracked: 80,
    backfillDays: 7,
    backfillDaysGtfa: 37,
    backfillMaxTx: 2_000,
    promotePerDay: 3,
    promoteMinHits: 2,
    dailyCreditCap: 30_000,
    rps: 8,
    concurrency: 4,
    discovery: "sample",
    sampleIntervalMs: 30 * 60_000,
    lookupChecksPerDay: 300,
    identity: false,
  },
  developer: {
    maxTracked: 2_000,
    backfillDays: 37,
    backfillDaysGtfa: 37,
    backfillMaxTx: 8_000,
    promotePerDay: 50,
    promoteMinHits: 3,
    dailyCreditCap: 300_000,
    rps: 40,
    concurrency: 12,
    discovery: "sample",
    sampleIntervalMs: 60_000,
    lookupChecksPerDay: 3_000,
    identity: true,
  },
  business: {
    maxTracked: 10_000,
    backfillDays: 37,
    backfillDaysGtfa: 37,
    backfillMaxTx: 8_000,
    promotePerDay: 200,
    promoteMinHits: 3,
    dailyCreditCap: 3_000_000,
    rps: 150,
    concurrency: 32,
    discovery: "stream",
    sampleIntervalMs: 60_000,
    lookupChecksPerDay: 3_000,
    identity: true,
  },
};

const heliusPlan = oneOf<HeliusPlan>("HELIUS_PLAN", ["free", "developer", "business"], "free");
const plan = PLAN_PROFILES[heliusPlan];
const backfillDaysEnv = str("FOMO_BACKFILL_DAYS", "") ? num("FOMO_BACKFILL_DAYS", plan.backfillDays) : null;

export const config = Object.freeze({
  mode: mode as Mode,

  /** Public site URL, used for absolute links. */
  siteUrl: str("NEXT_PUBLIC_SITE_URL", "http://localhost:3000"),

  // ── Solana ────────────────────────────────────────────────────────────
  /** HTTP RPC. Public mainnet works for light use; use Helius/Triton/QuickNode for real traffic. */
  rpcUrl: str("SOLANA_RPC_URL", "https://api.mainnet-beta.solana.com"),
  /** WebSocket RPC for logsSubscribe. Derived from rpcUrl when empty. */
  wsUrl: str("SOLANA_WS_URL", ""),

  // ── Jupiter (swaps, prices, token metadata) ───────────────────────────
  jupiterUrl,
  jupiterApiKey,
  /** Process-wide Jupiter token bucket: quotes, swap builds, prices and token metadata share one budget. */
  jupiterRps: Math.max(0.05, num("JUPITER_RPS", jupiterDefaults.rps)),
  jupiterBurst: Math.max(1, Math.floor(num("JUPITER_BURST", jupiterDefaults.burst))),
  /** Absolute priority fee cap per swap in lamports. */
  maxPriorityFeeLamports: num("MAX_PRIORITY_FEE_LAMPORTS", 2_000_000),
  /**
   * Size-relative priority fee cap (finding F23): a swap pays at most this share of its SOL size in priority
   * fees (buys: SOL in; sells: expected SOL out, doubled so exits still land), never below the floor and never
   * above maxPriorityFeeLamports.
   */
  priorityFeeMaxBps: intInRange("PRIORITY_FEE_MAX_BPS", 500, 1, 10_000),
  priorityFeeFloorLamports: Math.max(0, Math.floor(num("PRIORITY_FEE_FLOOR_LAMPORTS", 50_000))),
  /** Smallest live copy buy worth sending: network fees and ATA rent dominate below this. Paper keeps 0.001. */
  minLiveTradeSol: Math.max(0.001, num("MIN_LIVE_TRADE_SOL", 0.01)),

  // ── On-chain FOMO indexer (Helius) ────────────────────────────────────
  /** Helius key. Only src/lib/helius.ts builds URLs from it. Never log it, never send it to a client. */
  heliusApiKey: str("HELIUS_API_KEY", ""),
  /** Budget profile (design §5.1). The key's real features are probed at startup (helius.probeCaps). */
  heliusPlan,
  /** FOMO_INDEXER=off disables the worker indexer even with a key. */
  fomoIndexer: oneOf("FOMO_INDEXER", ["on", "off"], "on") === "on",
  fomoMaxTracked: Math.max(1, Math.floor(num("FOMO_MAX_TRACKED", plan.maxTracked))),
  /** Backfill window in days when gTFA is NOT available (Free: 7). Never earlier than FOMO_MARKER_SINCE. */
  fomoBackfillDays: backfillDaysEnv ?? plan.backfillDays,
  /** Backfill window in days when the gTFA probe passed (37). */
  fomoBackfillDaysGtfa: backfillDaysEnv ?? plan.backfillDaysGtfa,
  /** Per-wallet backfill cap in transactions. */
  fomoBackfillMaxTx: Math.max(100, Math.floor(num("FOMO_BACKFILL_MAX_TX", plan.backfillMaxTx))),
  /** Discovery promotions per UTC day, and the sample hits a candidate needs. */
  fomoPromotePerDay: Math.max(0, Math.floor(num("FOMO_PROMOTE_PER_DAY", plan.promotePerDay))),
  fomoPromoteMinHits: Math.max(1, Math.floor(num("FOMO_PROMOTE_MIN_HITS", plan.promoteMinHits))),
  /** All Helius use (web + worker) per UTC day. 70% pauses P3/P4, 85% pauses P2, 100% leaves P0/P1. */
  heliusDailyCreditCap: Math.max(1, num("HELIUS_DAILY_CREDIT_CAP", plan.dailyCreditCap)),
  /** Process-wide Helius HTTP token bucket (requests/second) and concurrency gate. */
  heliusRps: Math.max(1, num("HELIUS_RPS", plan.rps)),
  heliusConcurrency: Math.max(1, Math.floor(num("HELIUS_CONCURRENCY", plan.concurrency))),
  fomoDiscovery: oneOf<FomoDiscovery>("FOMO_DISCOVERY", ["off", "sample", "stream"], plan.discovery),
  /** Discovery sampler cadence (Free 30 min, paid 60 s). */
  fomoSampleIntervalMs: Math.max(10_000, num("FOMO_SAMPLE_INTERVAL_MS", plan.sampleIntervalMs)),
  /** Global cap on uncached pasted-wallet checks per UTC day (HeliusUsage.lookupChecks). */
  fomoLookupChecksPerDay: Math.max(0, Math.floor(num("FOMO_LOOKUP_CHECKS_PER_DAY", plan.lookupChecksPerDay))),
  /** Daily batch-identity labelling (paid plans; still requires the probe to pass). */
  fomoIdentity: plan.identity,
  /** FOMO's gas relayer (fee payer) and trade marker. Env overrides hot-fix a fingerprint change. */
  fomoRelayers: addressList("FOMO_RELAYERS", ["AgmLJBMDCqWynYnQiPCuj9ewsNNsBJXyzoUhD9LJzN51"]),
  fomoMarkers: addressList("FOMO_MARKERS", ["jitodontfront1111111111111111111TradeonFomo"]),
  /** "fomo": copy only FOMO buys (sells of held sleeves from any venue). "all": copy every detected swap. */
  copyVenue: oneOf("COPY_VENUE", ["fomo", "all"], "fomo"),
  /** Hourly SOL/USD history at startup (Binance klines; may be geo-blocked → pnlSol null until Jupiter data). */
  solPriceBackfill: oneOf("SOL_PRICE_BACKFILL", ["binance", "off"], "binance"),

  // ── Wallet key sealing (x25519 + AES-256-GCM) ─────────────────────────
  /** base64 raw 32-byte x25519 public key. Needed by the web process to seal new agent keys. */
  walletSealPublicKey: str("WALLET_SEAL_PUBLIC_KEY", ""),
  /**
   * base64 raw 32-byte x25519 private key. ONLY the worker reads it (from .env.worker or the environment).
   * Always "" inside the Next.js server, which also scrubs it from process.env and refuses to run in live mode.
   */
  walletSealPrivateKey: sealPrivateKey(),

  // ── Wallet sign-in (SIWS-style) ───────────────────────────────────────
  /** HMAC key for the session cookie: base64url of ≥ 32 random bytes. Web only. Never log it. */
  sessionSecret: str("SESSION_SECRET", ""),

  // ── Platform fee (a share of the profit on each winning copy sell) ────
  /** Basis points of realized profit taken on every filled sell with profit > 0 (500 = 5%). 0..2000. */
  platformFeeBps: intInRange("PLATFORM_FEE_BPS", 500, 0, 2_000),
  /** Where the worker sweeps owed live fees. Required in live mode (the worker refuses to start without it). */
  platformFeeWallet: address("PLATFORM_FEE_WALLET"),
  /** Live: sweep owed fees once they reach this much SOL (and always before a withdrawal). */
  feeSweepMinSol: Math.max(0.000_01, num("FEE_SWEEP_MIN_SOL", 0.01)),

  // ── Web request hardening ─────────────────────────────────────────────
  /**
   * Where per-IP rate limits read the client IP (finding F27). "xff": the entry TRUSTED_PROXY_HOPS from the
   * right of X-Forwarded-For (what your outermost trusted proxy appended, never the client-controlled leftmost).
   * A single header your proxy OVERWRITES: "x-real-ip", "cf-connecting-ip" (allow only Cloudflare IPs at the
   * origin), "x-vercel-forwarded-for", "fly-client-ip". "none": no per-IP identity (all clients share limits).
   */
  trustedIpSource: oneOf<TrustedIpSource>(
    "TRUSTED_IP_SOURCE",
    ["xff", "x-real-ip", "cf-connecting-ip", "x-vercel-forwarded-for", "fly-client-ip", "none"],
    "xff",
  ),
  trustedProxyHops: Math.max(1, Math.floor(num("TRUSTED_PROXY_HOPS", 1))),

  // ── Product limits ────────────────────────────────────────────────────
  minDepositSol: num("MIN_DEPOSIT_SOL", 0.05),
  paperStartSol: num("PAPER_START_SOL", 5),
  maxTradersPerAgent: num("MAX_TRADERS_PER_AGENT", 10),
  /** Hard ceiling on any single copy buy, regardless of agent settings. */
  hardMaxPerTradeSol: num("HARD_MAX_PER_TRADE_SOL", 25),

  // ── Worker ────────────────────────────────────────────────────────────
  /** Poll interval for getSignaturesForAddress backfill (ms). WS is the fast path; 4 s cost 21.6k credits/day/wallet. */
  pollIntervalMs: num("WORKER_POLL_MS", 60_000),
  /** Ignore original trades older than this when first seen (ms) — never copy stale entries. */
  maxEventAgeMs: num("WORKER_MAX_EVENT_AGE_MS", 90_000),
});

export type Config = typeof config;

/**
 * Problems that make LIVE mode unsafe to run. The worker calls this at startup in live mode and refuses to
 * start (fatal) when the list is not empty. Paper mode needs none of these.
 */
export function liveConfigErrors(
  c: Pick<Config, "platformFeeWallet" | "jupiterUrl" | "jupiterApiKey"> = config,
): string[] {
  const errors: string[] = [];
  if (!c.platformFeeWallet) {
    errors.push(
      "PLATFORM_FEE_WALLET is not set: live mode takes a performance fee on winning sells and must know where to sweep it.",
    );
  }
  if (!c.jupiterApiKey) {
    errors.push("JUPITER_API_KEY is not set: keyless Jupiter (about 0.5 RPS) cannot carry live copies. Get a key at portal.jup.ag.");
  }
  if (JUPITER_LITE.test(c.jupiterUrl)) {
    errors.push("JUPITER_API_URL points at lite-api.jup.ag, which is being retired: use https://api.jup.ag with JUPITER_API_KEY.");
  }
  return errors;
}

export function deriveWsUrl(rpcUrl: string): string {
  return rpcUrl.replace(/^http(s?):\/\//, (_m, s) => `ws${s}://`);
}
