// Helius client (design §5.1 / §5.5): plain fetch JSON-RPC + REST, no web3.js. Used by the web process
// (pasted-wallet checks) and the worker (FOMO indexer). Plain Node: no `ws`, no worker imports.
//
//  - Every call carries a priority: P0 copy engine, P1 live + gap-fill, P2 backfill + reconcile,
//    P3 discovery, P4 identity + lookups (HELIUS_PRIORITY).
//  - Process-wide token bucket (config.heliusRps) + concurrency gate (config.heliusConcurrency);
//    waiting calls are served highest priority first.
//  - HTTP 429 → exponential backoff (500 ms → 30 s), then retry. The backoff is scoped by priority: a 429 seen
//    at priority p pauses p and every LOWER priority, never a higher one (an indexer burst can't stall the
//    copy engine's sends and confirmations, finding F25), and a burst of 429s from requests that were in
//    flight together escalates the backoff only once.
//  - Credit meter: in memory, flushed every 10 s to HeliusUsage (UTC day) with {increment}; the web
//    process and the worker share that row.
//  - Daily cap (config.heliusDailyCreditCap), checked before each call with its known price:
//    ≥ 70 % pauses P3/P4, ≥ 85 % pauses P2, P0/P1 always run (throttled at ≥ 100 %).
//
// The API key lives in URLs/headers built ONLY here. Error messages are scrubbed of it; log URLs with
// redactUrl(). Never send anything from this module to a client.

import { z } from "zod";
import { config, type HeliusPlan } from "./config";
import { kvGet, kvSet, prisma } from "./db";

// ── Priorities & prices ─────────────────────────────────────────────────────────────────────────────

export const HELIUS_PRIORITY = Object.freeze({
  /** Copy engine (watcher / executor via web3.js Connection). Never paused. */
  copy: 0,
  /** Live stream follow-ups and gap-fill. Never paused. */
  live: 1,
  /** Backfill and reconciliation. Paused at 85 % of the daily cap. */
  backfill: 2,
  /** Discovery sampling. Paused at 70 %. */
  discovery: 3,
  /** Identity labels and pasted-wallet lookups. Paused at 70 %. */
  identity: 4,
} as const);
export type HeliusPriority = (typeof HELIUS_PRIORITY)[keyof typeof HELIUS_PRIORITY];

/** Share of the daily cap at which a priority stops being served. */
const PAUSE_AT: Record<HeliusPriority, number> = { 0: Infinity, 1: Infinity, 2: 0.85, 3: 0.7, 4: 0.7 };

export const HELIUS_CREDITS = Object.freeze({
  /** Standard RPC call (getTransaction, getSignaturesForAddress, getTokenAccountsByOwner, …). */
  rpc: 1,
  /** getTransactionsForAddress: per call (≤ 100 full transactions or ≤ 1,000 signatures). */
  gtfa: 10,
  /** POST /v1/wallet/batch-identity: per request of ≤ 100 addresses. */
  batchIdentity: 100,
  /** WebSocket: 1 credit per connection, 2 credits per 0.1 MB received. */
  wsConnection: 1,
  wsPerByte: 2 / 100_000,
  /** web3.js onLogs gives no byte counts: estimate each logsNotification at 3.7 KB. */
  logsNotificationBytes: 3_700,
});

const METHOD_CREDITS: Record<string, number> = {
  getTransactionsForAddress: HELIUS_CREDITS.gtfa,
  getProgramAccounts: 10,
  getAsset: 10,
  getAssetBatch: 10,
  getAssetsByOwner: 10,
  getAssetsByAuthority: 10,
  getAssetsByCreator: 10,
  getAssetsByGroup: 10,
  searchAssets: 10,
  getTokenAccounts: 10,
  getSignaturesForAsset: 10,
};

/** Known credit price of one JSON-RPC call. */
export function methodCredits(method: string): number {
  return METHOD_CREDITS[method] ?? HELIUS_CREDITS.rpc;
}

// ── Errors ──────────────────────────────────────────────────────────────────────────────────────────

export type HeliusErrorKind =
  | "not_configured"
  | "throttled"
  | "rate_limited"
  | "http"
  | "rpc"
  | "network"
  | "timeout"
  | "invalid_response";

/** Every failure of this client. Messages never contain the API key or a full Helius URL. */
export class HeliusError extends Error {
  readonly kind: HeliusErrorKind;
  readonly status: number | null;
  readonly code: number | null;
  constructor(kind: HeliusErrorKind, message: string, status: number | null = null, code: number | null = null) {
    super(redactSecrets(message));
    this.name = "HeliusError";
    this.kind = kind;
    this.status = status;
    this.code = code;
  }
}

export function isHeliusError(err: unknown, ...kinds: HeliusErrorKind[]): err is HeliusError {
  return err instanceof HeliusError && (kinds.length === 0 || kinds.includes(err.kind));
}

// ── URLs & redaction ────────────────────────────────────────────────────────────────────────────────

const RPC_BASE = "https://mainnet.helius-rpc.com/";
const WS_BASE = "wss://mainnet.helius-rpc.com/";
const API_BASE = "https://api.helius.xyz";

export function heliusConfigured(): boolean {
  return config.heliusApiKey !== "";
}

function requireKey(): string {
  if (!config.heliusApiKey) throw new HeliusError("not_configured", "HELIUS_API_KEY is not set");
  return config.heliusApiKey;
}

/** Helius HTTP RPC URL (carries the key — never log it; use redactUrl). */
export function heliusRpcUrl(): string {
  return `${RPC_BASE}?api-key=${encodeURIComponent(requireKey())}`;
}

/** Helius WebSocket URL for transactionSubscribe / logsSubscribe (carries the key — never log it). */
export function heliusWsUrl(): string {
  return `${WS_BASE}?api-key=${encodeURIComponent(requireKey())}`;
}

/** Replace every occurrence of the API key (raw or URL-encoded) with "***". */
export function redactSecrets(text: string): string {
  let out = text;
  const key = config.heliusApiKey;
  if (key) {
    out = out.split(key).join("***");
    const enc = encodeURIComponent(key);
    if (enc !== key) out = out.split(enc).join("***");
  }
  return out.replace(/(api[-_]?key=)[^&\s"']+/gi, "$1***");
}

/** URL safe to log: every query value and any password replaced by "***". */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    for (const key of [...u.searchParams.keys()]) u.searchParams.set(key, "***");
    if (u.password) u.password = "***";
    return u.toString();
  } catch {
    return "<invalid url>";
  }
}

function isHeliusHost(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return (
      host === "helius-rpc.com" ||
      host.endsWith(".helius-rpc.com") ||
      host === "helius.xyz" ||
      host.endsWith(".helius.xyz") ||
      host.endsWith(".helius.dev")
    );
  } catch {
    return false;
  }
}

function snippet(text: string, max = 200): string {
  const oneLine = redactSecrets(text).replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Credit meter ────────────────────────────────────────────────────────────────────────────────────

interface Counters {
  credits: number;
  calls: number;
  wsBytes: number;
  lookupChecks: number;
}

const zeroCounters = (): Counters => ({ credits: 0, calls: 0, wsBytes: 0, lookupChecks: 0 });
const isEmpty = (c: Counters) => c.credits === 0 && c.calls === 0 && c.wsBytes === 0 && c.lookupChecks === 0;

export function utcDay(ms: number = Date.now()): string {
  return new Date(ms).toISOString().slice(0, 10);
}

const FLUSH_MS = 10_000;
const SYNC_MAX_AGE_MS = 10_000;

export interface MeterSnapshot {
  day: string;
  /** Credits used today by every process (last synced DB value + this process's unflushed usage). */
  creditsToday: number;
  cap: number;
  /** creditsToday / cap (0..∞). */
  pct: number;
  /** Priorities currently refused because of the daily cap. */
  pausedPriorities: HeliusPriority[];
  /** At or above 100 % of the cap: only P0/P1 run. */
  throttled: boolean;
  lookupChecksToday: number;
  /** This process only, since start of the UTC day. */
  local: { credits: number; calls: number; wsBytes: number; byPriority: Record<HeliusPriority, number> };
}

/**
 * In-memory Helius usage, flushed to HeliusUsage every 10 s (debounced after the first record).
 * `creditsToday()` = DB row as of the last sync/flush + this process's pending usage.
 */
class HeliusMeter {
  private day = utcDay();
  private pending = zeroCounters();
  private db = { credits: 0, lookupChecks: 0 };
  private syncedAt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushing: Promise<void> | null = null;
  private syncing: Promise<void> | null = null;
  private local = { credits: 0, calls: 0, wsBytes: 0, byPriority: { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0 } as Record<HeliusPriority, number> };

  /** Count one call's credits (and optionally several JSON-RPC calls in one HTTP batch). */
  record(credits: number, priority: HeliusPriority = HELIUS_PRIORITY.copy, calls = 1): void {
    this.roll();
    const c = Number.isFinite(credits) && credits > 0 ? credits : 0;
    this.pending.credits += c;
    this.pending.calls += calls;
    this.local.credits += c;
    this.local.calls += calls;
    this.local.byPriority[priority] += c;
    this.schedule();
  }

  /** Count WebSocket bytes received (UTF-8 length of each message). */
  recordWsBytes(bytes: number, priority: HeliusPriority = HELIUS_PRIORITY.live): void {
    if (!Number.isFinite(bytes) || bytes <= 0) return;
    this.roll();
    const c = bytes * HELIUS_CREDITS.wsPerByte;
    this.pending.wsBytes += bytes;
    this.pending.credits += c;
    this.local.wsBytes += bytes;
    this.local.credits += c;
    this.local.byPriority[priority] += c;
    this.schedule();
  }

  /** Count a web3.js logsNotification (no byte count available): 3.7 KB estimate. */
  recordLogsNotification(priority: HeliusPriority = HELIUS_PRIORITY.copy): void {
    this.recordWsBytes(HELIUS_CREDITS.logsNotificationBytes, priority);
  }

  /** Count a new WebSocket connection (1 credit). */
  recordWsConnection(priority: HeliusPriority = HELIUS_PRIORITY.live): void {
    this.record(HELIUS_CREDITS.wsConnection, priority, 0);
  }

  /** Count one uncached pasted-wallet check (global daily lookup cap). */
  recordLookupCheck(): void {
    this.roll();
    this.pending.lookupChecks += 1;
    this.schedule();
  }

  creditsToday(): number {
    this.roll();
    return this.db.credits + this.pending.credits;
  }

  lookupChecksToday(): number {
    this.roll();
    return this.db.lookupChecks + this.pending.lookupChecks;
  }

  /** Refresh the DB baseline (other processes' usage) when older than `maxAgeMs`. Never throws. */
  async sync(maxAgeMs = SYNC_MAX_AGE_MS): Promise<void> {
    this.roll();
    if (Date.now() - this.syncedAt < maxAgeMs) return;
    if (!this.syncing) {
      const day = this.day;
      this.syncing = prisma.heliusUsage
        .findUnique({ where: { day } })
        .then((row) => {
          if (day !== this.day) return;
          this.db = { credits: row?.credits ?? 0, lookupChecks: row?.lookupChecks ?? 0 };
          this.syncedAt = Date.now();
        })
        .catch(() => {
          // DB unavailable: keep the last baseline and retry after maxAgeMs instead of on every call.
          this.syncedAt = Date.now();
        })
        .finally(() => {
          this.syncing = null;
        });
    }
    await this.syncing;
  }

  /** Write pending usage to HeliusUsage now (the worker calls this on shutdown). Never throws. */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    while (this.flushing) await this.flushing;
    this.roll();
    if (isEmpty(this.pending)) return;
    const day = this.day;
    const batch = this.pending;
    this.pending = zeroCounters();
    this.flushing = this.write(day, batch)
      .then((row) => {
        if (day !== this.day) return;
        this.db = { credits: row.credits, lookupChecks: row.lookupChecks };
        this.syncedAt = Date.now();
      })
      .catch((err: unknown) => {
        // Keep the usage for the next attempt (same day only; a failed write for a past day is dropped).
        if (day === this.day) {
          this.pending.credits += batch.credits;
          this.pending.calls += batch.calls;
          this.pending.wsBytes += batch.wsBytes;
          this.pending.lookupChecks += batch.lookupChecks;
          this.schedule();
        }
        console.warn(`[helius] meter flush failed: ${redactSecrets(err instanceof Error ? err.message : String(err))}`);
      })
      .finally(() => {
        this.flushing = null;
      });
    await this.flushing;
  }

  snapshot(): MeterSnapshot {
    const creditsToday = this.creditsToday();
    const cap = config.heliusDailyCreditCap;
    const pct = creditsToday / cap;
    const pausedPriorities = ([0, 1, 2, 3, 4] as HeliusPriority[]).filter((p) => pct >= PAUSE_AT[p]);
    return {
      day: this.day,
      creditsToday,
      cap,
      pct,
      pausedPriorities,
      throttled: pct >= 1,
      lookupChecksToday: this.lookupChecksToday(),
      local: { ...this.local, byPriority: { ...this.local.byPriority } },
    };
  }

  private write(day: string, c: Counters) {
    return prisma.heliusUsage.upsert({
      where: { day },
      create: { day, credits: c.credits, calls: c.calls, wsBytes: c.wsBytes, lookupChecks: c.lookupChecks },
      update: {
        credits: { increment: c.credits },
        calls: { increment: c.calls },
        wsBytes: { increment: c.wsBytes },
        lookupChecks: { increment: c.lookupChecks },
      },
    });
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, FLUSH_MS);
    // Never keep a process alive just to flush the meter.
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }

  /** UTC day rollover: flush the old day's leftovers (best effort) and start from zero. */
  private roll(): void {
    const today = utcDay();
    if (today === this.day) return;
    const oldDay = this.day;
    const carry = this.pending;
    this.day = today;
    this.pending = zeroCounters();
    this.db = { credits: 0, lookupChecks: 0 };
    this.syncedAt = 0;
    this.local = { credits: 0, calls: 0, wsBytes: 0, byPriority: { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0 } };
    if (!isEmpty(carry)) void this.write(oldDay, carry).catch(() => undefined);
  }
}

const globalForHelius = globalThis as unknown as { __copyfomoHeliusMeter?: HeliusMeter; __copyfomoHeliusGate2?: Gate };

/** Process-wide Helius credit meter (shared across Next.js hot reloads). */
export const meter: HeliusMeter = (globalForHelius.__copyfomoHeliusMeter ??= new HeliusMeter());

/** True when a call of `credits` at `priority` fits under today's cap thresholds. */
export function canSpend(priority: HeliusPriority, credits: number): boolean {
  const pause = PAUSE_AT[priority];
  if (pause === Infinity) return true;
  return (meter.creditsToday() + credits) / config.heliusDailyCreditCap < pause;
}

export function throttleState(): Pick<MeterSnapshot, "creditsToday" | "cap" | "pct" | "pausedPriorities" | "throttled"> {
  const { creditsToday, cap, pct, pausedPriorities, throttled } = meter.snapshot();
  return { creditsToday, cap, pct, pausedPriorities, throttled };
}

function assertBudget(priority: HeliusPriority, credits: number, label: string): void {
  if (canSpend(priority, credits)) return;
  const pct = Math.round((meter.creditsToday() / config.heliusDailyCreditCap) * 100);
  throw new HeliusError("throttled", `${label}: P${priority} paused, ${pct}% of today's Helius credit cap used`);
}

// ── Token bucket + concurrency gate (priority-aware) with priority-scoped 429 backoff ───────────────

const BACKOFF_START_MS = 500;
const BACKOFF_MAX_MS = 30_000;
const PRIORITY_LEVELS = 5;

export class Gate {
  private tokens: number;
  private refilledAt = Date.now();
  private active = 0;
  private seq = 0;
  private readonly queue: { p: number; seq: number; resolve: () => void }[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Per priority: paused until (ms). Invariant: non-decreasing with the priority number (a pause at p also
   * covers every lower priority q > p), so a paused queue head means everything behind it is paused too.
   */
  private readonly pausedUntil: number[] = new Array<number>(PRIORITY_LEVELS).fill(0);
  /** Per priority: current backoff step (0 = none). */
  private readonly backoffMs: number[] = new Array<number>(PRIORITY_LEVELS).fill(0);
  /** Concurrency slots only P0/P1 may use (a quarter, at least one when there are ≥ 2 slots). */
  private readonly reserved: number;

  constructor(
    private readonly rps: number,
    private readonly concurrency: number,
  ) {
    this.tokens = rps;
    this.reserved = concurrency >= 2 ? Math.max(1, Math.floor(concurrency / 4)) : 0;
  }

  acquire(priority: HeliusPriority): Promise<void> {
    return new Promise((resolve) => {
      const item = { p: priority, seq: this.seq++, resolve };
      let i = this.queue.length;
      while (i > 0 && this.queue[i - 1]!.p > priority) i--;
      this.queue.splice(i, 0, item);
      this.pump();
    });
  }

  release(): void {
    this.active = Math.max(0, this.active - 1);
    this.pump();
  }

  /**
   * HTTP 429 seen at `priority`: that priority and every lower one wait for a doubling backoff window. Higher
   * priorities keep running (they back off on their own 429s). A 429 that arrives while `priority` is already
   * paused came from a request in flight when the pause began: it does not escalate the step again.
   */
  rateLimited(priority: HeliusPriority = HELIUS_PRIORITY.copy): number {
    const p = clampPriority(priority);
    const now = Date.now();
    const current = this.backoffMs[p]!;
    if (now >= this.pausedUntil[p]! || current === 0) {
      this.backoffMs[p] = Math.min(current ? current * 2 : BACKOFF_START_MS, BACKOFF_MAX_MS);
    }
    const until = now + this.backoffMs[p]!;
    for (let q = p; q < PRIORITY_LEVELS; q++) this.pausedUntil[q] = Math.max(this.pausedUntil[q]!, until);
    this.pump();
    return this.backoffMs[p]!;
  }

  /** A request at `priority` succeeded: its backoff step resets. */
  ok(priority: HeliusPriority = HELIUS_PRIORITY.copy): void {
    this.backoffMs[clampPriority(priority)] = 0;
  }

  /** Remaining pause for `priority` in ms (default: the lowest priority, i.e. "is anything backing off"). */
  backoff(priority: HeliusPriority = HELIUS_PRIORITY.identity): number {
    return Math.max(0, this.pausedUntil[clampPriority(priority)]! - Date.now());
  }

  /** Current backoff step for `priority` (tests / status). */
  backoffStep(priority: HeliusPriority): number {
    return this.backoffMs[clampPriority(priority)]!;
  }

  private pump(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    while (this.queue.length > 0) {
      const now = Date.now();
      const pausedUntil = this.pausedUntil[clampPriority(this.queue[0]!.p)]!;
      if (now < pausedUntil) return this.wake(pausedUntil - now);
      if (this.active >= this.concurrency) return; // release() pumps again
      // The queue is priority-sorted: a P2–P4 head means no P0/P1 is waiting. Keep slots free for them anyway,
      // so slow backfill/discovery pages can never delay the copy engine.
      if (this.queue[0]!.p >= HELIUS_PRIORITY.backfill && this.active >= this.concurrency - this.reserved) return;
      this.tokens = Math.min(this.rps, this.tokens + ((now - this.refilledAt) / 1000) * this.rps);
      this.refilledAt = now;
      if (this.tokens < 1) return this.wake(Math.ceil(((1 - this.tokens) / this.rps) * 1000));
      this.tokens -= 1;
      this.active++;
      this.queue.shift()!.resolve();
    }
  }

  private wake(ms: number): void {
    this.timer = setTimeout(() => {
      this.timer = null;
      this.pump();
    }, Math.max(1, ms));
  }
}

function clampPriority(p: number): number {
  return Math.min(Math.max(Math.floor(p), 0), PRIORITY_LEVELS - 1);
}

const gate: Gate = (globalForHelius.__copyfomoHeliusGate2 ??= new Gate(config.heliusRps, config.heliusConcurrency));

/** Remaining 429 backoff in ms for `priority` (default: the lowest priority, i.e. any backoff at all). */
export function heliusBackoffMs(priority?: HeliusPriority): number {
  return gate.backoff(priority);
}

// ── Core request ────────────────────────────────────────────────────────────────────────────────────

export interface CallOptions {
  priority: HeliusPriority;
  /** Override the known price (credits) of this call. */
  credits?: number;
  timeoutMs?: number;
  /** Retries after HTTP 429 (default 3). Network errors and 5xx are retried once. */
  retries?: number;
}

interface RequestSpec extends CallOptions {
  label: string;
  url: string;
  method: "GET" | "POST";
  headers?: Record<string, string>;
  body?: unknown;
  credits: number;
}

async function request(spec: RequestSpec): Promise<unknown> {
  requireKey();
  await meter.sync();
  assertBudget(spec.priority, spec.credits, spec.label);

  const retries = spec.retries ?? 3;
  const headers: Record<string, string> = { accept: "application/json", ...spec.headers };
  let body: string | undefined;
  if (spec.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(spec.body);
  }

  for (let attempt = 0; ; attempt++) {
    let retryAfterMs = -1;
    await gate.acquire(spec.priority);
    try {
      let res: Response;
      try {
        res = await fetch(spec.url, {
          method: spec.method,
          headers,
          body,
          signal: AbortSignal.timeout(spec.timeoutMs ?? 20_000),
          cache: "no-store",
        });
      } catch (err) {
        const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
        if (attempt < Math.min(retries, 1)) {
          retryAfterMs = 400;
          continue;
        }
        const reason = err instanceof Error ? err.message : String(err);
        throw new HeliusError(timedOut ? "timeout" : "network", `${spec.label}: ${timedOut ? "timed out" : `request failed (${reason})`}`);
      }

      if (res.status === 429) {
        await res.text().catch(() => "");
        gate.rateLimited(spec.priority);
        if (attempt < retries) {
          retryAfterMs = 0; // the gate itself holds everyone back for the backoff window
          continue;
        }
        throw new HeliusError("rate_limited", `${spec.label}: HTTP 429 (rate limited)`, 429);
      }

      meter.record(spec.credits, spec.priority);
      const text = await res.text().catch(() => "");
      if (!res.ok) {
        if (res.status >= 500 && attempt < Math.min(retries, 1)) {
          retryAfterMs = 500;
          continue;
        }
        throw new HeliusError("http", `${spec.label}: HTTP ${res.status} ${snippet(text)}`, res.status);
      }
      gate.ok(spec.priority);
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new HeliusError("invalid_response", `${spec.label}: invalid JSON (HTTP ${res.status}) ${snippet(text)}`, res.status);
      }
    } finally {
      gate.release();
      if (retryAfterMs > 0) await sleep(retryAfterMs);
    }
  }
}

// ── JSON-RPC ────────────────────────────────────────────────────────────────────────────────────────

const rpcEnvelopeSchema = z
  .object({
    result: z.unknown().optional(),
    error: z.object({ code: z.number().optional(), message: z.string().optional() }).passthrough().nullish(),
  })
  .passthrough();

let rpcId = 0;

/** One Helius JSON-RPC call. Throws HeliusError ("rpc" for a JSON-RPC error object). */
export async function rpc<T = unknown>(method: string, params: unknown, opts: CallOptions): Promise<T> {
  const raw = await request({
    ...opts,
    label: method,
    url: heliusRpcUrl(),
    method: "POST",
    body: { jsonrpc: "2.0", id: ++rpcId, method, params },
    credits: opts.credits ?? methodCredits(method),
  });
  const env = rpcEnvelopeSchema.safeParse(raw);
  if (!env.success) throw new HeliusError("invalid_response", `${method}: unexpected JSON-RPC envelope`);
  if (env.data.error) {
    const { code, message } = env.data.error;
    if (code === 429 || code === -32429) {
      gate.rateLimited(opts.priority);
      throw new HeliusError("rate_limited", `${method}: ${message ?? "rate limited"}`, null, code ?? null);
    }
    throw new HeliusError("rpc", `${method}: ${code ?? "?"} ${message ?? "error"}`, null, code ?? null);
  }
  if (!("result" in env.data)) throw new HeliusError("invalid_response", `${method}: JSON-RPC response without result`);
  return env.data.result as T;
}

/**
 * getTransaction (jsonParsed, maxSupportedTransactionVersion 1, confirmed). 1 credit.
 * Returns the raw JSON (feed it to normalizeTx) or null when the node doesn't have it (yet).
 */
export async function getTransaction(
  signature: string,
  opts: CallOptions & { maxSupportedTransactionVersion?: number },
): Promise<Record<string, unknown> | null> {
  const result = await rpc<unknown>(
    "getTransaction",
    [
      signature,
      { encoding: "jsonParsed", maxSupportedTransactionVersion: opts.maxSupportedTransactionVersion ?? 1, commitment: "confirmed" },
    ],
    opts,
  );
  return result && typeof result === "object" ? (result as Record<string, unknown>) : null;
}

export interface SignatureInfo {
  signature: string;
  slot: number;
  err: unknown;
  /** Unix seconds, when known. */
  blockTime: number | null;
  confirmationStatus: string | null;
}

const signatureInfoSchema = z
  .object({
    signature: z.string(),
    slot: z.number(),
    err: z.unknown().optional(),
    blockTime: z.number().nullish(),
    confirmationStatus: z.string().nullish(),
  })
  .passthrough();

/** getSignaturesForAddress, newest first. 1 credit. */
export async function getSignatures(
  address: string,
  opts: CallOptions & { limit?: number; before?: string; until?: string },
): Promise<SignatureInfo[]> {
  const cfg: Record<string, unknown> = { limit: Math.min(Math.max(opts.limit ?? 1000, 1), 1000), commitment: "confirmed" };
  if (opts.before) cfg.before = opts.before;
  if (opts.until) cfg.until = opts.until;
  const result = await rpc<unknown>("getSignaturesForAddress", [address, cfg], opts);
  const parsed = z.array(signatureInfoSchema).safeParse(result);
  if (!parsed.success) throw new HeliusError("invalid_response", "getSignaturesForAddress: unexpected result shape");
  return parsed.data.map((s) => ({
    signature: s.signature,
    slot: s.slot,
    err: s.err ?? null,
    blockTime: s.blockTime ?? null,
    confirmationStatus: s.confirmationStatus ?? null,
  }));
}

export interface GtfaRange {
  gte?: number;
  gt?: number;
  lte?: number;
  lt?: number;
}

export interface GtfaOptions extends CallOptions {
  /** "full" (default): jsonParsed transactions (≤ 100/page). "signatures": signature rows (≤ 1,000/page). */
  transactionDetails?: "full" | "signatures";
  limit?: number;
  sortOrder?: "asc" | "desc";
  paginationToken?: string | null;
  filters?: { status?: "succeeded" | "failed" | "any"; blockTime?: GtfaRange; slot?: GtfaRange };
  maxSupportedTransactionVersion?: number;
}

export interface GtfaPage {
  /** "full": raw transactions (signature at transaction.signatures[0]; feed to normalizeTx). "signatures": signature rows. */
  data: unknown[];
  /** Pass back to get the next page; null at the end. */
  paginationToken: string | null;
}

const gtfaResultSchema = z
  .object({ data: z.array(z.unknown()), paginationToken: z.string().nullish() })
  .passthrough();

/**
 * Helius getTransactionsForAddress ("gTFA", paid feature — check probeCaps().gtfa first). 10 credits per call.
 * Defaults: full, jsonParsed, maxSupportedTransactionVersion 1, desc, confirmed.
 */
export async function getTransactionsForAddress(address: string, opts: GtfaOptions): Promise<GtfaPage> {
  const details = opts.transactionDetails ?? "full";
  const maxLimit = details === "full" ? 100 : 1000;
  const cfg: Record<string, unknown> = {
    transactionDetails: details,
    sortOrder: opts.sortOrder ?? "desc",
    limit: Math.min(Math.max(opts.limit ?? maxLimit, 1), maxLimit),
    commitment: "confirmed",
  };
  if (details === "full") {
    cfg.encoding = "jsonParsed";
    cfg.maxSupportedTransactionVersion = opts.maxSupportedTransactionVersion ?? 1;
  }
  if (opts.filters) cfg.filters = opts.filters;
  if (opts.paginationToken) cfg.paginationToken = opts.paginationToken;
  const result = await rpc<unknown>("getTransactionsForAddress", [address, cfg], {
    ...opts,
    credits: opts.credits ?? HELIUS_CREDITS.gtfa,
    timeoutMs: opts.timeoutMs ?? 30_000,
  });
  const parsed = gtfaResultSchema.safeParse(result);
  if (!parsed.success) throw new HeliusError("invalid_response", "getTransactionsForAddress: unexpected result shape");
  return { data: parsed.data.data, paginationToken: parsed.data.paginationToken ?? null };
}

// ── Wallet identity (REST, paid plans, beta) ────────────────────────────────────────────────────────

export interface HeliusIdentity {
  address: string;
  type: string | null;
  name: string | null;
  category: string | null;
  tags: string[];
}

const identitySchema = z
  .object({
    address: z.string(),
    type: z.string().nullish(),
    name: z.string().nullish(),
    category: z.string().nullish(),
    tags: z.array(z.string()).nullish(),
  })
  .passthrough();

const IDENTITY_CHUNK = 100;

/** POST /v1/wallet/batch-identity in chunks of 100 (100 credits each). Unknown addresses may be absent. */
export async function batchIdentity(addresses: readonly string[], opts: CallOptions): Promise<HeliusIdentity[]> {
  const unique = [...new Set(addresses)];
  const out: HeliusIdentity[] = [];
  for (let i = 0; i < unique.length; i += IDENTITY_CHUNK) {
    const chunk = unique.slice(i, i + IDENTITY_CHUNK);
    const raw = await request({
      ...opts,
      label: "batch-identity",
      url: `${API_BASE}/v1/wallet/batch-identity`,
      method: "POST",
      headers: { "X-Api-Key": requireKey() },
      body: { addresses: chunk },
      credits: opts.credits ?? HELIUS_CREDITS.batchIdentity,
    });
    const parsed = z.array(z.unknown()).safeParse(raw);
    if (!parsed.success) throw new HeliusError("invalid_response", "batch-identity: expected an array");
    for (const item of parsed.data) {
      const r = identitySchema.safeParse(item);
      if (!r.success) continue;
      out.push({
        address: r.data.address,
        type: r.data.type ?? null,
        name: r.data.name ?? null,
        category: r.data.category ?? null,
        tags: r.data.tags ?? [],
      });
    }
  }
  return out;
}

const FOMO_LABEL_RE = /^"([A-Za-z0-9_.]{1,40})" on Fomo$/;

/** Helius name `"<handle>" on Fomo` → "<handle>"; anything else (e.g. "Frank DeGods") → null. */
export function parseFomoHandleLabel(name: string | null | undefined): string | null {
  if (!name) return null;
  const m = FOMO_LABEL_RE.exec(name.trim());
  return m ? m[1]! : null;
}

// ── Capability probes (cached in Kv "helius:caps") ──────────────────────────────────────────────────

export interface HeliusCaps {
  plan: HeliusPlan;
  /** transactionSubscribe accepted (stream mode S1). */
  ts: boolean;
  /** getTransactionsForAddress works. */
  gtfa: boolean;
  /** batch-identity works (only probed when plan ≠ free). */
  identity: boolean;
  probedAt: string;
  /** false when a probe failed for a transient reason (network, timeout, budget): re-probe after 15 min. */
  definitive: boolean;
  errors: Partial<Record<"ts" | "gtfa" | "identity", string>>;
}

export const CAPS_KV_KEY = "helius:caps";
const CAPS_TTL_MS = 24 * 3600_000;
const CAPS_RETRY_MS = 15 * 60_000;
const WS_PROBE_TIMEOUT_MS = 10_000;

const capsSchema = z.object({
  plan: z.enum(["free", "developer", "business"]),
  ts: z.boolean(),
  gtfa: z.boolean(),
  identity: z.boolean(),
  probedAt: z.string(),
  definitive: z.boolean(),
  errors: z.record(z.string()).default({}),
});

/** Last probe result from Kv (any age), or null. The web process uses this and never probes. */
export async function getCachedCaps(): Promise<HeliusCaps | null> {
  const row = await kvGet<unknown>(CAPS_KV_KEY).catch(() => null);
  if (!row) return null;
  const parsed = capsSchema.safeParse(row.value);
  return parsed.success ? (parsed.data as HeliusCaps) : null;
}

/** Minimal WebSocket surface (WHATWG global WebSocket in Node ≥ 22, or the `ws` package). */
export interface WebSocketLike {
  send(data: string): void;
  close(): void;
  addEventListener(type: "open" | "message" | "error" | "close", listener: (ev: { data?: unknown }) => void): void;
}
export type WebSocketCtor = new (url: string) => WebSocketLike;

type ProbeOutcome = { ok: boolean; definitive: boolean; error?: string };

function wsDataToString(data: unknown): string {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  return String(data ?? "");
}

function probeTransactionSubscribe(Ws: WebSocketCtor | undefined): Promise<ProbeOutcome> {
  if (!Ws) return Promise.resolve({ ok: false, definitive: false, error: "no WebSocket implementation" });
  return new Promise((resolve) => {
    let settled = false;
    let subId: number | null = null;
    let ws: WebSocketLike;
    try {
      ws = new Ws(heliusWsUrl());
    } catch (err) {
      resolve({ ok: false, definitive: false, error: redactSecrets(err instanceof Error ? err.message : String(err)) });
      return;
    }
    meter.recordWsConnection(HELIUS_PRIORITY.live);
    const finish = (r: ProbeOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        if (subId !== null) ws.send(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "transactionUnsubscribe", params: [subId] }));
      } catch {
        /* closing anyway */
      }
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      resolve(r);
    };
    const timer = setTimeout(() => finish({ ok: false, definitive: false, error: "timed out waiting for the subscribe ack" }), WS_PROBE_TIMEOUT_MS);
    ws.addEventListener("open", () => {
      ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "transactionSubscribe",
          params: [
            { accountInclude: [config.fomoMarkers[0]], failed: false, vote: false },
            { commitment: "confirmed", encoding: "jsonParsed", transactionDetails: "signatures", maxSupportedTransactionVersion: 1 },
          ],
        }),
      );
    });
    ws.addEventListener("message", (ev) => {
      const text = wsDataToString(ev.data);
      meter.recordWsBytes(Buffer.byteLength(text, "utf8"), HELIUS_PRIORITY.live);
      let msg: { id?: unknown; result?: unknown; error?: { message?: unknown } };
      try {
        msg = JSON.parse(text) as typeof msg;
      } catch {
        return;
      }
      if (msg.id !== 1) return;
      if (typeof msg.result === "number") {
        subId = msg.result;
        finish({ ok: true, definitive: true });
      } else if (msg.error) {
        finish({ ok: false, definitive: true, error: redactSecrets(String(msg.error.message ?? "subscribe rejected")) });
      }
    });
    ws.addEventListener("error", () => finish({ ok: false, definitive: false, error: "websocket error" }));
    ws.addEventListener("close", () => finish({ ok: false, definitive: false, error: "websocket closed before the ack" }));
  });
}

function probeFailure(err: unknown): ProbeOutcome {
  const definitive = isHeliusError(err, "rpc", "http") && !(err.status !== null && err.status >= 500);
  return { ok: false, definitive, error: redactSecrets(err instanceof Error ? err.message : String(err)).slice(0, 200) };
}

/**
 * Probe transactionSubscribe, getTransactionsForAddress (10 credits) and — when HELIUS_PLAN ≠ free —
 * batch-identity (100 credits). Cached in Kv "helius:caps" for 24 h (15 min after a transient failure).
 * Worker startup only. Without a key every feature is false and nothing is cached.
 */
export async function probeCaps(opts: { force?: boolean; webSocket?: WebSocketCtor } = {}): Promise<HeliusCaps> {
  const now = Date.now();
  if (!heliusConfigured()) {
    return {
      plan: config.heliusPlan,
      ts: false,
      gtfa: false,
      identity: false,
      probedAt: new Date(now).toISOString(),
      definitive: true,
      errors: { ts: "HELIUS_API_KEY not set", gtfa: "HELIUS_API_KEY not set", identity: "HELIUS_API_KEY not set" },
    };
  }

  if (!opts.force) {
    const cached = await getCachedCaps();
    if (cached && cached.plan === config.heliusPlan) {
      const age = now - Date.parse(cached.probedAt);
      if (Number.isFinite(age) && age < (cached.definitive ? CAPS_TTL_MS : CAPS_RETRY_MS)) return cached;
    }
  }

  const Ws = opts.webSocket ?? (globalThis as unknown as { WebSocket?: WebSocketCtor }).WebSocket;
  const marker = config.fomoMarkers[0]!;

  const [ts, gtfa] = await Promise.all([
    probeTransactionSubscribe(Ws),
    getTransactionsForAddress(marker, { priority: HELIUS_PRIORITY.live, transactionDetails: "signatures", limit: 1 })
      .then((page): ProbeOutcome => ({ ok: Array.isArray(page.data), definitive: true }))
      .catch(probeFailure),
  ]);

  let identity: ProbeOutcome = { ok: false, definitive: true, error: "not probed on the free plan" };
  if (config.heliusPlan !== "free") {
    identity = await batchIdentity([config.fomoRelayers[0]!], { priority: HELIUS_PRIORITY.identity })
      .then((rows): ProbeOutcome => ({ ok: Array.isArray(rows), definitive: true }))
      .catch(probeFailure);
  }

  const errors: HeliusCaps["errors"] = {};
  if (ts.error) errors.ts = ts.error;
  if (gtfa.error) errors.gtfa = gtfa.error;
  if (identity.error) errors.identity = identity.error;

  const caps: HeliusCaps = {
    plan: config.heliusPlan,
    ts: ts.ok,
    gtfa: gtfa.ok,
    identity: identity.ok,
    probedAt: new Date(now).toISOString(),
    definitive: ts.definitive && gtfa.definitive && identity.definitive,
    errors,
  };
  await kvSet(CAPS_KV_KEY, caps).catch(() => undefined);
  return caps;
}

// ── web3.js Connection fetch (meters the copy engine's RPC traffic at P0) ───────────────────────────

function countRpcBody(body: unknown): { credits: number; calls: number } {
  if (typeof body !== "string") return { credits: HELIUS_CREDITS.rpc, calls: 1 };
  try {
    const parsed = JSON.parse(body) as unknown;
    const items = Array.isArray(parsed) ? parsed : [parsed];
    let credits = 0;
    for (const item of items) {
      const method = item && typeof item === "object" ? (item as { method?: unknown }).method : undefined;
      credits += methodCredits(typeof method === "string" ? method : "");
    }
    return { credits, calls: Math.max(1, items.length) };
  } catch {
    return { credits: HELIUS_CREDITS.rpc, calls: 1 };
  }
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/**
 * Drop-in `fetch` for `new Connection(url, { fetch: heliusFetch })`. For Helius hosts it goes through
 * the shared gate at P0 (never paused by the daily cap, nor by 429s other priorities saw), meters each
 * JSON-RPC method (batch items counted individually) and feeds its own 429s into the backoff (which pauses
 * every priority: the key itself is saturated). Other hosts pass straight through.
 */
export async function heliusFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  if (!isHeliusHost(requestUrl(input))) return fetch(input, init);
  const { credits, calls } = countRpcBody(init?.body);
  await gate.acquire(HELIUS_PRIORITY.copy);
  try {
    const res = await fetch(input, init);
    if (res.status === 429) {
      gate.rateLimited(HELIUS_PRIORITY.copy);
    } else {
      gate.ok(HELIUS_PRIORITY.copy);
      meter.record(credits, HELIUS_PRIORITY.copy, calls);
    }
    return res;
  } finally {
    gate.release();
  }
}
