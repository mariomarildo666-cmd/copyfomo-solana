// Test-only helpers for the worker's money-path tests (never imported by production code): an in-memory Solana
// "chain" that stands in for the web3.js Connection singleton (globalThis.__copyfomoConnection), with scripted
// transaction effects, simulation, status lookups and transaction metadata. Nothing here touches the network.

import { generateKeyPairSync } from "node:crypto";
import {
  PublicKey,
  SendTransactionError,
  SystemProgram,
  VersionedTransaction,
  type AccountInfo,
} from "@solana/web3.js";
import bs58 from "bs58";

export const SYSTEM = SystemProgram.programId.toBase58();
export const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const BLOCKHASH = "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N";

export interface TokenFields {
  mint: string;
  owner: string;
  amount: bigint;
  delegate?: string | null;
  state?: number;
  closeAuthority?: string | null;
}

/** SPL token account bytes (165-byte base layout). */
export function encodeTokenAccount(t: TokenFields): Buffer {
  const b = Buffer.alloc(165);
  new PublicKey(t.mint).toBuffer().copy(b, 0);
  new PublicKey(t.owner).toBuffer().copy(b, 32);
  b.writeBigUInt64LE(t.amount, 64);
  if (t.delegate) {
    b.writeUInt32LE(1, 72);
    new PublicKey(t.delegate).toBuffer().copy(b, 76);
  }
  b[108] = t.state ?? 1;
  if (t.closeAuthority) {
    b.writeUInt32LE(1, 129);
    new PublicKey(t.closeAuthority).toBuffer().copy(b, 133);
  }
  return b;
}

export function decodeTokenFields(data: Buffer): TokenFields {
  return {
    mint: new PublicKey(data.subarray(0, 32)).toBase58(),
    owner: new PublicKey(data.subarray(32, 64)).toBase58(),
    amount: data.readBigUInt64LE(64),
    delegate: data.readUInt32LE(72) === 1 ? new PublicKey(data.subarray(76, 108)).toBase58() : null,
    state: data[108],
    closeAuthority: data.readUInt32LE(129) === 1 ? new PublicKey(data.subarray(133, 165)).toBase58() : null,
  };
}

export interface Acct {
  lamports: number;
  owner: string;
  data: Buffer;
}

/** A change a (scripted) transaction makes. */
export type Effect =
  | { kind: "lamports"; address: string; delta: number }
  | { kind: "tokens"; address: string; delta: bigint }
  | { kind: "create_token"; address: string; fields: TokenFields; programId?: string; lamports?: number }
  | { kind: "close"; address: string; to: string }
  | { kind: "assign"; address: string; owner: string }
  | { kind: "delegate"; address: string; delegate: string };

export type Landing = "land" | "fail" | "drop" | "reject";

export interface SentTx {
  signature: string;
  tx: VersionedTransaction;
  at: number;
}

/** Base fee (5,000 lamports per signature) + compute-budget priority fee, as the runtime charges it. */
export function networkFee(tx: VersionedTransaction): number {
  const keys = tx.message.staticAccountKeys.map((k) => k.toBase58());
  let limit: number | null = null;
  let price = BigInt(0);
  let others = 0;
  for (const ix of tx.message.compiledInstructions) {
    const data = Buffer.from(ix.data);
    if (keys[ix.programIdIndex] !== "ComputeBudget111111111111111111111111111111") {
      others++;
      continue;
    }
    if (data[0] === 2) limit = data.readUInt32LE(1);
    if (data[0] === 3) price = data.readBigUInt64LE(1);
  }
  const cu = BigInt(limit ?? Math.min(200_000 * others, 1_400_000));
  return 5_000 * tx.message.header.numRequiredSignatures + Number((cu * price + BigInt(999_999)) / BigInt(1_000_000));
}

const clone = (a: Acct): Acct => ({ lamports: a.lamports, owner: a.owner, data: Buffer.from(a.data) });

/**
 * In-memory chain. Tests script what a transaction does with `effects(tx)` and how its send ends with
 * `landing(tx)`. Statuses can be hidden from `getSignatureStatuses` until a block height (WebSocket / RPC lag).
 */
export class FakeChain {
  accounts = new Map<string, Acct>();
  decimals = new Map<string, number>();
  sent: SentTx[] = [];
  broadcasts = 0;
  blockHeight = 1_000;
  /** Block height advance per getBlockHeight call (time passing). */
  heightStep = 5;
  statuses = new Map<string, { slot: number; err: unknown; hiddenUntilHeight?: number; hideFromHistory?: boolean }>();
  metas = new Map<string, unknown>();
  effects: (tx: VersionedTransaction) => Effect[] = () => [];
  landing: (tx: VersionedTransaction) => Landing = () => "land";
  simErr: unknown = null;
  /** Called at the first broadcast of each signature (tests assert what was persisted before it). */
  onBroadcast: ((signature: string, tx: VersionedTransaction) => void | Promise<void>) | null = null;
  /** Throw this from getTokenAccountsByOwner / getParsedTokenAccountsByOwner calls (count-limited). */
  tokenListFailures = 0;
  /** Serve an empty token-account listing this many times (index lag). */
  tokenListEmpty = 0;
  /** New statuses are invisible to plain status polls until this block height (a lagging node / missed WS). */
  hideStatusesUntilHeight: number | null = null;
  /** Hide getTransaction results for this many calls per signature. */
  metaDelayCalls = 0;
  private metaCalls = new Map<string, number>();

  install(): this {
    (globalThis as unknown as { __copyfomoConnection?: unknown }).__copyfomoConnection = this;
    return this;
  }

  setWallet(address: string, lamports: number): void {
    this.accounts.set(address, { lamports, owner: SYSTEM, data: Buffer.alloc(0) });
  }

  setToken(address: string, fields: TokenFields, programId = TOKEN, lamports = 2_039_280): void {
    this.accounts.set(address, { lamports, owner: programId, data: encodeTokenAccount(fields) });
  }

  lamportsOf(address: string): number {
    return this.accounts.get(address)?.lamports ?? 0;
  }

  tokenAmount(address: string): bigint {
    const a = this.accounts.get(address);
    return a && a.data.length >= 165 ? a.data.readBigUInt64LE(64) : BigInt(0);
  }

  /** Apply effects to a copy of `state` (or the real state). */
  apply(effects: Effect[], state: Map<string, Acct> = this.accounts): void {
    for (const e of effects) {
      const a = state.get(e.address);
      switch (e.kind) {
        case "lamports":
          if (a) a.lamports += e.delta;
          else state.set(e.address, { lamports: e.delta, owner: SYSTEM, data: Buffer.alloc(0) });
          break;
        case "tokens":
          if (a) a.data.writeBigUInt64LE(a.data.readBigUInt64LE(64) + e.delta, 64);
          break;
        case "create_token":
          state.set(e.address, { lamports: e.lamports ?? 2_039_280, owner: e.programId ?? TOKEN, data: encodeTokenAccount(e.fields) });
          break;
        case "close": {
          if (!a) break;
          const to = state.get(e.to);
          if (to) to.lamports += a.lamports;
          state.delete(e.address);
          break;
        }
        case "assign":
          if (a) a.owner = e.owner;
          break;
        case "delegate":
          if (a) {
            a.data.writeUInt32LE(1, 72);
            new PublicKey(e.delegate).toBuffer().copy(a.data, 76);
          }
          break;
      }
    }
  }

  private snapshot(): Map<string, Acct> {
    return new Map([...this.accounts].map(([k, v]) => [k, clone(v)]));
  }

  private info(a: Acct | undefined): AccountInfo<Buffer> | null {
    return a ? { lamports: a.lamports, owner: new PublicKey(a.owner), data: Buffer.from(a.data), executable: false, rentEpoch: 0 } : null;
  }

  // ── Connection surface used by the worker ──────────────────────────────────────────────────────

  async getLatestBlockhash() {
    return { blockhash: BLOCKHASH, lastValidBlockHeight: this.blockHeight + 150 };
  }

  async getBlockHeight() {
    this.blockHeight += this.heightStep;
    return this.blockHeight;
  }

  async getBalance(pk: PublicKey) {
    return this.lamportsOf(pk.toBase58());
  }

  private ownedTokenAccounts(owner: string, programId: string) {
    if (this.tokenListFailures > 0) {
      this.tokenListFailures--;
      throw new Error("fake rpc: 503 Service Unavailable");
    }
    if (this.tokenListEmpty > 0) {
      this.tokenListEmpty--;
      return [];
    }
    const out: { pubkey: PublicKey; acct: Acct; fields: TokenFields }[] = [];
    for (const [address, acct] of this.accounts) {
      if (acct.owner !== programId || acct.data.length < 165) continue;
      const fields = decodeTokenFields(acct.data);
      if (fields.owner === owner) out.push({ pubkey: new PublicKey(address), acct, fields });
    }
    return out;
  }

  async getTokenAccountsByOwner(owner: PublicKey, filter: { programId: PublicKey }) {
    const rows = this.ownedTokenAccounts(owner.toBase58(), filter.programId.toBase58());
    return { context: { slot: 1 }, value: rows.map((r) => ({ pubkey: r.pubkey, account: this.info(r.acct)! })) };
  }

  async getParsedTokenAccountsByOwner(owner: PublicKey, filter: { programId: PublicKey }) {
    const rows = this.ownedTokenAccounts(owner.toBase58(), filter.programId.toBase58());
    return {
      context: { slot: 1 },
      value: rows.map((r) => ({
        pubkey: r.pubkey,
        account: {
          lamports: r.acct.lamports,
          owner: new PublicKey(r.acct.owner),
          executable: false,
          rentEpoch: 0,
          data: {
            program: "spl-token",
            parsed: {
              type: "account",
              info: {
                mint: r.fields.mint,
                owner: r.fields.owner,
                state: r.fields.state === 2 ? "frozen" : "initialized",
                isNative: false,
                tokenAmount: { amount: r.fields.amount.toString(), decimals: this.decimals.get(r.fields.mint) ?? 6 },
              },
            },
          },
        },
      })),
    };
  }

  async getParsedAccountInfo(pk: PublicKey) {
    const d = this.decimals.get(pk.toBase58()) ?? 6;
    return { context: { slot: 1 }, value: { data: { parsed: { info: { decimals: d } } } } };
  }

  async getMultipleAccountsInfo(pks: PublicKey[]) {
    return pks.map((pk) => this.info(this.accounts.get(pk.toBase58())));
  }

  async getAddressLookupTable() {
    return { context: { slot: 1 }, value: null };
  }

  async simulateTransaction(tx: VersionedTransaction, cfg: { accounts?: { addresses: string[] } }) {
    const state = this.snapshot();
    this.apply(this.effects(tx), state);
    const accounts = (cfg.accounts?.addresses ?? []).map((a) => {
      const acct = state.get(a);
      return acct ? { lamports: acct.lamports, owner: acct.owner, data: [acct.data.toString("base64"), "base64"], executable: false } : null;
    });
    return { context: { slot: 1 }, value: { err: this.simErr, logs: [], accounts } };
  }

  async sendRawTransaction(raw: Uint8Array, opts?: { skipPreflight?: boolean }) {
    this.broadcasts++;
    const tx = VersionedTransaction.deserialize(raw);
    const signature = bs58.encode(tx.signatures[0]!);
    if (this.sent.some((s) => s.signature === signature)) return signature; // rebroadcast
    const landing = this.landing(tx);
    if (landing === "reject" && !opts?.skipPreflight) {
      throw new SendTransactionError({ action: "send", signature, transactionMessage: "Simulation failed: custom program error 0x1771", logs: [] });
    }
    if (this.onBroadcast) await this.onBroadcast(signature, tx);
    this.sent.push({ signature, tx, at: Date.now() });
    if (landing === "drop" || landing === "reject") return signature;
    const keys = tx.message.staticAccountKeys.map((k) => k.toBase58());
    const before = this.snapshot();
    const fee = networkFee(tx);
    const payer = this.accounts.get(keys[0]!);
    if (payer) payer.lamports -= fee;
    if (landing === "land") this.apply(this.effects(tx));
    this.statuses.set(signature, {
      slot: 100 + this.sent.length,
      err: landing === "fail" ? { InstructionError: [0, { Custom: 6001 }] } : null,
      ...(this.hideStatusesUntilHeight !== null ? { hiddenUntilHeight: this.hideStatusesUntilHeight } : {}),
    });
    this.metas.set(signature, this.buildMeta(keys, before, landing === "fail" ? { InstructionError: [0, { Custom: 6001 }] } : null, fee));
    return signature;
  }

  private tokenBalances(keys: string[], state: Map<string, Acct>) {
    const out: { accountIndex: number; mint: string; owner: string; uiTokenAmount: { amount: string; decimals: number } }[] = [];
    keys.forEach((k, i) => {
      const a = state.get(k);
      if (!a || a.data.length < 165 || (a.owner !== TOKEN && a.owner !== TOKEN_2022)) return;
      const f = decodeTokenFields(a.data);
      out.push({ accountIndex: i, mint: f.mint, owner: f.owner, uiTokenAmount: { amount: f.amount.toString(), decimals: this.decimals.get(f.mint) ?? 6 } });
    });
    return out;
  }

  private buildMeta(keys: string[], before: Map<string, Acct>, err: unknown, fee: number) {
    return {
      slot: 100 + this.sent.length,
      transaction: { message: { staticAccountKeys: keys.map((k) => new PublicKey(k)) } },
      meta: {
        err,
        fee,
        preBalances: keys.map((k) => before.get(k)?.lamports ?? 0),
        postBalances: keys.map((k) => this.accounts.get(k)?.lamports ?? 0),
        preTokenBalances: this.tokenBalances(keys, before),
        postTokenBalances: this.tokenBalances(keys, this.accounts),
      },
    };
  }

  async getSignatureStatuses(sigs: string[], cfg?: { searchTransactionHistory?: boolean }) {
    return {
      context: { slot: 1 },
      value: sigs.map((s) => {
        const st = this.statuses.get(s);
        if (!st) return null;
        if (st.hiddenUntilHeight !== undefined && this.blockHeight <= st.hiddenUntilHeight && !cfg?.searchTransactionHistory) return null;
        if (st.hideFromHistory && cfg?.searchTransactionHistory) return null;
        return { slot: st.slot, confirmations: null, err: st.err, confirmationStatus: "confirmed" as const };
      }),
    };
  }

  async getTransaction(sig: string) {
    const n = (this.metaCalls.get(sig) ?? 0) + 1;
    this.metaCalls.set(sig, n);
    if (n <= this.metaDelayCalls) return null;
    return this.metas.get(sig) ?? null;
  }
}

/** Effects of the plain System transfers in `tx` (withdrawals, fee sweeps). */
export function systemTransferEffects(tx: VersionedTransaction): Effect[] {
  const keys = tx.message.staticAccountKeys.map((k) => k.toBase58());
  const out: Effect[] = [];
  for (const ix of tx.message.compiledInstructions) {
    if (keys[ix.programIdIndex] !== SYSTEM || ix.data.length !== 12) continue;
    const data = Buffer.from(ix.data);
    if (data.readUInt32LE(0) !== 2) continue;
    const lamports = Number(data.readBigUInt64LE(4));
    out.push({ kind: "lamports", address: keys[ix.accountKeyIndexes[0]!]!, delta: -lamports });
    out.push({ kind: "lamports", address: keys[ix.accountKeyIndexes[1]!]!, delta: lamports });
  }
  return out;
}

/** Destination and lamports of each System transfer in `tx`. */
export function transfersIn(tx: VersionedTransaction): { to: string; lamports: number }[] {
  const out: { to: string; lamports: number }[] = [];
  const effects = systemTransferEffects(tx);
  for (let i = 1; i < effects.length; i += 2) {
    const e = effects[i]!;
    if (e.kind === "lamports") out.push({ to: e.address, lamports: e.delta });
  }
  return out;
}

/** Fresh x25519 seal key pair (base64 raw), for WALLET_SEAL_PUBLIC_KEY / WALLET_SEAL_PRIVATE_KEY in tests. */
export function testSealKeys(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  const raw = (der: Buffer) => Buffer.from(der.subarray(der.length - 32)).toString("base64");
  return {
    publicKey: raw(publicKey.export({ format: "der", type: "spki" })),
    privateKey: raw(privateKey.export({ format: "der", type: "pkcs8" })),
  };
}

/** A throwaway base58 address. */
export function addr(): string {
  return new PublicKey(Buffer.from(Array.from({ length: 32 }, () => Math.floor(Math.random() * 256)))).toBase58();
}
