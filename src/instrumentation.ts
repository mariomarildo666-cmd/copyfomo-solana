// Runs once when a Next.js server instance starts, before it serves anything (finding F11 hardening).
// The web process must never hold WALLET_SEAL_PRIVATE_KEY: only the worker opens agent keys. src/lib/config.ts
// already scrubs it (and refuses to run in live mode) on first import; failing here stops the server at boot, before
// any request, whatever the mode, so a misplaced key is noticed at once instead of sitting in process.env.
export function register(): void {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.WALLET_SEAL_PRIVATE_KEY && process.env.WALLET_SEAL_PRIVATE_KEY.trim() !== "") {
    delete process.env.WALLET_SEAL_PRIVATE_KEY;
    throw new Error(
      "FATAL: WALLET_SEAL_PRIVATE_KEY is set in the web process environment. Only the worker may hold it: move it to " +
        ".env.worker (npm run worker loads it; Next.js never does), delete .next/cache (it snapshots env) and restart.",
    );
  }
}
