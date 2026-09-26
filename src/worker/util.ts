// Small async helpers shared by the worker modules.

import { Prisma } from "@prisma/client";

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Resolve to `fallback` if `p` has not settled within `ms` (p keeps running; its rejection is swallowed). */
export function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([p.catch(() => fallback), timeout]).finally(() => clearTimeout(timer));
}

/** Prisma unique-constraint violation (e.g. CopyTrade @@unique([agentId, eventId]), TraderEvent.signature). */
export function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

export function isRateLimited(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /\b429\b|too many requests|rate limit/i.test(msg);
}

/** Insertion-ordered set with a size cap: the oldest entries fall out first. */
export class LruSet {
  private readonly items = new Map<string, true>();
  constructor(private readonly max: number) {}

  has(key: string): boolean {
    return this.items.has(key);
  }

  add(key: string): void {
    this.items.delete(key);
    this.items.set(key, true);
    while (this.items.size > this.max) {
      const oldest = this.items.keys().next();
      if (oldest.done) break;
      this.items.delete(oldest.value);
    }
  }

  delete(key: string): void {
    this.items.delete(key);
  }

  get size(): number {
    return this.items.size;
  }
}

const BACKOFF_START_MS = 500;
const BACKOFF_MAX_MS = 30_000;

/**
 * Bounded-concurrency gate for RPC calls with a shared exponential backoff: when any call is
 * rate-limited (HTTP 429), every caller pauses until the backoff window passes.
 */
/** Thrown instead of queueing when a limiter's wait queue is full (a notification flood must not grow memory). */
export class RpcQueueFullError extends Error {
  constructor() {
    super("RPC queue full; request dropped");
    this.name = "RpcQueueFullError";
  }
}

export class RpcLimiter {
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  private pausedUntil = 0;
  private backoffMs = 0;

  constructor(
    private readonly concurrency: number,
    private readonly onBackoff?: (ms: number) => void,
    /** Callers waiting for a slot beyond this are refused (RpcQueueFullError) instead of queued without bound. */
    private readonly maxWaiters: number = 2_000,
  ) {}

  /** Callers waiting for a slot right now. */
  get queued(): number {
    return this.waiters.length;
  }

  /** Run `fn` under the concurrency cap; a 429 is retried (after the shared backoff) up to `retries` times. */
  async run<T>(fn: () => Promise<T>, retries = 3): Promise<T> {
    await this.acquire();
    try {
      for (let attempt = 0; ; attempt++) {
        const wait = this.pausedUntil - Date.now();
        if (wait > 0) await sleep(wait);
        try {
          const out = await fn();
          this.backoffMs = 0;
          return out;
        } catch (err) {
          if (!isRateLimited(err) || attempt >= retries) throw err;
          this.backoffMs = Math.min(this.backoffMs ? this.backoffMs * 2 : BACKOFF_START_MS, BACKOFF_MAX_MS);
          this.pausedUntil = Math.max(this.pausedUntil, Date.now() + this.backoffMs);
          this.onBackoff?.(this.backoffMs);
        }
      }
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.concurrency) {
      this.active++;
      return Promise.resolve();
    }
    if (this.waiters.length >= this.maxWaiters) return Promise.reject(new RpcQueueFullError());
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) next(); // hand the slot over directly; `active` stays the same
    else this.active--;
  }
}

/** Run `fn` over `items` with at most `limit` in flight. Errors are the callback's responsibility. */
export async function forEachLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++]!;
      await fn(item);
    }
  });
  await Promise.all(workers);
}
