// Live funding guard (finding F12). The web seals each new agent key with ITS WALLET_SEAL_PUBLIC_KEY and asks the
// owner to fund the agent at once; only the worker can open that key. If the two hosts' seal keys don't pair (stale
// key, typo, another environment's key, .env.local shadowing .env), SOL would land in a wallet nobody can open.
// So, in live mode, the web refuses to create or fund an agent unless:
//   - a LIVE worker heartbeat is fresh (Kv "worker:heartbeat" < 60 s old, mode "live"), and
//   - the heartbeat's sealPublicKey (derived by the worker from its private key) is the web's public key;
//   - for an existing agent: the worker has not recorded that it can't open this agent's key (Kv "sealcheck:<id>").

import { config } from "./config";
import { kvGet } from "./db";
import { HttpError } from "./http";

const HEARTBEAT_FRESH_MS = 60_000;

interface HeartbeatKv {
  mode?: unknown;
  sealPublicKey?: unknown;
}

/** Raw 32 bytes of a base64 / base64url key, or null. */
function raw32(b64: string): Buffer | null {
  const t = b64.trim();
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(t)) return null;
  const raw = Buffer.from(t, /[-_]/.test(t) ? "base64url" : "base64");
  return raw.length === 32 ? raw : null;
}

/** Same x25519 key, whatever base64 flavour it was written in. */
export function sameSealPublicKey(a: string, b: string): boolean {
  const ra = raw32(a);
  const rb = raw32(b);
  return ra !== null && rb !== null && ra.equals(rb);
}

const OFFLINE =
  "the copy engine is offline or its seal key does not match WALLET_SEAL_PUBLIC_KEY — nothing was created or sent; try again shortly";

/**
 * Live mode: 503 unless a fresh live worker heartbeat publishes the same seal public key as this web process.
 * Paper mode: no-op (paper agents never open their key).
 */
export async function assertWorkerCanOpenNewKeys(now: number = Date.now()): Promise<void> {
  if (config.mode !== "live") return;
  const hb = await kvGet<HeartbeatKv>("worker:heartbeat").catch(() => null);
  if (!hb || now - hb.updatedAt.getTime() >= HEARTBEAT_FRESH_MS) throw new HttpError(503, OFFLINE);
  const v = hb.value;
  if (!v || v.mode !== "live" || typeof v.sealPublicKey !== "string") throw new HttpError(503, OFFLINE);
  if (!config.walletSealPublicKey || !sameSealPublicKey(v.sealPublicKey, config.walletSealPublicKey)) {
    console.error("[sealguard] the worker's seal public key does not match WALLET_SEAL_PUBLIC_KEY — refusing live funding");
    throw new HttpError(503, OFFLINE);
  }
}

/** 503 when the worker recorded that it cannot open this agent's key (Kv "sealcheck:<id>" = {ok:false}). */
export async function assertAgentKeyNotBroken(agentId: string): Promise<void> {
  const check = await kvGet<{ ok?: unknown }>(`sealcheck:${agentId}`).catch(() => null);
  if (check && check.value && check.value.ok === false) {
    throw new HttpError(503, "the copy engine can't open this agent's key — don't fund it; contact support");
  }
}

/** Live activation gate: the worker opened this agent's key and it signs for the deposit address. */
export async function agentKeyVerified(agentId: string): Promise<boolean> {
  const check = await kvGet<{ ok?: unknown }>(`sealcheck:${agentId}`).catch(() => null);
  return check?.value?.ok === true;
}
