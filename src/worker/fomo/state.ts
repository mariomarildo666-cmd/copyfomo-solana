// Shared runtime state of the FOMO indexer (one per worker process) + the tracked-set refresh.
// Only this folder reads or writes it. Nothing here is ever sent to a client (status.ts publishes a summary).

import { config } from "@/lib/config";
import { kvGet, kvSet, prisma } from "@/lib/db";
import { retrackReset } from "@/lib/fomo";
import { fomoSeedByWallet } from "@/lib/fomo-seed";
import { redactSecrets, type HeliusCaps } from "@/lib/helius";
import { isInfrastructureAddress } from "@/lib/infra";
import { errText, logger } from "../log";
import { noiseBreaker } from "../noise";
import { RollingCounter } from "./policy";

const log = logger("fomo");

export type StreamMode = "stream" | "logs" | "off";
/** Which account the S1 transactionSubscribe requires: FOMO's relayer (sees xchain too) or the marker (fallback). */
export type S1Filter = "relayer" | "marker";

export interface TrackedInfo {
  origin: string;
  trackedAtMs: number | null;
  lastTradeAtMs: number | null;
}

class IndexerState {
  /** Indexer running (startFomoIndexer booted with a key). */
  enabled = false;
  stopping = false;
  caps: HeliusCaps | null = null;
  mode: StreamMode = "off";
  /** Stream socket(s) open and subscribed. */
  connected = false;
  /** The live stream has been subscribed at least once in this process (gap repair exists from then on). */
  streamReady = false;
  s1Filter: S1Filter | null = null;
  /**
   * Last frame (notification or pong) received while every stream socket was subscribed, ms. The persisted
   * restart resume point is this, or earlier when a stretch is still unrepaired (status.ts, resumePointMs).
   */
  lastMsgAt: number | null = null;
  /** Newest FOMO trade seen on a live source (stream / logs / watcher), ms. */
  lastFomoTradeAt: number | null = null;

  /** FomoWallet status "tracked". */
  tracked = new Map<string, TrackedInfo>();
  /** Followed by a funded (active / paused) agent: top backfill priority, never demoted. */
  followed = new Set<string>();
  /**
   * Watched by this worker's copy engine (followed by active agents). Logs mode subscribes them itself too (the
   * watcher's hand-over is not a complete source) and gives them top priority.
   */
  watched = new Set<string>();
  /** Wallets the live stream currently covers (tS: the S1 accountInclude; logs: acked logsSubscribe). */
  covered = new Set<string>();
  /** Tracked wallets the live stream cannot cover (logs-mode overflow), with the time coverage stopped. */
  uncovered = new Map<string, number>();
  /**
   * Logs mode: planned wallets whose logsSubscribe failed (retried with backoff), with the time live coverage
   * was lost. Owned by stream.ts (logsPlan() owns `uncovered`); both make the wallet's windows read partial.
   */
  subscribeFailed = new Map<string, number>();
  /** Bumped whenever the tracked / followed / watched sets change. */
  trackedVersion = 0;

  /** Drift counters over the last hour (§2.7), fed by live sources only. */
  readonly noMarkerSwaps = new RollingCounter();
  readonly unknownRouter = new RollingCounter();
  readonly trades = new RollingCounter();

  /** gTFA "full" with maxSupportedTransactionVersion 1 verified on the first backfill call (null: not yet). */
  gtfaFullOk: boolean | null = null;

  /** Live coverage for a wallet: backfill of a new wallet waits until the stream covers it (§4.2). */
  isLiveCovered(wallet: string): boolean {
    // While down after a first subscribe, the reconnect gap-fill repairs anything missed. Before the first
    // subscribe nothing would repair the stretch between the backfill's newest page and the subscription.
    if (!this.connected) return this.streamReady;
    return this.covered.has(wallet);
  }

  /** When the live stream stopped covering this tracked wallet (overflow or a failing subscribe), else null. */
  liveHoleSince(wallet: string): number | null {
    const a = this.uncovered.get(wallet);
    const b = this.subscribeFailed.get(wallet);
    if (a === undefined) return b ?? null;
    return b === undefined ? a : Math.min(a, b);
  }
}

export const state = new IndexerState();

/** Error text safe to log: single line, Helius key scrubbed. */
export function safeErr(err: unknown): string {
  return redactSecrets(errText(err));
}

const ms = (d: Date | null | undefined): number | null => (d ? d.getTime() : null);

function sameKeys(a: ReadonlyMap<string, unknown> | ReadonlySet<string>, b: ReadonlyMap<string, unknown> | ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const k of a.keys()) if (!b.has(k)) return false;
  return true;
}

/** Agents whose followed wallets are indexed: FUNDED ones only (finding F14: an unfunded agent costs nothing). */
const FUNDED_STATUSES = ["active", "paused"];
const USER_PROMOTIONS_KV_KEY = "fomo:userPromotions";
/** Kv map wallet → ISO time a window was last eligible (written by stats.ts; same key as promote.ts). */
const LAST_ELIGIBLE_KV_KEY = "fomo:lastEligibleAt";

/**
 * Followed (non-seed) wallets the indexer tracks at most — in total and newly per UTC day. Following a wallet is
 * free in paper mode, so without a cap anyone could fill the tracked set (and the stream) with arbitrary wallets.
 * Copying never depends on this: the copy watcher watches every followed wallet regardless.
 */
export function userTrackedCap(maxTracked: number = config.fomoMaxTracked): number {
  return Math.max(20, Math.floor(maxTracked / 2));
}
export function userPromotionsPerDay(maxTracked: number = config.fomoMaxTracked): number {
  return Math.max(10, Math.floor(maxTracked / 8));
}

let infraSwept = false;
let lastTrippedKey = "";
let lastCapWarnAt = 0;

/**
 * One-time startup sweep (finding F13): FomoWallet rows that are infrastructure (FOMO relayer / marker, mints,
 * programs, off-curve addresses) are marked excluded, whatever created them.
 */
async function sweepInfrastructureWallets(): Promise<void> {
  const rows = await prisma.fomoWallet.findMany({ where: { status: { not: "excluded" } }, select: { wallet: true } });
  const bad = rows.map((r) => r.wallet).filter((w) => isInfrastructureAddress(w));
  if (bad.length === 0) return;
  await prisma.fomoWallet.updateMany({ where: { wallet: { in: bad } }, data: { status: "excluded", statsDirty: false } });
  await prisma.fomoWalletStats.updateMany({ where: { wallet: { in: bad } }, data: { rank: null } });
  log.warn("infrastructure addresses excluded from indexing", { count: bad.length });
}

async function userPromotionsToday(day: string): Promise<number> {
  const row = await kvGet<{ day?: unknown; count?: unknown }>(USER_PROMOTIONS_KV_KEY).catch(() => null);
  const v = row?.value;
  return v && v.day === day && typeof v.count === "number" ? v.count : 0;
}

/**
 * Reload the tracked / followed / watched sets from the DB.
 *  - followed = wallets followed by FUNDED agents (active / paused); infrastructure addresses never count (F13).
 *  - Followed wallets that are not tracked yet become tracked with a clean slate (retrackReset), except excluded
 *    ones and beyond the user caps (userTrackedCap in total, userPromotionsPerDay per UTC day; seeds are exempt).
 *  - Tracked "user" wallets no funded agent follows any more and that were never eligible are demoted to candidate
 *    right away (finding F14); ones that ranked keep the normal 14-day demotion (promote.ts).
 * Returns true when the tracked, followed or watched set — or the noise-tripped set — changed.
 */
export async function refreshTracked(): Promise<boolean> {
  if (!infraSwept) {
    infraSwept = true;
    await sweepInfrastructureWallets().catch((err: unknown) => log.warn("infrastructure sweep failed", { err: safeErr(err) }));
  }
  const [trackedRows, followedRows, watchedRows] = await Promise.all([
    prisma.fomoWallet.findMany({
      where: { status: "tracked" },
      select: { wallet: true, origin: true, trackedAt: true, lastTradeAt: true },
    }),
    prisma.trader.findMany({
      where: { follows: { some: { agent: { status: { in: FUNDED_STATUSES } } } } },
      select: { wallet: true },
    }),
    // Followed by active agents: a subset of the watcher's watch set (watchset.ts also adds held-only traders).
    // Logs mode subscribes them first; the watcher's hand-over is only a bonus (deduped by signature).
    prisma.trader.findMany({
      where: {
        follows: { some: { agent: config.mode === "live" ? { status: "active" } : { status: "active", mode: "paper" } } },
      },
      select: { wallet: true },
    }),
  ]);

  const tracked = new Map<string, TrackedInfo>();
  for (const r of trackedRows) {
    if (isInfrastructureAddress(r.wallet)) continue;
    tracked.set(r.wallet, { origin: r.origin, trackedAtMs: ms(r.trackedAt), lastTradeAtMs: ms(r.lastTradeAt) });
  }
  const followed = new Set(followedRows.map((r) => r.wallet).filter((w) => !isInfrastructureAddress(w)));
  const watched = new Set(watchedRows.map((r) => r.wallet).filter((w) => !isInfrastructureAddress(w)));
  const seed = fomoSeedByWallet();

  const missing = [...followed].filter((w) => !tracked.has(w));
  if (missing.length > 0) {
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    const existing = await prisma.fomoWallet.findMany({
      where: { wallet: { in: missing } },
      select: { wallet: true, status: true, origin: true },
    });
    const byWallet = new Map(existing.map((r) => [r.wallet, r]));
    let userTracked = [...tracked.values()].filter((t) => t.origin === "user").length;
    const today = await userPromotionsToday(day);
    let promotedToday = today;
    let capped = 0;
    for (const wallet of missing) {
      const row = byWallet.get(wallet);
      if (row?.status === "excluded") continue;
      const origin = seed.has(wallet) ? "seed" : (row?.origin ?? "user");
      const counts = origin === "user";
      if (counts && (userTracked >= userTrackedCap() || promotedToday >= userPromotionsPerDay())) {
        capped++;
        continue;
      }
      try {
        if (!row) {
          await prisma.fomoWallet.create({ data: { wallet, origin, status: "tracked", trackedAt: now } });
        } else {
          const res = await prisma.fomoWallet.updateMany({ where: { wallet, status: "candidate" }, data: retrackReset(now) });
          if (res.count === 0) continue;
        }
        tracked.set(wallet, { origin, trackedAtMs: now.getTime(), lastTradeAtMs: null });
        if (counts) {
          userTracked++;
          promotedToday++;
        }
        log.info("followed wallet now tracked", { wallet });
      } catch (err) {
        log.warn("could not track followed wallet", { wallet, err: safeErr(err) });
      }
    }
    if (promotedToday !== today) await kvSet(USER_PROMOTIONS_KV_KEY, { day, count: promotedToday }).catch(() => undefined);
    if (capped > 0 && Date.now() - lastCapWarnAt > 3600_000) {
      lastCapWarnAt = Date.now();
      log.warn("followed wallets over the indexing cap stay unindexed (copying is unaffected)", {
        capped,
        userTracked,
        cap: userTrackedCap(),
        perDay: userPromotionsPerDay(),
      });
    }
  }

  // No funded agent follows these user wallets any more and they never ranked: stop indexing them now (F14).
  const orphans = [...tracked].filter(([w, t]) => t.origin === "user" && !followed.has(w) && !seed.has(w)).map(([w]) => w);
  if (orphans.length > 0) {
    const [eligibleRows, lastEligible] = await Promise.all([
      prisma.fomoWalletStats.findMany({ where: { wallet: { in: orphans }, eligible: true }, select: { wallet: true } }),
      kvGet<Record<string, unknown>>(LAST_ELIGIBLE_KV_KEY).catch(() => null),
    ]);
    const everEligible = new Set(eligibleRows.map((r) => r.wallet));
    const le: Record<string, unknown> = lastEligible?.value && typeof lastEligible.value === "object" ? lastEligible.value : {};
    const demote = orphans.filter((w) => !everEligible.has(w) && typeof le[w] !== "string");
    if (demote.length > 0) {
      await prisma.$transaction([
        prisma.fomoWallet.updateMany({
          where: { wallet: { in: demote }, status: "tracked", origin: "user" },
          data: { status: "candidate", statsDirty: false },
        }),
        prisma.fomoWalletStats.updateMany({ where: { wallet: { in: demote } }, data: { rank: null } }),
      ]);
      for (const w of demote) tracked.delete(w);
      log.info("unfollowed user wallets demoted to candidate (never eligible)", { demoted: demote.length });
    }
  }

  // Wallets the noise breaker tripped (or released) change the logs plan too.
  const trippedKey = [...noiseBreaker.tripped()].sort().join(",");
  const trippedChanged = trippedKey !== lastTrippedKey;
  lastTrippedKey = trippedKey;

  const changed =
    trippedChanged || !sameKeys(tracked, state.tracked) || !sameKeys(watched, state.watched) || !sameKeys(followed, state.followed);
  state.tracked = tracked;
  state.followed = followed;
  state.watched = watched;
  if (changed) state.trackedVersion++;
  return changed;
}
