// One serial queue per agent: copy fills, close-alls and withdrawals for the same agent never overlap
// (so balances and sleeves are read and written by one task at a time). Different agents run in parallel.

import { errText, logger } from "./log";

const log = logger("queue");
const tails = new Map<string, Promise<void>>();
let shuttingDown = false;

/**
 * Graceful shutdown started: queued tasks that have not broadcast anything yet must stand down (buys are
 * skipped, sells are parked for the next worker); only sends already in flight are waited for.
 */
export function beginShutdown(): void {
  shuttingDown = true;
}

export function isShuttingDown(): boolean {
  return shuttingDown;
}

/** Append `task` to the agent's queue. Resolves/rejects with the task's own outcome. */
export function enqueueForAgent<T>(agentId: string, task: () => Promise<T>): Promise<T> {
  const prev = tails.get(agentId) ?? Promise.resolve();
  const run = prev.then(task);
  // The chain itself never rejects, so one failed task cannot poison the agent's later tasks.
  const tail = run.then(
    () => undefined,
    (err: unknown) => {
      log.debug("task failed", { agent: agentId, err: errText(err) });
    },
  );
  tails.set(agentId, tail);
  void tail.then(() => {
    if (tails.get(agentId) === tail) tails.delete(agentId);
  });
  return run;
}

export function pendingAgentQueues(): number {
  return tails.size;
}

/** Wait until every queued task has settled (or `timeoutMs` passes). Used for graceful shutdown. */
export async function drainQueues(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (tails.size > 0) {
    const left = deadline - Date.now();
    if (left <= 0) return false;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.all([...tails.values()]),
      new Promise((resolve) => {
        timer = setTimeout(resolve, left);
      }),
    ]);
    clearTimeout(timer);
  }
  return true;
}
