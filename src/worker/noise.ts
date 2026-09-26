// Per-wallet notification-rate breaker (finding F13, defense in depth). A followed "trader" that is really a busy
// account (an exchange hot wallet, an airdrop target, a spammed address) makes every stream notification about it
// cost credits and CPU, at priorities the Helius daily cap never pauses. Real traders sign a handful of
// transactions a minute; a wallet producing more than `maxPerMin` notifications in which it is NOT the signer (or,
// on logs streams where the signer is unknown, notifications at all) is "tripped": its live subscriptions are
// dropped for `tripMs` and it is covered by the slower paths (the copy watcher's poll, the indexer's gap-fill)
// until it cools down. One process-wide instance is shared by the copy watcher and the FOMO indexer.

export interface NoiseBreakerOptions {
  /** Notifications per rolling minute that trip the breaker. */
  maxPerMin: number;
  /** How long a tripped wallet stays off the live streams. */
  tripMs: number;
  /** Bound on remembered wallets (untripped entries are pruned first). */
  maxEntries: number;
}

const DEFAULTS: NoiseBreakerOptions = { maxPerMin: 600, tripMs: 15 * 60_000, maxEntries: 20_000 };
const WINDOW_MS = 60_000;

interface Entry {
  windowStart: number;
  count: number;
  trippedUntil: number;
}

export class NoiseBreaker {
  private readonly entries = new Map<string, Entry>();
  private readonly opts: NoiseBreakerOptions;

  constructor(opts: Partial<NoiseBreakerOptions> = {}) {
    this.opts = { ...DEFAULTS, ...opts };
  }

  /** Count `n` noisy notifications for `wallet`. Returns true when this call tripped the breaker. */
  record(wallet: string, n = 1, now: number = Date.now()): boolean {
    let e = this.entries.get(wallet);
    if (!e) {
      if (this.entries.size >= this.opts.maxEntries) this.prune(now);
      e = { windowStart: now, count: 0, trippedUntil: 0 };
      this.entries.set(wallet, e);
    }
    if (e.trippedUntil > now) return false;
    if (now - e.windowStart >= WINDOW_MS) {
      e.windowStart = now;
      e.count = 0;
    }
    e.count += n;
    if (e.count > this.opts.maxPerMin) {
      e.trippedUntil = now + this.opts.tripMs;
      e.count = 0;
      e.windowStart = now;
      return true;
    }
    return false;
  }

  isTripped(wallet: string, now: number = Date.now()): boolean {
    const e = this.entries.get(wallet);
    return e !== undefined && e.trippedUntil > now;
  }

  /** Wallets currently tripped. */
  tripped(now: number = Date.now()): Set<string> {
    const out = new Set<string>();
    for (const [w, e] of this.entries) if (e.trippedUntil > now) out.add(w);
    return out;
  }

  private prune(now: number): void {
    for (const [w, e] of this.entries) {
      if (e.trippedUntil <= now && now - e.windowStart >= WINDOW_MS) this.entries.delete(w);
    }
    // Still full (a flood of distinct wallets): drop the oldest untripped entries.
    if (this.entries.size >= this.opts.maxEntries) {
      for (const [w, e] of this.entries) {
        if (this.entries.size < this.opts.maxEntries * 0.9) break;
        if (e.trippedUntil <= now) this.entries.delete(w);
      }
    }
  }
}

/** The worker's shared breaker (copy watcher + FOMO indexer logs stream). */
export const noiseBreaker = new NoiseBreaker();
