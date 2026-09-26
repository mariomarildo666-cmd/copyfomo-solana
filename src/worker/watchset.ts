// Pure watch-set composition (no I/O — see watchset.test.ts).
// Watch set = traders followed by active agents PLUS traders from whom an active/paused agent still holds an
// open sleeve: a trader the agent stopped following must still be watched so their later sell closes it.

export interface TraderRef {
  id: string;
  wallet: string;
  lastSignature: string | null;
}

export interface WatchTarget extends TraderRef {
  /** Followed by at least one active agent (buys and sells are copied). */
  followed: boolean;
  /** Some active/paused agent holds a sleeve bought from this trader (their sells matter). */
  holding: boolean;
}

/** Merge both lists by wallet (first row wins for id / cursor), dropping wallets `isValid` rejects. */
export function composeWatchSet(
  followed: readonly TraderRef[],
  held: readonly TraderRef[],
  isValid: (wallet: string) => boolean,
): Map<string, WatchTarget> {
  const out = new Map<string, WatchTarget>();
  const add = (t: TraderRef, flag: "followed" | "holding") => {
    if (!isValid(t.wallet)) return;
    const cur = out.get(t.wallet) ?? { id: t.id, wallet: t.wallet, lastSignature: t.lastSignature, followed: false, holding: false };
    cur[flag] = true;
    out.set(t.wallet, cur);
  };
  for (const t of followed) add(t, "followed");
  for (const t of held) add(t, "holding");
  return out;
}

/** Stable key of a wallet set (order-independent), to detect when a subscription must change. */
export function walletSetKey(wallets: Iterable<string>): string {
  return [...new Set(wallets)].sort().join(",");
}
