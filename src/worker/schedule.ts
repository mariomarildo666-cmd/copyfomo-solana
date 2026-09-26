// Pure cadence rules for the worker's Helius-billed loops (design §5.8; see schedule.test.ts).
//  - watcher backfill poll: every WORKER_POLL_MS (60 s); every 5 s for 2 minutes after a stream/WebSocket
//    reconnect or transport switch (4 s polling cost 21,600 credits/day per followed wallet);
//  - live balances: awaiting_deposit every 30 s, active/paused every 300 s, plus a forced refresh after each
//    fill or withdrawal (15 s polling cost 5,760 credits/day per live agent).

export const FAST_POLL_MS = 5_000;
export const FAST_POLL_WINDOW_MS = 2 * 60_000;

/** Delay before the next watcher poll. */
export function pollDelayMs(now: number, fastPollUntil: number, baseMs: number): number {
  const base = Number.isFinite(baseMs) && baseMs > 0 ? baseMs : 60_000;
  return now < fastPollUntil ? Math.min(FAST_POLL_MS, base) : base;
}

export const BALANCE_REFRESH_MS: Readonly<Record<string, number>> = Object.freeze({
  awaiting_deposit: 30_000,
  active: 300_000,
  paused: 300_000,
});

/** True when a live agent's stored balance is older than its status cadence (never for stopped/unknown). */
export function balanceRefreshDue(status: string, balanceAt: Date | number | null, now: number): boolean {
  const every = BALANCE_REFRESH_MS[status];
  if (every === undefined) return false;
  if (balanceAt === null) return true;
  const t = typeof balanceAt === "number" ? balanceAt : balanceAt.getTime();
  return !Number.isFinite(t) || now - t >= every;
}
