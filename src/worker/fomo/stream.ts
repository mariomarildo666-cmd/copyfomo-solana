// Live FOMO stream for tracked wallets (design §2.5, §4.2). One Helius WebSocket (the `ws` package: it has ping()).
//
//  tS mode (caps.ts): transactionSubscribe
//    S1 {accountInclude: tracked, accountRequired: [RELAYER]}  → every relayer-paid tx of a tracked wallet
//       (trades, conversions, xchain). If Helius rejects that filter: accountRequired [MARKER] (xchain then
//       invisible live → xchainShare reported null). If both are rejected: logs mode.
//    S2 {accountInclude: [RELAYER], accountRequired: [MARKER]} → every FOMO trade network-wide, for discovery
//       scores (only when FOMO_DISCOVERY=stream, i.e. Business). Paused above 15,000 queued ingest items.
//    Options {commitment confirmed, encoding jsonParsed, transactionDetails "accounts", v1}: the payload already
//    has signer flags and balances, so no follow-up getTransaction.
//  logs mode (Free, or tS unavailable): one logsSubscribe per wallet, ≤ 60 per connection, ≤ 4 connections,
//    every tracked wallet (the ones the copy engine watches first — its hand-over is only a bonus, deduped by
//    signature). Failed txs dropped; getTransaction (P1) only when logsLookLikeFomoCandidate, plus 1 in 20 of
//    the other notifications (P3, ≤ 120/h) so a trade through an unknown router still feeds the drift alarm.
//    A failed logsSubscribe is retried with backoff (5 s → 5 min); until it succeeds the wallet reads partial
//    (state.subscribeFailed), after 5 min it is handed to the backfill loop, and on success the stretch since
//    the failure is gap-filled. A subscribe ack that arrives after its 15 s timeout is unsubscribed.
//
// Ping every 30 s (no pong in 75 s → terminate). Reconnect with backoff 1 s → 60 s. Tracked-set changes are
// applied after a 30 s debounce: subscribe the new set first, then unsubscribe the old one (overlap is deduped
// by signature). After a reconnect the missed stretch is handed to gap-fill; after a restart or a tS → logs
// fallback, the stretch since the resume point is gap-filled for every tracked wallet once the stream is
// subscribed. A deliberate stop is not an outage. openGapSince() feeds the persisted restart resume point.
// The URL carries the key: it is built by heliusWsUrl() and never logged.

import WebSocket from "ws";
import { config } from "@/lib/config";
import {
  classifyFomoTx,
  FOMO_MARKER,
  FOMO_RELAYER,
  FOMO_RELAYERS,
  logsLookLikeFomoCandidate,
  normalizeTx,
  USDC_DECIMALS,
} from "@/lib/fomo-chain";
import { canSpend, getTransaction, HELIUS_CREDITS, HELIUS_PRIORITY, heliusWsUrl, isHeliusError, meter, redactSecrets } from "@/lib/helius";
import { logger } from "../log";
import { noiseBreaker } from "../noise";
import { sleep } from "../util";
import { GAP_MARGIN_MS, markGaps, requestGapMark } from "./gaps";
import { enqueueFomoTx, ingestQueueSize, isSeen, markSeen } from "./ingest";
import {
  discoveryPaused,
  DriftSampler,
  INGEST_RESUME_DISCOVERY_AT,
  LOGS_MAX_CONNECTIONS,
  LOGS_PER_CONNECTION,
  planLogsWallets,
  resumePointMs,
  SUBSCRIBE_ESCALATE_MS,
  SUBSCRIBE_RETRY_BASE_MS,
  subscribeRetryDelayMs,
} from "./policy";
import { recordStreamTrade } from "./sampler";
import { safeErr, state, type S1Filter } from "./state";

const log = logger("fomo-stream");

const PING_MS = 30_000;
const PONG_TIMEOUT_MS = 75_000;
const BACKOFF_START_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;
/** A connection open this long resets the reconnect backoff. */
const STABLE_MS = 60_000;
const REQUEST_TIMEOUT_MS = 15_000;
const RESUBSCRIBE_DEBOUNCE_MS = 30_000;
/** Helius accepts up to 50,000 addresses per transactionSubscribe filter. */
const MAX_ACCOUNT_INCLUDE = 50_000;
const S2_CHECK_MS = 5_000;

/** Late acks remembered per socket (subscribe calls that timed out), bounded. */
const TIMED_OUT_MAX = 1_000;
const UNSUBSCRIBE_OF: Readonly<Record<string, string>> = { logsSubscribe: "logsUnsubscribe", transactionSubscribe: "transactionUnsubscribe" };

/** Where a stream socket connects and how its traffic is metered (tests: a local server, no meter). */
export interface SocketEnv {
  url(): string;
  onConnect(): void;
  onBytes(bytes: number): void;
}

export const HELIUS_SOCKET_ENV: SocketEnv = {
  url: heliusWsUrl,
  onConnect: () => meter.recordWsConnection(HELIUS_PRIORITY.live),
  onBytes: (bytes) => meter.recordWsBytes(bytes, HELIUS_PRIORITY.live),
};

/** Hand a missed stretch [sinceMs − 60 s, now] of `wallets` (null: every tracked wallet) to gap-fill. */
export type GapHandler = (sinceMs: number, wallets: string[] | null, reason: string) => void;

const TX_OPTIONS = {
  commitment: "confirmed",
  encoding: "jsonParsed",
  transactionDetails: "accounts",
  showRewards: false,
  maxSupportedTransactionVersion: 1,
} as const;

// ── JSON-RPC over one WebSocket, with ping, backoff reconnect and byte metering ─────────────────────

interface WsMessage {
  id?: unknown;
  result?: unknown;
  error?: { code?: unknown; message?: unknown } | null;
  method?: unknown;
  params?: { subscription?: unknown; result?: unknown };
}

/** The server answered a request with a JSON-RPC error (e.g. a subscribe filter it does not accept). */
class RpcRejected extends Error {
  constructor(
    message: string,
    readonly code: number | null,
  ) {
    super(message);
    this.name = "RpcRejected";
  }
}

function rawToBuffer(data: WebSocket.RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

interface SocketHandlers {
  onOpen(): void;
  onClose(): void;
  onNotification(msg: WsMessage, receivedAtMs: number): void;
}

class RpcSocket {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private pingTimer: NodeJS.Timeout | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private backoffMs = BACKOFF_START_MS;
  private openedAt = 0;
  private lastPongAt = 0;
  private stopped = false;
  /** Requests that timed out (id → method): a late subscribe ack is unsubscribed instead of leaking. */
  private readonly timedOut = new Map<number, string>();
  /** Last frame (message or pong) received on this socket. */
  lastFrameAt: number | null = null;

  constructor(
    readonly name: string,
    private readonly h: SocketHandlers,
    private readonly env: SocketEnv = HELIUS_SOCKET_ENV,
    private readonly requestTimeoutMs: number = REQUEST_TIMEOUT_MS,
  ) {}

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  start(): void {
    this.connect();
  }

  /** Drop the connection and reconnect with backoff (e.g. after a failed subscribe). */
  restart(): void {
    this.ws?.terminate();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.pingTimer);
    const ws = this.ws;
    if (!ws) return;
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        ws.terminate();
        resolve();
      }, 2_000);
      ws.once("close", () => {
        clearTimeout(t);
        resolve();
      });
      try {
        ws.close(1000);
      } catch {
        ws.terminate();
      }
    });
  }

  /** One JSON-RPC request; rejects with RpcRejected on an error response, Error on timeout / close. */
  request(method: string, params: unknown, timeoutMs = this.requestTimeoutMs): Promise<unknown> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error(`${this.name}: socket not open`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        if (UNSUBSCRIBE_OF[method]) {
          this.timedOut.set(id, method);
          if (this.timedOut.size > TIMED_OUT_MAX) this.timedOut.delete(this.timedOut.keys().next().value!);
        }
        reject(new Error(`${this.name}: ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private connect(): void {
    if (this.stopped) return;
    let url: string;
    try {
      url = this.env.url();
    } catch (err) {
      log.warn(`${this.name}: cannot connect`, { err: safeErr(err) });
      return;
    }
    const ws = new WebSocket(url, { handshakeTimeout: 15_000 });
    this.ws = ws;
    this.env.onConnect();

    ws.on("open", () => {
      this.openedAt = Date.now();
      this.lastPongAt = this.openedAt;
      clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => this.ping(ws), PING_MS);
      log.info(`${this.name}: connected`);
      this.h.onOpen();
    });
    ws.on("pong", () => {
      this.lastPongAt = Date.now();
      this.lastFrameAt = this.lastPongAt;
      // A pong on a subscribed socket proves nothing was missed up to now (resume point for restart gap-fill).
      if (state.connected) state.lastMsgAt = Math.max(state.lastMsgAt ?? 0, this.lastPongAt);
    });
    ws.on("message", (data) => this.onMessage(data));
    ws.on("error", (err) => log.debug(`${this.name}: socket error`, { err: redactSecrets(err.message) }));
    ws.on("close", (code) => {
      if (this.ws !== ws) return;
      this.ws = null;
      clearInterval(this.pingTimer);
      this.timedOut.clear(); // subscriptions die with the socket
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error(`${this.name}: socket closed`));
        this.pending.delete(id);
      }
      this.h.onClose();
      if (this.stopped) return;
      if (this.openedAt && Date.now() - this.openedAt >= STABLE_MS) this.backoffMs = BACKOFF_START_MS;
      const delay = this.backoffMs;
      this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_MAX_MS);
      log.warn(`${this.name}: disconnected, reconnecting`, { code, inMs: delay });
      this.openedAt = 0;
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
    });
  }

  private ping(ws: WebSocket): void {
    if (Date.now() - this.lastPongAt > PONG_TIMEOUT_MS) {
      log.warn(`${this.name}: no pong, dropping the connection`);
      ws.terminate();
      return;
    }
    try {
      ws.ping();
    } catch {
      /* close follows */
    }
  }

  private onMessage(data: WebSocket.RawData): void {
    const now = Date.now();
    const buf = rawToBuffer(data);
    this.env.onBytes(buf.length);
    this.lastFrameAt = now;
    let msg: WsMessage;
    try {
      msg = JSON.parse(buf.toString("utf8")) as WsMessage;
    } catch {
      return;
    }
    if (typeof msg.id === "number" && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) {
        const code = typeof msg.error.code === "number" ? msg.error.code : null;
        p.reject(new RpcRejected(redactSecrets(String(msg.error.message ?? "request rejected")).slice(0, 200), code));
      } else {
        p.resolve(msg.result);
      }
      return;
    }
    if (typeof msg.id === "number" && this.timedOut.has(msg.id)) {
      const method = this.timedOut.get(msg.id)!;
      this.timedOut.delete(msg.id);
      const unsub = UNSUBSCRIBE_OF[method];
      if (!msg.error && typeof msg.result === "number" && unsub) {
        // The server created the subscription after we gave up: it would count against the limit and its
        // notifications would be ignored.
        log.debug(`${this.name}: late ${method} ack; unsubscribing it`);
        void this.request(unsub, [msg.result]).catch(() => undefined);
      }
      return;
    }
    if (typeof msg.method === "string") this.h.onNotification(msg, now);
  }
}

// ── tS mode ─────────────────────────────────────────────────────────────────────────────────────────

class FallbackToLogs extends Error {}

class TxStream {
  private readonly sock: RpcSocket;
  private s1: { subId: number; wallets: Set<string>; filter: S1Filter } | null = null;
  private s2SubId: number | null = null;
  private desired: string[] = [];
  private resubTimer: NodeJS.Timeout | undefined;
  private s2Timer: NodeJS.Timeout | undefined;
  private busy = false;
  private again = false;
  private everSubscribed = false;
  private stopped = false;
  /** Start of a stretch the stream missed (set on disconnect), repaired after the next subscribe. */
  private gapSince: number | null = null;
  private relayerRejected = FOMO_RELAYERS.length > 1; // accountRequired needs ALL listed accounts
  badPayloads = 0;

  constructor(
    private readonly onGap: GapHandler,
    private readonly onFallback: () => void,
    private readonly onReady: () => void,
    env: SocketEnv = HELIUS_SOCKET_ENV,
  ) {
    const handlers: SocketHandlers = {
      onOpen: () => {
        this.s1 = null;
        this.s2SubId = null;
        void this.resubscribe();
      },
      onClose: () => {
        state.connected = false;
        // A deliberate stop is not an outage (the persisted resume point covers what follows).
        if (this.everSubscribed && !this.stopped) {
          const since = this.sock.lastFrameAt ?? Date.now();
          this.gapSince = this.gapSince === null ? since : Math.min(this.gapSince, since);
        }
        this.s1 = null;
        this.s2SubId = null;
      },
      onNotification: (msg, at) => this.onNotification(msg, at),
    };
    this.sock = new RpcSocket("tS", handlers, env);
  }

  start(wallets: string[]): void {
    this.desired = wallets.slice(0, MAX_ACCOUNT_INCLUDE);
    this.sock.start();
    this.s2Timer = setInterval(() => void this.syncS2(), S2_CHECK_MS);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.resubTimer);
    clearInterval(this.s2Timer);
    await this.sock.stop();
  }

  get lastFrameAt(): number | null {
    return this.sock.lastFrameAt;
  }

  /** Start of the outage not repaired yet (the socket went down then), or null. */
  openGapSince(): number | null {
    return this.gapSince;
  }

  /** New tracked set: applied now when nothing is subscribed yet, else after the 30 s debounce. */
  setWallets(wallets: string[]): void {
    this.desired = wallets.slice(0, MAX_ACCOUNT_INCLUDE);
    if (wallets.length > MAX_ACCOUNT_INCLUDE) log.warn("tracked set exceeds one subscription", { tracked: wallets.length });
    const current = this.s1?.wallets;
    if (current && current.size === this.desired.length && this.desired.every((w) => current.has(w))) return;
    if (!this.s1) {
      void this.resubscribe();
      return;
    }
    if (this.resubTimer) return;
    this.resubTimer = setTimeout(() => {
      this.resubTimer = undefined;
      void this.resubscribe();
    }, RESUBSCRIBE_DEBOUNCE_MS);
  }

  private async subscribeS1(wallets: string[]): Promise<{ subId: number; filter: S1Filter }> {
    const filters: S1Filter[] = this.relayerRejected ? ["marker"] : ["relayer", "marker"];
    for (const filter of filters) {
      try {
        const res = await this.sock.request("transactionSubscribe", [
          { accountInclude: wallets, accountRequired: [filter === "relayer" ? FOMO_RELAYER : FOMO_MARKER], failed: false, vote: false },
          TX_OPTIONS,
        ]);
        if (typeof res !== "number") throw new Error("transactionSubscribe: unexpected ack");
        return { subId: res, filter };
      } catch (err) {
        if (!(err instanceof RpcRejected)) throw err;
        log.warn(`S1 filter "${filter}" rejected`, { err: err.message });
        if (filter === "relayer") this.relayerRejected = true;
      }
    }
    throw new FallbackToLogs("transactionSubscribe rejected for every S1 filter");
  }

  private async resubscribe(): Promise<void> {
    if (this.busy) {
      this.again = true;
      return;
    }
    if (!this.sock.isOpen || this.stopped) return;
    this.busy = true;
    try {
      const wallets = [...this.desired];
      const old = this.s1;
      if (wallets.length === 0) {
        // Never subscribe with an empty accountInclude: it would stream every relayer transaction.
        this.s1 = null;
        if (old) await this.unsubscribe(old.subId);
        state.covered = new Set();
      } else {
        const sub = await this.subscribeS1(wallets);
        this.s1 = { ...sub, wallets: new Set(wallets) };
        state.s1Filter = sub.filter;
        state.covered = new Set(wallets);
        if (old) await this.unsubscribe(old.subId);
        log.info("S1 subscribed", { wallets: wallets.length, filter: sub.filter });
      }
      state.connected = true;
      state.streamReady = true;
      this.everSubscribed = true;
      await this.syncS2();
      if (this.gapSince !== null) {
        const since = this.gapSince;
        this.gapSince = null;
        this.onGap(since, null, "reconnect");
      }
      this.onReady();
    } catch (err) {
      if (err instanceof FallbackToLogs) {
        log.warn("transactionSubscribe unavailable: switching to logs mode");
        this.onFallback();
        return;
      }
      log.warn("S1 subscribe failed, reconnecting", { err: safeErr(err) });
      this.sock.restart();
    } finally {
      this.busy = false;
      if (this.again) {
        this.again = false;
        void this.resubscribe();
      }
    }
  }

  private async unsubscribe(subId: number): Promise<void> {
    await this.sock.request("transactionUnsubscribe", [subId]).catch((err: unknown) => log.debug("unsubscribe failed", { err: safeErr(err) }));
  }

  /** S2 (Business discovery stream): on when FOMO_DISCOVERY=stream and the ingest queue is not under pressure. */
  private async syncS2(): Promise<void> {
    if (config.fomoDiscovery !== "stream" || !this.sock.isOpen || !this.s1) return;
    const size = ingestQueueSize();
    if (this.s2SubId !== null && discoveryPaused(size)) {
      const id = this.s2SubId;
      this.s2SubId = null;
      await this.unsubscribe(id);
      log.warn("S2 paused: ingest queue under pressure", { queued: size });
    } else if (this.s2SubId === null && size < INGEST_RESUME_DISCOVERY_AT) {
      try {
        const res = await this.sock.request("transactionSubscribe", [
          { accountInclude: [FOMO_RELAYER], accountRequired: [FOMO_MARKER], failed: false, vote: false },
          TX_OPTIONS,
        ]);
        if (typeof res === "number") this.s2SubId = res;
      } catch (err) {
        log.warn("S2 subscribe failed", { err: safeErr(err) });
      }
    }
  }

  private onNotification(msg: WsMessage, receivedAtMs: number): void {
    if (msg.method !== "transactionNotification") return;
    state.lastMsgAt = receivedAtMs;
    const tx = normalizeTx(msg);
    if (!tx) {
      this.badPayloads++;
      return;
    }
    if (this.s2SubId !== null && msg.params?.subscription === this.s2SubId) {
      const cls = classifyFomoTx(tx);
      if (cls.kind === "trade") recordStreamTrade(cls.user, Number(cls.usdcRaw) / 10 ** USDC_DECIMALS);
      if (cls.kind !== "not_fomo" && state.tracked.has(cls.user)) enqueueFomoTx(tx, "stream", { receivedAtMs, lane: "discovery" });
      return;
    }
    enqueueFomoTx(tx, "stream", { receivedAtMs, lane: "live" });
  }
}

// ── logs mode ───────────────────────────────────────────────────────────────────────────────────────

const LOGS_FETCH_CONCURRENCY = 6;
const LOGS_FETCH_QUEUE_MAX = 5_000;
const LOGS_FETCH_ATTEMPTS = 5;
const LOGS_FETCH_BACKOFF_MS = 400;
/** stop(): how long in-flight getTransaction calls may finish before their stretch is marked as a gap. */
const LOGS_STOP_DRAIN_MS = 3_000;

interface FailedSub {
  /** When live coverage of the wallet was lost (subscribe failure, or the outage before it). */
  at: number;
  /** Already handed to the backfill loop (markGaps): no P1 gap-fill on recovery. */
  escalated: boolean;
}

interface LogsConn {
  sock: RpcSocket;
  /** wallet → subscription id (acked). */
  subs: Map<string, number>;
  bySub: Map<number, string>;
  /** Wallets assigned to this connection (subscribed, about to be, or failing and retried). */
  assigned: Set<string>;
  /** Assigned wallets whose logsSubscribe failed, retried with backoff until it succeeds. */
  failed: Map<string, FailedSub>;
  /** Subscribe calls in flight (one per wallet at a time). */
  subscribing: Set<string>;
  retryTimer: NodeJS.Timeout | undefined;
  retryAttempt: number;
  /** Bumped on every open and close: a resubscribe pass superseded by a close stops. */
  gen: number;
  everSubscribed: boolean;
  /** Start of the outage being repaired; kept until handed to gap-fill (it is part of the resume point). */
  gapSince: number | null;
}

interface FetchJob {
  sig: string;
  wallet: string;
  receivedAtMs: number;
  /** A non-candidate notification fetched for the drift check (P3, no gap mark when it fails). */
  sampled: boolean;
}

export interface LogsStreamOptions {
  env?: SocketEnv;
  requestTimeoutMs?: number;
  retryBaseMs?: number;
  escalateMs?: number;
}

export class LogsStream {
  private readonly conns: LogsConn[] = [];
  private desired: string[] = [];
  private applied = false;
  private resubTimer: NodeJS.Timeout | undefined;
  private applying = false;
  private again = false;
  private readonly fetchQueue: FetchJob[] = [];
  private readonly inflight = new Set<FetchJob>();
  private readonly fetches = new Set<Promise<void>>();
  private readonly sampler = new DriftSampler();
  private stopped = false;
  private readonly env: SocketEnv;
  private readonly requestTimeoutMs: number;
  private readonly retryBaseMs: number;
  private readonly escalateMs: number;

  constructor(
    private readonly onGap: GapHandler,
    private readonly onReady: () => void = () => undefined,
    opts: LogsStreamOptions = {},
  ) {
    this.env = opts.env ?? HELIUS_SOCKET_ENV;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
    this.retryBaseMs = opts.retryBaseMs ?? SUBSCRIBE_RETRY_BASE_MS;
    this.escalateMs = opts.escalateMs ?? SUBSCRIBE_ESCALATE_MS;
  }

  start(wallets: string[]): void {
    this.desired = wallets;
    void this.apply();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.resubTimer);
    for (const c of this.conns) {
      clearTimeout(c.retryTimer);
      c.retryTimer = undefined;
    }
    await Promise.all(this.conns.map((c) => c.sock.stop()));
    // Candidates that will never be fetched now: durable gap marks (written by stopIngest's flushGapMarks).
    for (const job of this.fetchQueue.splice(0)) {
      if (!job.sampled) requestGapMark(job.wallet, job.receivedAtMs - GAP_MARGIN_MS, "shutdown before fetch");
    }
    if (this.fetches.size > 0) await Promise.race([Promise.allSettled([...this.fetches]), sleep(LOGS_STOP_DRAIN_MS)]);
    for (const job of this.inflight) {
      if (!job.sampled) requestGapMark(job.wallet, job.receivedAtMs - GAP_MARGIN_MS, "shutdown before fetch");
    }
  }

  get lastFrameAt(): number | null {
    let best: number | null = null;
    for (const c of this.conns) if (c.sock.lastFrameAt !== null && (best === null || c.sock.lastFrameAt > best)) best = c.sock.lastFrameAt;
    return best;
  }

  /**
   * Earliest stretch not repaired yet: a connection down since then, a failing subscribe not handed to the
   * backfill loop yet, a candidate still to fetch. null: none.
   */
  openGapSince(): number | null {
    const points: number[] = [];
    for (const c of this.conns) {
      if (c.gapSince !== null) points.push(c.gapSince);
      for (const f of c.failed.values()) if (!f.escalated) points.push(f.at);
    }
    for (const j of this.fetchQueue) if (!j.sampled) points.push(j.receivedAtMs);
    for (const j of this.inflight) if (!j.sampled) points.push(j.receivedAtMs);
    return resumePointMs(points);
  }

  setWallets(wallets: string[]): void {
    this.desired = wallets;
    if (!this.applied) {
      void this.apply();
      return;
    }
    if (this.resubTimer) return;
    this.resubTimer = setTimeout(() => {
      this.resubTimer = undefined;
      void this.apply();
    }, RESUBSCRIBE_DEBOUNCE_MS);
  }

  private refreshState(): void {
    if (this.stopped) return;
    const covered = new Set<string>();
    for (const c of this.conns) for (const w of c.subs.keys()) covered.add(w);
    state.covered = covered;
    const withWork = this.conns.filter((c) => c.assigned.size > 0);
    state.connected = withWork.every((c) => c.sock.isOpen) && (withWork.length > 0 || this.desired.length === 0);
    if (state.connected) {
      state.streamReady = true;
      this.onReady();
    }
  }

  private newConn(index: number): LogsConn {
    const conn: LogsConn = {
      sock: null as unknown as RpcSocket,
      subs: new Map(),
      bySub: new Map(),
      assigned: new Set(),
      failed: new Map(),
      subscribing: new Set(),
      retryTimer: undefined,
      retryAttempt: 0,
      gen: 0,
      everSubscribed: false,
      gapSince: null,
    };
    conn.sock = new RpcSocket(
      `logs#${index + 1}`,
      {
        onOpen: () => void this.onConnOpen(conn, ++conn.gen),
        onClose: () => {
          conn.gen++;
          clearTimeout(conn.retryTimer); // the next open resubscribes every assigned wallet
          conn.retryTimer = undefined;
          // A deliberate stop is not an outage (the persisted resume point covers what follows).
          if (conn.everSubscribed && !this.stopped) {
            const since = conn.sock.lastFrameAt ?? Date.now();
            conn.gapSince = conn.gapSince === null ? since : Math.min(conn.gapSince, since);
          }
          conn.subs.clear();
          conn.bySub.clear();
          this.refreshState();
        },
        onNotification: (msg, at) => this.onNotification(conn, msg, at),
      },
      this.env,
      this.requestTimeoutMs,
    );
    conn.sock.start();
    return conn;
  }

  /**
   * logsSubscribe one assigned wallet. On failure the wallet stays assigned, is recorded as failed (coverage lost
   * at `lostAtMs`, default now) and retried with backoff. On success after a failure the stretch since then is
   * gap-filled. Returns true when the wallet is subscribed.
   */
  private async subscribeWallet(conn: LogsConn, wallet: string, lostAtMs?: number): Promise<boolean> {
    if (conn.subs.has(wallet)) return true;
    if (this.stopped || conn.subscribing.has(wallet)) return false;
    if (!conn.sock.isOpen) {
      // Only a wallet that was covered before (reconnect) has lost anything; the next open subscribes it.
      if (lostAtMs !== undefined && conn.assigned.has(wallet)) this.recordFailure(conn, wallet, lostAtMs, "socket not open");
      return false;
    }
    conn.subscribing.add(wallet);
    try {
      const res = await conn.sock.request("logsSubscribe", [{ mentions: [wallet] }, { commitment: "confirmed" }]);
      if (typeof res !== "number") throw new Error("logsSubscribe: unexpected ack");
      if (!conn.assigned.has(wallet) || this.stopped) {
        await conn.sock.request("logsUnsubscribe", [res]).catch(() => undefined);
        return false;
      }
      conn.subs.set(wallet, res);
      conn.bySub.set(res, wallet);
      conn.everSubscribed = true;
      const prev = conn.failed.get(wallet);
      if (prev) {
        this.clearFailure(conn, wallet);
        log.info("logsSubscribe recovered", { wallet, lostSec: Math.round((Date.now() - prev.at) / 1000) });
        // An escalated failure is already in the backfill loop's hands.
        if (!prev.escalated) this.onGap(prev.at, [wallet], "logs subscribe recovered");
      }
      return true;
    } catch (err) {
      if (conn.assigned.has(wallet) && !this.stopped) this.recordFailure(conn, wallet, lostAtMs ?? Date.now(), safeErr(err));
      return false;
    } finally {
      conn.subscribing.delete(wallet);
    }
  }

  private recordFailure(conn: LogsConn, wallet: string, at: number, err: string): void {
    const prev = conn.failed.get(wallet);
    const entry: FailedSub = { at: prev ? Math.min(prev.at, at) : at, escalated: prev?.escalated ?? false };
    conn.failed.set(wallet, entry);
    state.subscribeFailed.set(wallet, entry.at);
    if (!prev) log.warn("logsSubscribe failed; the wallet reads partial until a retry succeeds", { wallet, err });
    this.scheduleRetry(conn);
  }

  private clearFailure(conn: LogsConn, wallet: string): void {
    conn.failed.delete(wallet);
    if (!this.conns.some((c) => c.failed.has(wallet))) state.subscribeFailed.delete(wallet);
  }

  private scheduleRetry(conn: LogsConn): void {
    if (this.stopped || conn.retryTimer || conn.failed.size === 0) return;
    const delay = subscribeRetryDelayMs(conn.retryAttempt, this.retryBaseMs);
    conn.retryTimer = setTimeout(() => {
      conn.retryTimer = undefined;
      void this.retryFailed(conn);
    }, delay);
  }

  /** One retry round of the connection's failed subscribes (the backoff grows while failures remain). */
  private async retryFailed(conn: LogsConn): Promise<void> {
    if (this.stopped) return;
    this.escalate(conn);
    if (!conn.sock.isOpen) return; // the next open subscribes every assigned wallet
    conn.retryAttempt++;
    for (const w of [...conn.failed.keys()]) {
      if (this.stopped) return;
      if (!conn.assigned.has(w)) {
        this.clearFailure(conn, w);
        continue;
      }
      await this.subscribeWallet(conn, w);
    }
    if (conn.failed.size === 0) conn.retryAttempt = 0;
    else this.scheduleRetry(conn);
    this.refreshState();
  }

  /** Failures older than escalateMs are handed to the backfill loop (durable across restarts); retries go on. */
  private escalate(conn: LogsConn): void {
    const now = Date.now();
    for (const [wallet, f] of conn.failed) {
      if (f.escalated || now - f.at < this.escalateMs) continue;
      f.escalated = true;
      void markGaps([wallet], f.at - GAP_MARGIN_MS, "live subscription failing");
    }
  }

  private async unsubscribeWallet(conn: LogsConn, wallet: string): Promise<void> {
    conn.assigned.delete(wallet);
    this.clearFailure(conn, wallet);
    const id = conn.subs.get(wallet);
    if (id === undefined) return;
    conn.subs.delete(wallet);
    conn.bySub.delete(id);
    if (conn.sock.isOpen) await conn.sock.request("logsUnsubscribe", [id]).catch(() => undefined);
  }

  private async onConnOpen(conn: LogsConn, gen: number): Promise<void> {
    // conn.gapSince stays set until the outage is handed to gap-fill: a stop or a new close before that keeps
    // it (resume point / next open). A wallet that fails to resubscribe carries it as its failure time.
    const gapSince = conn.gapSince;
    const back: string[] = [];
    for (const w of [...conn.assigned]) {
      if (this.stopped || conn.gen !== gen) return;
      if (await this.subscribeWallet(conn, w, gapSince ?? undefined)) back.push(w);
    }
    if (this.stopped || conn.gen !== gen) return;
    conn.gapSince = null;
    this.refreshState();
    if (gapSince !== null && back.length > 0) this.onGap(gapSince, back, "reconnect(logs)");
  }

  private async apply(): Promise<void> {
    if (this.applying) {
      this.again = true;
      return;
    }
    if (this.stopped) return;
    this.applying = true;
    this.applied = true;
    try {
      const want = new Set(this.desired);
      const assignedNow = new Map<string, LogsConn>();
      for (const c of this.conns) for (const w of c.assigned) assignedNow.set(w, c);
      const additions = this.desired.filter((w) => !assignedNow.has(w));
      const removals = [...assignedNow.keys()].filter((w) => !want.has(w));

      const place = async (wallet: string): Promise<boolean> => {
        let conn = this.conns.filter((c) => c.assigned.size < LOGS_PER_CONNECTION).sort((a, b) => a.assigned.size - b.assigned.size)[0];
        if (!conn) {
          if (this.conns.length >= LOGS_MAX_CONNECTIONS) return false;
          conn = this.newConn(this.conns.length);
          this.conns.push(conn);
        }
        conn.assigned.add(wallet);
        await this.subscribeWallet(conn, wallet);
        return true;
      };

      // Subscribe the new wallets first, then drop the old ones, then place what did not fit before.
      const later: string[] = [];
      for (const w of additions) if (!(await place(w))) later.push(w);
      for (const w of removals) await this.unsubscribeWallet(assignedNow.get(w)!, w);
      for (const w of later) await place(w);
      if (additions.length || removals.length) log.info("logs subscriptions updated", { wallets: this.desired.length, added: additions.length, removed: removals.length });
    } catch (err) {
      log.warn("logs subscription update failed", { err: safeErr(err) });
    } finally {
      this.applying = false;
      this.refreshState();
      if (this.again) {
        this.again = false;
        void this.apply();
      }
    }
  }

  private onNotification(conn: LogsConn, msg: WsMessage, receivedAtMs: number): void {
    if (msg.method !== "logsNotification" || this.stopped) return;
    // Only while every connection is subscribed: a frame here says nothing about a connection that is down.
    if (state.connected) state.lastMsgAt = receivedAtMs;
    const sub = msg.params?.subscription;
    const wallet = typeof sub === "number" ? conn.bySub.get(sub) : undefined;
    const result = msg.params?.result as { value?: { signature?: unknown; err?: unknown; logs?: unknown } } | undefined;
    const value = result?.value;
    if (!wallet || !value || typeof value.signature !== "string") return;
    // Logs carry no signer: count every notification; a flood trips the wallet off the plan (applied on the next
    // tracked refresh, which re-plans because the tripped set changed).
    if (noiseBreaker.record(wallet)) {
      log.warn("tracked wallet floods logs notifications; dropped from live coverage for 15 min", { wallet });
      state.trackedVersion++;
    }
    const sig = value.signature;
    if (value.err !== null && value.err !== undefined) return;
    if (isSeen(sig)) return;
    const logs = Array.isArray(value.logs) ? value.logs.filter((l): l is string => typeof l === "string") : [];
    if (!logsLookLikeFomoCandidate(logs)) {
      // Drift check (§2.7): a trade through a router we don't know has no known invoke in its logs.
      if (this.fetchQueue.length < LOGS_FETCH_QUEUE_MAX && this.sampler.take(receivedAtMs) && canSpend(HELIUS_PRIORITY.discovery, HELIUS_CREDITS.rpc)) {
        this.fetchQueue.push({ sig, wallet, receivedAtMs, sampled: true });
        this.pumpFetches();
      } else {
        markSeen(sig);
      }
      return;
    }
    if (this.fetchQueue.length >= LOGS_FETCH_QUEUE_MAX) {
      requestGapMark(wallet, receivedAtMs - GAP_MARGIN_MS, "logs fetch queue full");
      return;
    }
    this.fetchQueue.push({ sig, wallet, receivedAtMs, sampled: false });
    this.pumpFetches();
  }

  private pumpFetches(): void {
    while (!this.stopped && this.fetches.size < LOGS_FETCH_CONCURRENCY && this.fetchQueue.length > 0) {
      const job = this.fetchQueue.shift()!;
      this.inflight.add(job);
      const p: Promise<void> = this.fetchOne(job).finally(() => {
        this.inflight.delete(job);
        this.fetches.delete(p);
        this.pumpFetches();
      });
      this.fetches.add(p);
    }
  }

  private async fetchOne(job: FetchJob): Promise<void> {
    const priority = job.sampled ? HELIUS_PRIORITY.discovery : HELIUS_PRIORITY.live;
    const attempts = job.sampled ? 1 : LOGS_FETCH_ATTEMPTS;
    for (let attempt = 1; attempt <= attempts && !this.stopped; attempt++) {
      try {
        const raw = await getTransaction(job.sig, { priority });
        const tx = raw ? normalizeTx(raw) : null;
        if (tx) {
          const weight = job.sampled ? this.sampler.every : 1;
          if (enqueueFomoTx(tx, "logs", { receivedAtMs: job.receivedAtMs, lane: "live", driftWeight: weight })) return;
          break; // ingest stopped, or its queue is full (enqueueFomoTx then marked the trader already)
        }
      } catch (err) {
        if (!isHeliusError(err, "rate_limited", "network", "timeout", "http", "throttled")) {
          log.debug("logs getTransaction failed", { sig: job.sig, err: safeErr(err) });
        }
      }
      if (attempt < attempts) await sleep(LOGS_FETCH_BACKOFF_MS * attempt);
    }
    if (job.sampled) {
      markSeen(job.sig);
      return;
    }
    requestGapMark(job.wallet, job.receivedAtMs - GAP_MARGIN_MS, this.stopped ? "shutdown before fetch" : "logs transaction unavailable");
  }
}

// ── Controller ──────────────────────────────────────────────────────────────────────────────────────

/** Owns the live stream: tS mode when the probe passed, logs mode otherwise (or after a tS fallback). */
export class StreamController {
  private tx: TxStream | null = null;
  private logs: LogsStream | null = null;
  /**
   * A stretch to gap-fill for every tracked wallet once the (new) stream is subscribed: the previous run's
   * resume point after a restart, or the handover of a tS → logs fallback.
   */
  private pendingGap: { sinceMs: number; reason: string } | null = null;
  private readonly logsOptions: LogsStreamOptions;

  constructor(
    private readonly onGap: GapHandler,
    opts: { resumeFromMs?: number | null; logs?: LogsStreamOptions } = {},
  ) {
    if (typeof opts.resumeFromMs === "number" && Number.isFinite(opts.resumeFromMs)) this.pendingGap = { sinceMs: opts.resumeFromMs, reason: "restart" };
    this.logsOptions = opts.logs ?? {};
  }

  private readonly onReady = (): void => {
    const g = this.pendingGap;
    if (!g) return;
    this.pendingGap = null;
    this.onGap(g.sinceMs, null, g.reason);
  };

  start(mode: "stream" | "logs"): void {
    state.mode = mode;
    if (mode === "stream") {
      this.tx = new TxStream(this.onGap, () => void this.fallbackToLogs(), this.onReady, this.logsOptions.env);
      this.tx.start(this.trackedList());
    } else {
      this.logs = new LogsStream(this.onGap, this.onReady, this.logsOptions);
      this.logs.start(this.logsPlan());
    }
    log.info("live stream starting", { mode, tracked: state.tracked.size });
  }

  /** Push the current tracked / followed / watched sets into the active stream (debounced inside). */
  update(): void {
    if (this.tx) this.tx.setWallets(this.trackedList());
    else if (this.logs) this.logs.setWallets(this.logsPlan());
  }

  lastFrameAt(): number | null {
    return this.tx?.lastFrameAt ?? this.logs?.lastFrameAt ?? null;
  }

  /** Earliest stretch the live stream has not handed to gap-fill yet (part of the restart resume point). */
  openGapSince(): number | null {
    return resumePointMs([this.pendingGap?.sinceMs, this.tx?.openGapSince(), this.logs?.openGapSince()]);
  }

  async stop(): Promise<void> {
    await Promise.all([this.tx?.stop(), this.logs?.stop()]);
    state.connected = false;
  }

  private async fallbackToLogs(): Promise<void> {
    const tx = this.tx;
    this.tx = null;
    // S1 covered every tracked wallet up to its last frame (or the outage start): repair from there once the
    // logs stream is subscribed (a new LogsStream has never subscribed, so it would not report a gap itself).
    const since = resumePointMs([tx?.openGapSince(), tx?.lastFrameAt ?? Date.now()]) ?? Date.now();
    await tx?.stop().catch(() => undefined);
    state.connected = false;
    this.pendingGap = this.pendingGap
      ? { sinceMs: Math.min(this.pendingGap.sinceMs, since), reason: `${this.pendingGap.reason}+fallback to logs` }
      : { sinceMs: since, reason: "fallback to logs" };
    state.s1Filter = null;
    this.start("logs");
  }

  /**
   * tS mode: every tracked wallet, ordered followed/watched > seed > user > discovered (then most recent trade) so
   * that, if the set ever exceeds one subscription (MAX_ACCOUNT_INCLUDE), the truncation drops the least
   * important wallets, never the ones people copy. S1 requires FOMO's relayer, so noise can't flood it.
   */
  private trackedList(): string[] {
    state.uncovered.clear();
    state.subscribeFailed.clear();
    return planLogsWallets(
      [...state.tracked].map(([wallet, t]) => ({ wallet, origin: t.origin, lastTradeAtMs: t.lastTradeAtMs })),
      new Set([...state.followed, ...state.watched]),
      Number.POSITIVE_INFINITY,
    ).subscribe;
  }

  /** Logs mode covers ≤ 240 wallets (followed ones first); the rest are "uncovered" until they fit. */
  private logsPlan(): string[] {
    // Wallets the noise breaker tripped are left out like overflow: uncovered (their windows read partial) and
    // gap-repaired when they come back (finding F13).
    const tripped = noiseBreaker.tripped();
    const plan = planLogsWallets(
      [...state.tracked].filter(([wallet]) => !tripped.has(wallet)).map(([wallet, t]) => ({ wallet, origin: t.origin, lastTradeAtMs: t.lastTradeAtMs })),
      new Set([...state.followed, ...state.watched]),
    );
    const now = Date.now();
    const overflow = new Set([...plan.overflow, ...[...state.tracked.keys()].filter((w) => tripped.has(w))]);
    const back: { wallet: string; since: number }[] = [];
    for (const [w, since] of state.uncovered) {
      if (!overflow.has(w)) {
        state.uncovered.delete(w);
        if (state.tracked.has(w)) back.push({ wallet: w, since });
      }
    }
    // A wallet whose subscribe was already failing lost coverage then, not now.
    for (const w of overflow) if (!state.uncovered.has(w)) state.uncovered.set(w, state.subscribeFailed.get(w) ?? now);
    if (overflow.size > 0) log.warn("logs mode cannot cover every tracked wallet live; the rest rank as partial history", { overflow: overflow.size });
    for (const b of back) void markGaps([b.wallet], b.since - GAP_MARGIN_MS, "live coverage resumed");
    return plan.subscribe;
  }
}
