// Watches trader wallets and turns their swaps into TraderEvent rows.
//  - watch set (watchset.ts) = traders followed by active agents + traders from whom an active/paused agent still
//    holds an open sleeve (their later sells must close it even after an unfollow); refreshed every 10 s
//  - transport "stream" (when the Helius caps probe says transactionSubscribe works — Developer plan): one
//    transactionSubscribe over every watched wallet (txstream.ts; no accountRequired, so sells on any venue are
//    seen). The payload carries the whole transaction: no per-tx getParsedTransaction.
//    Fallback "logs": web3.js logsSubscribe per wallet + getParsedTransaction; with COPY_VENUE=fomo a notification
//    whose logs show no FOMO router / Relay is only fetched when an agent holds a sleeve from that trader.
//  - backfill: getSignaturesForAddress(until: cursor) every WORKER_POLL_MS (60 s), every 5 s for 2 minutes after a
//    stream / WebSocket reconnect or a transport switch, and once right after startup; paginated back to the cursor
//    (up to MAX_POLL_PAGES pages); processed oldest-first
//  - age (finding F20): BUYS older than WORKER_MAX_EVENT_AGE_MS are never copied; SELLS are copied up to
//    MAX_SELL_AGE_MS old (an exit made while the worker was down must still close the sleeve). A stale polled
//    signature is only fetched when an agent may hold a sleeve from that trader
//  - logs transport pre-filter (finding F21): a non-FOMO notification is fetched when an agent holds — or may be
//    about to hold (a recent buy, a copy buy still settling) — a sleeve from that trader; otherwise it is remembered
//    and re-checked by the next poll instead of being dropped
//  - first sight of a wallet: the newest signature becomes the cursor; history is never copied
//  - dedupe: in-memory LRU + in-flight map + TraderEvent.signature unique
//  - rule R on every transaction: TraderEvent.venue "fomo" | "other"; FOMO trades / conversions / cross-chain
//    orders are handed to the indexer ingest (source "watcher"); conversions and cross-chain never become events
//  - time: pushed notifications (stream / logs) use the LOCAL RECEIVE TIME as TraderEvent.blockTime, for latency and
//    max-age (transactionSubscribe carries no blockTime and this machine's clock is seconds off chain time);
//    polled signatures use the chain blockTime.

import { PublicKey, type ConfirmedSignatureInfo, type Logs, type ParsedTransactionWithMeta } from "@solana/web3.js";
import type { Prisma, TraderEvent as TraderEventRow } from "@prisma/client";
import WebSocket from "ws";
import { config, deriveWsUrl } from "@/lib/config";
import { prisma } from "@/lib/db";
import { classifyFomoTx, FOMO_RELAYERS, logsLookLikeFomoCandidate, type MiniTx } from "@/lib/fomo-chain";
import { getCachedCaps, HELIUS_PRIORITY, heliusConfigured, meter, probeCaps, type WebSocketCtor } from "@/lib/helius";
import { getSolUsd } from "@/lib/prices";
import { connection, isValidSolanaAddress } from "@/lib/solana";
import { getTokenMeta } from "@/lib/tokens";
import { isFomoIngestible, venueOf } from "./copyrules";
import { enqueueFomoTx } from "./fomo/ingest";
import { errText, logger } from "./log";
import { analyzeSwap, toSwapTx, type ParsedSwap, type SwapTx } from "./parser";
import { FAST_POLL_MS, FAST_POLL_WINDOW_MS, pollDelayMs } from "./schedule";
import { TxStream, type TxStreamState } from "./txstream";
import { forEachLimit, isUniqueViolation, LruSet, RpcLimiter, sleep, withTimeout } from "./util";
import { composeWatchSet, type WatchTarget } from "./watchset";
import { noiseBreaker } from "./noise";
import { isInfrastructureAddress } from "@/lib/infra";

const log = logger("watcher");

const REFRESH_MS = 10_000;
const SEEN_MAX = 20_000;
const RPC_CONCURRENCY = 4;
/** getSignaturesForAddress costs 1 credit whatever the limit: cover a whole 60 s window of an active wallet. */
const POLL_LIMIT = 100;
const TX_FETCH_ATTEMPTS = 6;
const TX_FETCH_BACKOFF_MS = 350;
const SYMBOL_TIMEOUT_MS = 1_500;
/** Mainnet now carries v1 transactions (web3.js 1.99 parses them); asking for 0 would make those fail to fetch. */
const MAX_TX_VERSION = 1;
/** blockTime has 1s resolution; beyond this a negative detection lag is clock skew, not rounding. */
const CLOCK_SKEW_WARN_MS = 1_500;
const CLOCK_WARN_EVERY_MS = 10 * 60_000;
/** How often the cached Helius caps (Kv "helius:caps", written by the startup probe) are re-read. */
const CAPS_RECHECK_MS = 60_000;
/** With no cached caps this long after start, the watcher runs the (Kv-cached) probe itself. */
const CAPS_WAIT_MS = 60_000;
/** After a rejected subscribe or repeated connection failures, stay on logs mode this long before retrying. */
const STREAM_RETRY_MS = 30 * 60_000;
/** Consecutive stream drops without a successful subscribe (backoff 1 s → 60 s: about 3 minutes). */
const STREAM_MAX_FAILURES = 8;
/** A sell priced from the hourly SOL/USD table (display only) must be at most this old. */
const HOURLY_PRICE_MAX_AGE_MS = 6 * 3600_000;
/** Sells older than this (worker down for hours) are no longer copied; buys use WORKER_MAX_EVENT_AGE_MS. */
export const MAX_SELL_AGE_MS = 6 * 3600_000;
/** One poll walks back at most this many pages of POLL_LIMIT signatures to reach the cursor. */
const MAX_POLL_PAGES = 10;
/** A copy buy of this trader seen this recently may still become a sleeve (logs pre-filter). */
const RECENT_BUY_MS = 10 * 60_000;
/** Logs notifications skipped by the pre-filter are re-checked by polls for this long. */
const MAYBE_TTL_MS = 30 * 60_000;
const MAYBE_MAX = 5_000;
const HOLD_CACHE_MS = 5_000;

/**
 * Age policy for a detected trade (pure; finding F20). `side` null = not known yet (a polled signature before its
 * transaction is fetched): only signatures older than any copyable sell are dropped then.
 */
export function ageVerdict(p: { ageMs: number; side: "buy" | "sell" | null; maxEventAgeMs: number; maxSellAgeMs?: number }): "ok" | "drop" {
  const maxSell = Math.max(p.maxSellAgeMs ?? MAX_SELL_AGE_MS, p.maxEventAgeMs);
  if (p.side === "buy") return p.ageMs > p.maxEventAgeMs ? "drop" : "ok";
  return p.ageMs > maxSell ? "drop" : "ok";
}

type Outcome = "done" | "retry";
type Source = "stream" | "ws" | "poll";
export type WatchTransport = "stream" | "logs";

interface Ctx {
  source: Source;
  /** Local time the notification arrived (poll: time of the poll). */
  receivedAt: number;
  /** getSignaturesForAddress blockTime (unix seconds) for polled signatures. */
  blockTimeSec: number | null;
  /** Already-delivered transaction (stream); null → fetch it. */
  tx: SwapTx | null;
}

interface Watched {
  traderId: string;
  wallet: string;
  pubkey: PublicKey;
  /** logsSubscribe id (logs transport only). */
  subId: number | null;
  /** Last signature fully processed (Trader.lastSignature). */
  cursor: string | null;
  /** False until the first-sight cursor has been established. */
  ready: boolean;
  polling: boolean;
  followed: boolean;
  holding: boolean;
  /** Settles when the most recently noticed signature has been dispatched (or dropped). */
  dispatchTail: Promise<void>;
}

/** Agents this worker acts for, with the given statuses (a paper worker never touches live agents). */
function agentScope(statuses: string[]): Prisma.AgentWhereInput {
  return config.mode === "live" ? { status: { in: statuses } } : { status: { in: statuses }, mode: "paper" };
}

function isHeliusUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host.endsWith("helius-rpc.com") || host.endsWith("helius.xyz") || host.endsWith("helius.dev");
  } catch {
    return false;
  }
}

export class Watcher {
  private readonly watched = new Map<string, Watched>();
  private readonly seen = new LruSet(SEEN_MAX);
  /** Logs notifications the pre-filter skipped (signature → time): the poll re-checks them instead of fetching. */
  private readonly maybeSkipped = new Map<string, number>();
  private readonly holdCache = new Map<string, { at: number; value: boolean }>();
  private readonly inflight = new Map<string, Promise<Outcome>>();
  private readonly limiter = new RpcLimiter(RPC_CONCURRENCY, (ms) => log.warn("RPC rate limited, backing off", { ms }));
  private readonly logsWsIsHelius = isHeliusUrl(config.wsUrl || deriveWsUrl(config.rpcUrl));
  private refreshTimer: NodeJS.Timeout | undefined;
  private pollTimer: NodeJS.Timeout | undefined;
  private stopped = false;
  private refreshing = false;
  private polling = false;
  private clockWarnedAt = 0;

  private mode: WatchTransport = "logs";
  private stream: TxStream | null = null;
  private streamFailures = 0;
  private streamWasDown = false;
  private streamDisabledUntil = 0;
  private transportSelected = false;
  private startedAt = 0;
  private capsProbeStarted = false;
  private capsKnown = false;
  private capsTs = false;
  private capsCheckedAt = 0;
  private fastPollUntil = 0;
  private logsSocketHooked = false;
  private logsSocketOpenedOnce = false;
  private unparsedWarned = false;

  constructor(private readonly onEvent: (ev: TraderEventRow) => Promise<void>) {}

  get size(): number {
    return this.watched.size;
  }

  /** "stream" (Helius transactionSubscribe) or "logs" (web3.js logsSubscribe fallback). */
  get transport(): WatchTransport {
    return this.mode;
  }

  start(): void {
    this.startedAt = Date.now();
    // The FOMO indexer probes Helius features at startup; without it, probe here (cached 24 h in Kv).
    if (!config.fomoIndexer) this.probeCapsOnce();
    void this.startup();
  }

  /**
   * First watch-set refresh (cursors ready), then an immediate backfill poll: trades made while the worker was down
   * are picked up now, not a whole poll interval later (finding F20).
   */
  private async startup(): Promise<void> {
    await this.refreshTick();
    if (!this.stopped) void this.pollTick();
  }

  /** probeCaps answers from Kv when a fresh result exists; only a missing/stale one costs a probe. */
  private probeCapsOnce(): void {
    if (this.capsProbeStarted || !heliusConfigured()) return;
    this.capsProbeStarted = true;
    void probeCaps({ webSocket: WebSocket as unknown as WebSocketCtor })
      .then((caps) => {
        this.capsKnown = false; // re-read on the next refresh
        log.info("helius caps", { transactionSubscribe: caps.ts });
      })
      .catch((err: unknown) => log.warn("helius caps probe failed; using logsSubscribe", { err: errText(err) }));
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.refreshTimer);
    clearTimeout(this.pollTimer);
    this.stream?.stop();
    this.stream = null;
    await Promise.all([...this.watched.values()].map((w) => this.unsubscribeLogs(w)));
    this.watched.clear();
    await Promise.race([Promise.allSettled([...this.inflight.values()]), sleep(5_000)]);
  }

  // ── Timers ─────────────────────────────────────────────────────────────────────────────────

  private async refreshTick(): Promise<void> {
    clearTimeout(this.refreshTimer);
    await this.refresh();
    if (!this.stopped) this.refreshTimer = setTimeout(() => void this.refreshTick(), REFRESH_MS);
  }

  private schedulePoll(delayMs: number): void {
    clearTimeout(this.pollTimer);
    if (this.stopped) return;
    this.pollTimer = setTimeout(() => void this.pollTick(), delayMs);
  }

  private async pollTick(): Promise<void> {
    this.polling = true;
    try {
      await this.pollAll();
    } finally {
      this.polling = false;
    }
    this.schedulePoll(pollDelayMs(Date.now(), this.fastPollUntil, config.pollIntervalMs));
  }

  /** Poll every 5 s for the next 2 minutes (after a reconnect or transport switch). */
  private triggerFastPoll(reason: string): void {
    if (this.stopped) return;
    const wasFast = Date.now() < this.fastPollUntil;
    this.fastPollUntil = Date.now() + FAST_POLL_WINDOW_MS;
    if (!wasFast) log.info("fast polling for 2 min", { reason });
    if (!this.polling) this.schedulePoll(FAST_POLL_MS);
  }

  // ── Watch set ──────────────────────────────────────────────────────────────────────────────

  private async refresh(): Promise<void> {
    if (this.refreshing || this.stopped) return;
    this.refreshing = true;
    try {
      const select = { id: true, wallet: true, lastSignature: true } as const;
      const [followed, held] = await Promise.all([
        prisma.trader.findMany({ where: { follows: { some: { agent: agentScope(["active"]) } } }, select }),
        prisma.trader.findMany({
          where: { positions: { some: { rawAmount: { not: "0" }, agent: agentScope(["active", "paused"]) } } },
          select,
        }),
      ]);
      // Infrastructure (FOMO relayer / marker, mints, programs, PDAs) is never watched, whatever the DB says (F13).
      const wanted = composeWatchSet(followed, held, (w) => isValidSolanaAddress(w) && !isInfrastructureAddress(w));
      await this.selectTransport();
      for (const t of wanted.values()) {
        const w = this.watched.get(t.wallet);
        if (!w) this.add(t);
        else {
          w.followed = t.followed;
          w.holding = t.holding;
        }
      }
      for (const w of [...this.watched.values()]) {
        if (!wanted.has(w.wallet)) await this.remove(w);
      }
      this.syncSubscriptions();
      // Wallets whose first-sight cursor failed earlier (RPC error) get another try.
      const pending = [...this.watched.values()].filter((w) => !w.ready);
      await forEachLimit(pending, RPC_CONCURRENCY, (w) => this.initCursor(w));
    } catch (err) {
      log.warn("watch set refresh failed", { err: errText(err) });
    } finally {
      this.refreshing = false;
    }
  }

  private add(t: WatchTarget): void {
    const w: Watched = {
      traderId: t.id,
      wallet: t.wallet,
      pubkey: new PublicKey(t.wallet),
      subId: null,
      cursor: t.lastSignature,
      ready: t.lastSignature !== null,
      polling: false,
      followed: t.followed,
      holding: t.holding,
      dispatchTail: Promise.resolve(),
    };
    this.watched.set(t.wallet, w);
    if (this.mode === "logs") this.subscribeLogs(w);
    log.info("watching", {
      wallet: t.wallet,
      cursor: t.lastSignature ? "resume" : "new",
      why: t.followed ? "followed" : "open sleeve",
    });
  }

  private async remove(w: Watched): Promise<void> {
    this.watched.delete(w.wallet);
    this.holdCache.delete(w.traderId);
    await this.unsubscribeLogs(w);
    log.info("unwatched", { wallet: w.wallet });
  }

  /** First sight: remember the newest signature so nothing older is ever copied. */
  private async initCursor(w: Watched): Promise<void> {
    try {
      const [newest] = await this.limiter.run(() =>
        connection().getSignaturesForAddress(w.pubkey, { limit: 1 }, "confirmed"),
      );
      if (!this.isCurrent(w)) return;
      w.cursor = newest?.signature ?? null;
      if (newest) await prisma.trader.update({ where: { id: w.traderId }, data: { lastSignature: newest.signature } });
      w.ready = true;
      log.debug("cursor initialized", { wallet: w.wallet, sig: w.cursor ?? "none" });
    } catch (err) {
      log.warn("cursor init failed; will retry", { wallet: w.wallet, err: errText(err) });
    }
  }

  private isCurrent(w: Watched): boolean {
    return !this.stopped && this.watched.get(w.wallet) === w;
  }

  // ── Transport selection ────────────────────────────────────────────────────────────────────

  private async desiredTransport(): Promise<WatchTransport> {
    const now = Date.now();
    if (!heliusConfigured() || now < this.streamDisabledUntil) return "logs";
    // Until a probe result exists (the indexer writes it at startup), look again on every refresh.
    if (!this.capsKnown || now - this.capsCheckedAt >= CAPS_RECHECK_MS) {
      this.capsCheckedAt = now;
      const caps = await getCachedCaps().catch(() => null);
      this.capsKnown = caps !== null;
      this.capsTs = caps?.ts === true;
      // Nothing probed a minute after start (indexer not running?): probe from here.
      if (!this.capsKnown && now - this.startedAt > CAPS_WAIT_MS) this.probeCapsOnce();
    }
    return this.capsTs ? "stream" : "logs";
  }

  /** Pick stream vs logs (Helius caps probe, fallbacks) and switch when it changed. */
  private async selectTransport(): Promise<void> {
    const want = await this.desiredTransport();
    const first = !this.transportSelected;
    this.transportSelected = true;
    if (want === this.mode || this.stopped) return;
    log.info("watch transport", { from: first ? undefined : this.mode, to: want });
    this.mode = want;
    if (want === "stream") {
      this.streamFailures = 0;
      this.streamWasDown = false;
      this.stream = new TxStream({ onTx: (r, t) => this.onStreamTx(r, t), onState: (s, d) => this.onStreamState(s, d) });
      // Existing log subscriptions stay until the stream is subscribed (onStreamState), so there is no blind gap.
    } else {
      this.stream?.stop();
      this.stream = null;
    }
    if (!first) this.triggerFastPoll(`switched to ${want}`);
  }

  /** Point the active transport at the current watch set. */
  private syncSubscriptions(): void {
    if (this.stopped) return;
    // Wallets the noise breaker tripped stay off the live transports for a while; the poll still covers them.
    const tripped = noiseBreaker.tripped();
    if (this.mode === "stream") {
      this.stream?.setWallets([...this.watched.keys()].filter((w) => !tripped.has(w)));
    } else {
      this.hookLogsSocket();
      for (const w of this.watched.values()) {
        if (tripped.has(w.wallet)) void this.unsubscribeLogs(w);
        else if (w.subId === null) this.subscribeLogs(w);
      }
    }
  }

  /** Count a notification about `wallet` that it did not sign; trip → drop its live subscription (F13). */
  private noteNoise(wallet: string, n = 1): void {
    if (!noiseBreaker.record(wallet, n)) return;
    log.warn("wallet produces a flood of notifications it didn't sign; live subscription paused for 15 min (the poll still covers it)", { wallet });
    this.syncSubscriptions();
  }

  private onStreamState(state: TxStreamState, detail?: string): void {
    if (this.stopped || this.mode !== "stream") return;
    switch (state) {
      case "connected":
        log.debug("stream connected");
        return;
      case "subscribed":
        this.streamFailures = 0;
        log.info("stream subscribed", { detail });
        // The stream covers every watched wallet now: drop the logs fallback subscriptions.
        for (const w of this.watched.values()) void this.unsubscribeLogs(w);
        if (this.streamWasDown) this.triggerFastPoll("stream reconnected");
        this.streamWasDown = false;
        return;
      case "disconnected":
        this.streamWasDown = true;
        this.streamFailures++;
        log.warn("stream disconnected", { detail, failures: this.streamFailures });
        this.triggerFastPoll("stream disconnected");
        if (this.streamFailures >= STREAM_MAX_FAILURES) this.disableStream("repeated connection failures");
        return;
      case "rejected":
        this.disableStream(`subscribe rejected: ${detail ?? "unknown"}`);
        return;
    }
  }

  /** Fall back to logsSubscribe for STREAM_RETRY_MS. */
  private disableStream(reason: string): void {
    log.warn("transactionSubscribe unavailable; falling back to logsSubscribe", { reason, retryInMin: STREAM_RETRY_MS / 60_000 });
    this.streamDisabledUntil = Date.now() + STREAM_RETRY_MS;
    if (!this.refreshing) void this.refreshTick();
  }

  // ── Logs transport (fallback) ──────────────────────────────────────────────────────────────

  private subscribeLogs(w: Watched): void {
    if (w.subId !== null) return;
    try {
      w.subId = connection().onLogs(w.pubkey, (logs) => this.onLogs(w, logs), "confirmed");
    } catch (err) {
      log.warn("logs subscription failed; relying on polling", { wallet: w.wallet, err: errText(err) });
    }
  }

  private async unsubscribeLogs(w: Watched): Promise<void> {
    if (w.subId === null) return;
    const id = w.subId;
    w.subId = null;
    await connection()
      .removeOnLogsListener(id)
      .catch((err: unknown) => log.debug("unsubscribe failed", { wallet: w.wallet, err: errText(err) }));
  }

  /**
   * Best effort: web3.js reconnects its logs WebSocket on its own; hook its (internal) socket events so a
   * reconnect also triggers the 2-minute fast poll. Skipped silently when the internals are not there.
   */
  private hookLogsSocket(): void {
    if (this.logsSocketHooked) return;
    const rpcWs = (connection() as unknown as { _rpcWebSocket?: { on?: (event: string, fn: () => void) => unknown } })._rpcWebSocket;
    if (!rpcWs || typeof rpcWs.on !== "function") return;
    this.logsSocketHooked = true;
    rpcWs.on("open", () => {
      if (this.logsSocketOpenedOnce && this.mode === "logs") this.triggerFastPoll("logs websocket reconnected");
      this.logsSocketOpenedOnce = true;
    });
    rpcWs.on("close", () => {
      if (this.mode === "logs" && this.watched.size > 0) this.triggerFastPoll("logs websocket closed");
    });
  }

  /**
   * Might an active agent hold — or be about to hold — a sleeve from this trader? True with an open sleeve, a buy of
   * this trader detected recently (its copy may still be quoting / sending), or a copy buy still settling.
   */
  private async mayHold(w: Watched, opts: { cached?: boolean } = {}): Promise<boolean> {
    // Polls ask once per stale signature: a few seconds of caching keeps a long backfill cheap.
    const hit = this.holdCache.get(w.traderId);
    if (opts.cached && hit && Date.now() - hit.at < HOLD_CACHE_MS) return hit.value;
    const value = await this.mayHoldNow(w);
    this.holdCache.set(w.traderId, { at: Date.now(), value });
    return value;
  }

  private async mayHoldNow(w: Watched): Promise<boolean> {
    const since = new Date(Date.now() - RECENT_BUY_MS);
    const [positions, recentBuys, settling] = await Promise.all([
      prisma.position.count({ where: { traderId: w.traderId, rawAmount: { not: "0" }, agent: agentScope(["active"]) } }),
      prisma.traderEvent.count({ where: { traderId: w.traderId, side: "buy", detectedAt: { gte: since } } }),
      prisma.copyTrade.count({ where: { traderId: w.traderId, side: "buy", status: { in: ["pending", "sending"] } } }),
    ]);
    return positions + recentBuys + settling > 0;
  }

  private rememberSkipped(signature: string): void {
    const now = Date.now();
    this.maybeSkipped.set(signature, now);
    if (this.maybeSkipped.size > MAYBE_MAX) {
      for (const [sig, at] of this.maybeSkipped) {
        if (now - at > MAYBE_TTL_MS || this.maybeSkipped.size > MAYBE_MAX) this.maybeSkipped.delete(sig);
        else break;
      }
    }
  }

  private onLogs(w: Watched, logs: Logs): void {
    if (!this.isCurrent(w) || !logs.signature) return;
    if (this.logsWsIsHelius) meter.recordLogsNotification(HELIUS_PRIORITY.copy);
    // Logs carry no signer: every notification counts toward the breaker (real traders stay far below it).
    this.noteNoise(w.wallet);
    if (noiseBreaker.isTripped(w.wallet)) return;
    if (logs.err) {
      this.seen.add(logs.signature);
      return;
    }
    const ctx: Ctx = { source: "ws", receivedAt: Date.now(), blockTimeSec: null, tx: null };
    if (config.copyVenue === "fomo" && !logsLookLikeFomoCandidate(logs.logs)) {
      void this.fetchIfHolding(w, logs.signature, ctx);
      return;
    }
    void this.handle(w, logs.signature, ctx);
  }

  /**
   * COPY_VENUE=fomo pre-filter: a transaction without a FOMO router / Relay invoke can't be a FOMO buy, so it is
   * only worth a getParsedTransaction when an agent may hold a sleeve from this trader (it may be a sell elsewhere).
   * Waits for this wallet's earlier notifications to be dispatched first, so a buy noticed just before is counted.
   * A skipped signature is NOT marked seen: the next poll re-checks it (finding F21).
   */
  private async fetchIfHolding(w: Watched, signature: string, ctx: Ctx): Promise<void> {
    try {
      await w.dispatchTail;
      if (await this.mayHold(w)) {
        await this.handle(w, signature, ctx);
        return;
      }
      this.rememberSkipped(signature);
      log.debug("not a FOMO candidate; skipped", { wallet: w.wallet, sig: signature });
    } catch (err) {
      log.warn("sleeve check failed; fetching anyway", { wallet: w.wallet, err: errText(err) });
      await this.handle(w, signature, ctx);
    }
  }

  // ── Stream transport ───────────────────────────────────────────────────────────────────────

  private onStreamTx(result: Record<string, unknown>, receivedAt: number): void {
    if (this.stopped) return;
    const tx = toSwapTx(result);
    if (tx) {
      this.route(tx, { source: "stream", receivedAt, blockTimeSec: null, tx });
      return;
    }
    // Unexpected payload shape: fall back to fetching the transaction by signature.
    const signature = typeof result.signature === "string" ? result.signature : null;
    if (!signature || this.seen.has(signature)) return;
    if (!this.unparsedWarned) {
      this.unparsedWarned = true;
      log.warn("stream payload not understood; fetching transactions instead", { sig: signature });
    }
    void this.fetchTx(signature).then((raw) => {
      const fetched = raw ? toSwapTx(raw) : null;
      if (fetched) this.route(fetched, { source: "stream", receivedAt, blockTimeSec: null, tx: fetched });
    });
  }

  /** Process `tx` for each watched wallet that signed it; a watched wallet that only received something is noise. */
  private route(tx: SwapTx, ctx: Ctx): void {
    const targets: Watched[] = [];
    for (const k of tx.keys) {
      const w = this.watched.get(k.pubkey);
      if (!w) continue;
      if (k.signer) targets.push(w);
      else if (ctx.source === "stream") this.noteNoise(k.pubkey);
    }
    if (targets.length === 0) {
      this.seen.add(tx.signature);
      return;
    }
    for (const w of targets) void this.handle(w, tx.signature, ctx);
  }

  // ── Backfill ───────────────────────────────────────────────────────────────────────────────

  private async pollAll(): Promise<void> {
    if (this.stopped) return;
    const due = [...this.watched.values()].filter((w) => w.ready && !w.polling);
    await forEachLimit(due, RPC_CONCURRENCY, (w) => this.pollOne(w));
  }

  /** Signatures newer than the cursor, newest first, walking back page by page (a busy wallet or a long outage). */
  private async signaturesSinceCursor(w: Watched): Promise<ConfirmedSignatureInfo[]> {
    const out: ConfirmedSignatureInfo[] = [];
    let before: string | undefined;
    for (let page = 0; page < MAX_POLL_PAGES; page++) {
      const batch = await this.limiter.run(() =>
        connection().getSignaturesForAddress(w.pubkey, { until: w.cursor ?? undefined, before, limit: POLL_LIMIT }, "confirmed"),
      );
      out.push(...batch);
      if (batch.length < POLL_LIMIT || !this.isCurrent(w)) return out;
      before = batch[batch.length - 1]!.signature;
    }
    log.warn("more new signatures than one poll walks back; the oldest are skipped", { wallet: w.wallet, n: out.length });
    return out;
  }

  private async pollOne(w: Watched): Promise<void> {
    w.polling = true;
    try {
      const sigs = await this.signaturesSinceCursor(w);
      if (!this.isCurrent(w) || sigs.length === 0) return;

      let cursor = w.cursor;
      const polledAt = Date.now();
      // Oldest first, so a trader's buy is copied before the sell that follows it.
      for (const info of [...sigs].reverse()) {
        if (info.err) {
          this.seen.add(info.signature);
        } else {
          const ctx: Ctx = { source: "poll", receivedAt: polledAt, blockTimeSec: info.blockTime ?? null, tx: null };
          const outcome = await this.handle(w, info.signature, ctx);
          if (outcome === "retry") break; // keep the cursor here; the next poll retries
        }
        cursor = info.signature;
        if (!this.isCurrent(w)) return;
      }
      if (cursor && cursor !== w.cursor) {
        w.cursor = cursor;
        await prisma.trader.update({ where: { id: w.traderId }, data: { lastSignature: cursor } });
      }
    } catch (err) {
      log.warn("poll failed", { wallet: w.wallet, err: errText(err) });
    } finally {
      w.polling = false;
    }
  }

  // ── Per-signature processing ──────────────────────────────────────────────────────────────

  /** Dedupe, then process one signature. Concurrent callers for the same signature share one run. */
  private handle(w: Watched, signature: string, ctx: Ctx): Promise<Outcome> {
    if (this.seen.has(signature)) return Promise.resolve("done");
    const running = this.inflight.get(signature);
    if (running) return running;

    // Fetches run concurrently, but events are dispatched in the order their signatures were noticed
    // for this wallet: a buy whose tx fetch needed retries must still be copied before the sell after it.
    const turn = w.dispatchTail;
    let release!: () => void;
    w.dispatchTail = new Promise<void>((resolve) => (release = resolve));

    const p = this.process(w, signature, ctx, turn)
      .catch((err: unknown): Outcome => {
        log.warn("signature processing failed", { wallet: w.wallet, sig: signature, err: errText(err) });
        return "retry";
      })
      .then((outcome) => {
        if (outcome === "done") this.seen.add(signature);
        return outcome;
      })
      .finally(() => {
        release();
        this.inflight.delete(signature);
      });
    this.inflight.set(signature, p);
    return p;
  }

  private async process(w: Watched, signature: string, ctx: Ctx, turn: Promise<void>): Promise<Outcome> {
    const known = await prisma.traderEvent.findUnique({ where: { signature }, select: { id: true } });
    if (known) return "done";

    if (ctx.source === "poll" && this.maybeSkipped.has(signature)) {
      // The logs pre-filter skipped it earlier: fetch it only if a sleeve exists (or is settling) by now.
      if (!(await this.mayHold(w, { cached: true }))) {
        this.maybeSkipped.delete(signature);
        return "done";
      }
      this.maybeSkipped.delete(signature);
    }

    // A polled signature older than a copyable buy is only worth its transaction when it may close a sleeve (a
    // sell made while the worker was down); older than any copyable sell, never.
    if (ctx.source === "poll" && ctx.blockTimeSec !== null) {
      const ageMs = Date.now() - ctx.blockTimeSec * 1000;
      const tooOld = ageVerdict({ ageMs, side: null, maxEventAgeMs: config.maxEventAgeMs }) === "drop";
      if (tooOld || (ageMs > config.maxEventAgeMs && !(await this.mayHold(w, { cached: true })))) {
        log.debug("stale signature ignored", { wallet: w.wallet, sig: signature });
        return "done";
      }
    }

    let tx = ctx.tx;
    if (!tx) {
      const raw = await this.fetchTx(signature);
      if (!raw) {
        log.warn("transaction not available yet", { wallet: w.wallet, sig: signature, source: ctx.source });
        return "retry";
      }
      tx = toSwapTx(raw);
      if (!tx) {
        log.debug("transaction without usable meta; ignored", { wallet: w.wallet, sig: signature });
        return "done";
      }
    }

    // Rule R: FOMO's relayer-paid transactions feed the indexer; conversions and cross-chain orders are never copied.
    const fomo = classifyFomoTx(tx, w.wallet);
    if (isFomoIngestible(fomo) || FOMO_RELAYERS.includes(tx.keys[0]?.pubkey ?? "")) this.handToIndexer(tx, ctx.receivedAt);
    if (fomo.kind === "convert" || fomo.kind === "xchain") return "done";

    // Reference time: local receive time for pushed notifications, chain blockTime for polled signatures.
    const chainMs = tx.blockTimeMs ?? (ctx.blockTimeSec !== null ? ctx.blockTimeSec * 1000 : null);
    const refMs = ctx.source === "poll" ? chainMs : ctx.receivedAt;
    if (refMs === null) {
      log.debug("no block time; ignored", { wallet: w.wallet, sig: signature });
      return "done";
    }
    if (ctx.source === "ws" && chainMs !== null) this.checkClock(ctx.receivedAt - chainMs);

    const swap = await this.parse(tx, w.wallet, signature);
    if (!swap) return "done";
    // Stale buys are never copied; stale sells are (up to MAX_SELL_AGE_MS): exiting late beats holding the bag.
    if (ageVerdict({ ageMs: Date.now() - refMs, side: swap.side, maxEventAgeMs: config.maxEventAgeMs }) === "drop") {
      log.debug(`stale ${swap.side} ignored`, { wallet: w.wallet, sig: signature, ageMs: Date.now() - refMs });
      return "done";
    }
    const venue = venueOf(fomo, swap);

    const symbol = (await withTimeout(getTokenMeta(swap.mint), SYMBOL_TIMEOUT_MS, null))?.symbol ?? null;
    let event: TraderEventRow;
    try {
      event = await prisma.traderEvent.create({
        data: {
          traderId: w.traderId,
          signature,
          side: swap.side,
          mint: swap.mint,
          symbol,
          solAmount: swap.solAmount,
          tokenRaw: swap.tokenRaw.toString(),
          decimals: swap.decimals,
          sellFraction: swap.sellFraction,
          buyFraction: swap.buyFraction,
          venue,
          blockTime: new Date(refMs),
          detectedAt: new Date(ctx.receivedAt),
        },
      });
    } catch (err) {
      if (isUniqueViolation(err)) return "done";
      throw err;
    }

    await turn;
    log.info(`trader ${swap.side}`, {
      wallet: w.wallet,
      mint: swap.mint,
      symbol: symbol ?? undefined,
      venue,
      sol: swap.solAmount.toFixed(4),
      usd: swap.usdAmount !== null ? swap.usdAmount.toFixed(2) : undefined,
      frac: (swap.side === "buy" ? swap.buyFraction : swap.sellFraction)?.toFixed(4),
      via: ctx.source,
      lagMs: Date.now() - refMs,
    });
    // Awaited so the next event of this wallet is enqueued on the agent queues strictly after this one.
    await this.onEvent(event).catch((err: unknown) => log.error("dispatch failed", { event: event.id, err: errText(err) }));
    return "done";
  }

  /**
   * Give a relayer-paid transaction of a watched wallet to the indexer ingest: it runs rule R itself, stores
   * trades / conversions / cross-chain orders of tracked wallets (deduped by signature) and counts drift
   * (relayer-paid swaps without the marker). transactionSubscribe carries no blockTime: our receive time is used.
   */
  private handToIndexer(tx: SwapTx, receivedAt: number): void {
    const mini: MiniTx = {
      signature: tx.signature,
      slot: tx.slot,
      txIndex: tx.txIndex,
      blockTimeMs: tx.blockTimeMs,
      err: tx.err,
      keys: tx.keys,
      preLamports: tx.preLamports,
      postLamports: tx.postLamports,
      preToken: tx.preToken,
      postToken: tx.postToken,
    };
    try {
      enqueueFomoTx(mini, "watcher", { receivedAtMs: receivedAt });
    } catch (err) {
      log.debug("indexer hand-over failed", { sig: tx.signature, err: errText(err) });
    }
  }

  /**
   * Parse with a SOL/USD price when the quote is a stablecoin (every FOMO trade is USDC-quoted): the 1:1 mirror
   * size is the same USD value converted at the current price. Without a fresh price a BUY is skipped (its size
   * would be a guess); a SELL is only a fraction of the sleeve, so a recent hourly price may label it instead.
   */
  private async parse(tx: SwapTx, wallet: string, signature: string): Promise<ParsedSwap | null> {
    let r = analyzeSwap(tx, wallet, null);
    if ("skip" in r && r.needsSolUsd) {
      const solUsd = await getSolUsd().catch(() => null);
      r = analyzeSwap(tx, wallet, solUsd);
      if ("skip" in r && r.needsSolUsd) {
        const hourly = await this.recentHourlySolUsd();
        const labelled = hourly !== null ? analyzeSwap(tx, wallet, hourly) : null;
        if (labelled && "swap" in labelled && labelled.swap.side === "sell") {
          log.warn("no live SOL/USD price; sell sized from the sleeve, SOL amount from the hourly price", { wallet, sig: signature });
          return labelled.swap;
        }
        log.warn("stablecoin swap skipped: no SOL/USD price", { wallet, sig: signature });
        return null;
      }
    }
    if ("skip" in r) {
      log.debug("not a copyable swap", { wallet, sig: signature, reason: r.skip });
      return null;
    }
    return r.swap;
  }

  private async recentHourlySolUsd(): Promise<number | null> {
    try {
      const row = await prisma.solUsdHour.findFirst({ orderBy: { hour: "desc" } });
      return row && Date.now() - row.hour.getTime() <= HOURLY_PRICE_MAX_AGE_MS && row.price > 0 ? row.price : null;
    } catch {
      return null;
    }
  }

  /**
   * A log notification cannot arrive before its block, so a clearly negative lag means the local clock is
   * behind chain time. Event times use the local receive time, but tell the operator anyway.
   */
  private checkClock(lagMs: number): void {
    if (lagMs > -CLOCK_SKEW_WARN_MS || Date.now() - this.clockWarnedAt < CLOCK_WARN_EVERY_MS) return;
    this.clockWarnedAt = Date.now();
    log.warn("local clock looks behind chain time — sync the system clock (NTP)", { skewMs: -lagMs });
  }

  /** getParsedTransaction right after a notification can be null for a moment: retry with backoff. */
  private async fetchTx(signature: string): Promise<ParsedTransactionWithMeta | null> {
    for (let attempt = 1; attempt <= TX_FETCH_ATTEMPTS; attempt++) {
      try {
        const tx = await this.limiter.run(() =>
          connection().getParsedTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: MAX_TX_VERSION }),
        );
        if (tx) return tx;
      } catch (err) {
        log.debug("getParsedTransaction failed", { sig: signature, attempt, err: errText(err) });
      }
      if (attempt < TX_FETCH_ATTEMPTS && !this.stopped) await sleep(TX_FETCH_BACKOFF_MS * attempt);
    }
    return null;
  }
}
