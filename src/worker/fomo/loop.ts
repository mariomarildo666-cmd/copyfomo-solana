// Loop helpers for the FOMO indexer: each loop catches its own errors and never crashes the worker.

import { kvGet, kvSet } from "@/lib/db";
import { logger } from "../log";
import { dailyDue, dailyFailurePlan } from "./policy";
import { safeErr, state } from "./state";

const log = logger("fomo");

export interface LoopHandle {
  /** Run the next iteration now (no-op while one is running). */
  kick(): void;
  /** Stop scheduling and wait (≤ timeoutMs) for the running iteration. */
  stop(timeoutMs?: number): Promise<void>;
}

/**
 * Run `fn` every `intervalMs` (setTimeout chain: never overlapping). `fn` may return a number to override the
 * delay before its next run (e.g. "more work: continue in 500 ms").
 */
export function every(
  name: string,
  intervalMs: number,
  fn: () => Promise<number | void>,
  opts: { initialDelayMs?: number } = {},
): LoopHandle {
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | null = null;
  let stopped = false;

  const schedule = (delay: number) => {
    if (stopped || state.stopping) return;
    clearTimeout(timer);
    timer = setTimeout(tick, Math.max(0, delay));
  };

  const tick = () => {
    if (stopped || running) return;
    let next = intervalMs;
    running = (async () => {
      try {
        const r = await fn();
        if (typeof r === "number" && Number.isFinite(r)) next = r;
      } catch (err) {
        log.warn(`${name} failed`, { err: safeErr(err) });
      }
    })().finally(() => {
      running = null;
      schedule(next);
    });
  };

  schedule(opts.initialDelayMs ?? intervalMs);
  return {
    kick() {
      if (!running) schedule(0);
    },
    async stop(timeoutMs = 5_000) {
      stopped = true;
      clearTimeout(timer);
      if (running) await Promise.race([running, new Promise((r) => setTimeout(r, timeoutMs))]);
    },
  };
}

const JOBS_KV_KEY = "fomo:jobs";

async function lastRuns(): Promise<Record<string, string>> {
  const row = await kvGet<unknown>(JOBS_KV_KEY).catch(() => null);
  const v = row?.value;
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: Record<string, string> = {};
  for (const [k, s] of Object.entries(v as Record<string, unknown>)) if (typeof s === "string") out[k] = s;
  return out;
}

async function recordRun(name: string): Promise<void> {
  const fresh = await lastRuns();
  fresh[name] = new Date().toISOString();
  await kvSet(JOBS_KV_KEY, fresh);
}

/**
 * A daily job whose last run survives restarts (Kv "fomo:jobs"). Checked every 10 min; runs when due
 * (`hourUtc`: once per UTC day at or after that hour; else ≥ 23.5 h after the last run). A failed run is
 * retried after 1 h, then 2 h; after 3 failures it is recorded as run (skipped until its next slot), so a job
 * that pays for its calls is not re-billed every 10 minutes.
 */
export function daily(name: string, fn: () => Promise<void>, opts: { hourUtc?: number; initialDelayMs?: number } = {}): LoopHandle {
  let failures = 0;
  let retryAt = 0;
  return every(
    `${name} (daily)`,
    10 * 60_000,
    async () => {
      const runs = await lastRuns();
      const last = runs[name] ? Date.parse(runs[name]!) : null;
      if (!dailyDue(Number.isFinite(last) ? last : null, Date.now(), opts.hourUtc)) return;
      if (Date.now() < retryAt) return;
      try {
        await fn();
      } catch (err) {
        failures++;
        const plan = dailyFailurePlan(failures);
        if (plan.giveUp) {
          log.warn(`${name} failed ${failures} times; skipped until its next daily slot`, { err: safeErr(err) });
          failures = 0;
          retryAt = 0;
          await recordRun(name);
          return;
        }
        retryAt = Date.now() + plan.retryInMs;
        throw err;
      }
      failures = 0;
      retryAt = 0;
      await recordRun(name);
    },
    { initialDelayMs: opts.initialDelayMs ?? 60_000 },
  );
}
