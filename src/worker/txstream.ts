// Helius transactionSubscribe stream for the copy watcher (one WebSocket, `ws` package).
//  - filter: accountInclude = the watched wallets, failed:false, vote:false. NO accountRequired: a trader's
//    sells on other venues must be seen too (they close sleeves bought from FOMO buys).
//  - options: confirmed, jsonParsed, transactionDetails "accounts" (signers, full key list incl. lookup-table
//    keys, fee, lamport + token balances — all the parser and rule R need), maxSupportedTransactionVersion 1.
//  - set changes: subscribe the new set first, then unsubscribe the old one (the watcher dedupes by signature).
//  - ping every 30 s (a missing pong terminates the socket); reconnect with backoff 1 s → 60 s.
//  - metered at P0: 1 credit per connection + 2 credits per 0.1 MB received.
// The URL carries the Helius key: it is built by helius.ts and never logged.

import WebSocket, { type RawData } from "ws";
import { HELIUS_PRIORITY, heliusWsUrl, meter, redactSecrets } from "@/lib/helius";
import { errText, logger } from "./log";

const log = logger("txstream");

const PING_MS = 30_000;
const HANDSHAKE_TIMEOUT_MS = 15_000;
const SUBSCRIBE_TIMEOUT_MS = 20_000;
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 60_000;

export type TxStreamState = "connected" | "subscribed" | "disconnected" | "rejected";

export interface TxStreamHandlers {
  /** One transactionNotification `params.result` ({slot, signature, transaction:{transaction, meta}, …}). */
  onTx(result: Record<string, unknown>, receivedAtMs: number): void;
  onState(state: TxStreamState, detail?: string): void;
}

type Pending = { kind: "sub"; key: string; timer: NodeJS.Timeout } | { kind: "unsub"; subId: number };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

/** Subscription filter + options (exported for tests / review). */
export function transactionSubscribeParams(wallets: readonly string[]): unknown[] {
  return [
    { accountInclude: [...wallets], failed: false, vote: false },
    { commitment: "confirmed", encoding: "jsonParsed", transactionDetails: "accounts", showRewards: false, maxSupportedTransactionVersion: 1 },
  ];
}

export class TxStream {
  private ws: WebSocket | null = null;
  private open = false;
  private desired: string[] = [];
  private desiredKey = "";
  private reqId = 0;
  private readonly pending = new Map<number, Pending>();
  /** Subscriptions whose notifications are accepted (current + one being replaced). */
  private readonly accepted = new Set<number>();
  private currentSub: number | null = null;
  private backoffMs = RECONNECT_MIN_MS;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private pingTimer: NodeJS.Timeout | undefined;
  private alive = false;
  private stopped = false;

  constructor(private readonly handlers: TxStreamHandlers) {}

  /** Connected and subscribed to the current wallet set. */
  get subscribed(): boolean {
    return this.open && this.currentSub !== null;
  }

  /** Watch exactly these wallets. An empty set closes the socket (nothing to stream). */
  setWallets(wallets: readonly string[]): void {
    const next = [...new Set(wallets)].sort();
    const key = next.join(",");
    if (key === this.desiredKey) return; // unchanged (a pending reconnect keeps its backoff)
    this.desired = next;
    this.desiredKey = key;
    if (this.stopped) return;
    if (next.length === 0) {
      this.closeSocket();
      return;
    }
    if (!this.ws) this.connect();
    else if (this.open) this.subscribe();
  }

  stop(): void {
    this.stopped = true;
    this.closeSocket();
  }

  // ── Connection ────────────────────────────────────────────────────────────────────────────

  private connect(): void {
    clearTimeout(this.reconnectTimer);
    if (this.stopped || this.desired.length === 0) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(heliusWsUrl(), { handshakeTimeout: HANDSHAKE_TIMEOUT_MS });
    } catch (err) {
      this.down(redactSecrets(errText(err)));
      return;
    }
    this.ws = ws;
    ws.on("open", () => {
      if (this.ws !== ws) return;
      this.open = true;
      this.alive = true;
      meter.recordWsConnection(HELIUS_PRIORITY.copy);
      this.pingTimer = setInterval(() => this.ping(ws), PING_MS);
      this.handlers.onState("connected");
      this.subscribe();
    });
    ws.on("message", (data: RawData) => {
      if (this.ws === ws) this.onMessage(toBuffer(data));
    });
    ws.on("pong", () => {
      this.alive = true;
    });
    ws.on("error", (err: Error) => {
      if (this.ws === ws) log.debug("websocket error", { err: redactSecrets(errText(err)) });
    });
    ws.on("close", (code: number) => {
      if (this.ws === ws) this.down(`closed (${code})`);
    });
  }

  private ping(ws: WebSocket): void {
    if (this.ws !== ws) return;
    if (!this.alive) {
      log.warn("no pong from the stream; reconnecting");
      ws.terminate(); // emits "close" → down()
      return;
    }
    this.alive = false;
    try {
      ws.ping();
    } catch {
      /* close follows */
    }
  }

  /** The socket is gone: reset subscription state and reconnect with backoff. */
  private down(detail: string): void {
    this.resetSocketState();
    this.handlers.onState("disconnected", detail);
    if (this.stopped || this.desired.length === 0) return;
    const wait = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, RECONNECT_MAX_MS);
    this.reconnectTimer = setTimeout(() => this.connect(), wait);
  }

  private resetSocketState(): void {
    this.ws = null;
    this.open = false;
    clearInterval(this.pingTimer);
    for (const p of this.pending.values()) if (p.kind === "sub") clearTimeout(p.timer);
    this.pending.clear();
    this.accepted.clear();
    this.currentSub = null;
  }

  private closeSocket(): void {
    clearTimeout(this.reconnectTimer);
    const ws = this.ws;
    this.resetSocketState();
    if (!ws) return;
    ws.removeAllListeners();
    ws.on("error", () => undefined);
    ws.terminate();
  }

  // ── Subscriptions ─────────────────────────────────────────────────────────────────────────

  private send(payload: unknown): boolean {
    const ws = this.ws;
    if (!ws || !this.open) return false;
    try {
      ws.send(JSON.stringify(payload));
      return true;
    } catch (err) {
      log.debug("send failed", { err: redactSecrets(errText(err)) });
      return false;
    }
  }

  private subscribe(): void {
    if (this.desired.length === 0) return;
    const id = ++this.reqId;
    const ws = this.ws;
    const timer = setTimeout(() => {
      if (!this.pending.has(id) || this.ws !== ws || !ws) return;
      log.warn("stream subscribe timed out; reconnecting");
      ws.terminate();
    }, SUBSCRIBE_TIMEOUT_MS);
    this.pending.set(id, { kind: "sub", key: this.desiredKey, timer });
    if (!this.send({ jsonrpc: "2.0", id, method: "transactionSubscribe", params: transactionSubscribeParams(this.desired) })) {
      clearTimeout(timer);
      this.pending.delete(id);
    }
  }

  private unsubscribe(subId: number): void {
    const id = ++this.reqId;
    this.pending.set(id, { kind: "unsub", subId });
    if (!this.send({ jsonrpc: "2.0", id, method: "transactionUnsubscribe", params: [subId] })) {
      this.pending.delete(id);
      this.accepted.delete(subId);
    }
  }

  private onMessage(buf: Buffer): void {
    const receivedAt = Date.now();
    meter.recordWsBytes(buf.length, HELIUS_PRIORITY.copy);
    let msg: unknown;
    try {
      msg = JSON.parse(buf.toString("utf8"));
    } catch {
      return;
    }
    if (!isObj(msg)) return;

    if (msg.method === "transactionNotification") {
      const params = isObj(msg.params) ? msg.params : null;
      if (!params || typeof params.subscription !== "number" || !this.accepted.has(params.subscription)) return;
      if (isObj(params.result)) this.handlers.onTx(params.result, receivedAt);
      return;
    }

    if (typeof msg.id !== "number") return;
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (p.kind === "unsub") {
      this.accepted.delete(p.subId);
      return;
    }
    clearTimeout(p.timer);
    if (typeof msg.result !== "number") {
      const e = isObj(msg.error) ? msg.error : null;
      const detail = redactSecrets(String(e?.message ?? "unexpected subscribe response")).slice(0, 200);
      this.handlers.onState("rejected", detail);
      return;
    }
    const subId = msg.result;
    const old = this.currentSub;
    this.accepted.add(subId);
    this.currentSub = subId;
    if (old !== null && old !== subId) this.unsubscribe(old);
    this.backoffMs = RECONNECT_MIN_MS;
    this.handlers.onState("subscribed", `${this.desired.length} wallets`);
    // A newer wallet set may have been requested while this subscribe was in flight.
    if (p.key !== this.desiredKey && ![...this.pending.values()].some((q) => q.kind === "sub")) this.subscribe();
  }
}
