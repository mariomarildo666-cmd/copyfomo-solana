// Seal-key pairing checks (finding F12). The web seals each new agent secret with ITS WALLET_SEAL_PUBLIC_KEY and
// shows the deposit address at once; only the worker can open it. If the two hosts' keys don't pair (stale key,
// typo, a different environment's key, .env.local shadowing .env in Next.js), deposits land in wallets nobody can
// open. So:
//   - the worker derives its seal PUBLIC key from WALLET_SEAL_PRIVATE_KEY and publishes it in the heartbeat
//     (it is public; the web can refuse to create live agents when its own key differs);
//   - every live agent's sealed secret is opened once per process and must derive its deposit address; an
//     awaiting_deposit agent is only switched on after that check, and an agent that fails it is paused.

import { createPrivateKey, createPublicKey } from "node:crypto";
import { config } from "@/lib/config";
import { kvSet } from "@/lib/db";
import { errText } from "./log";
import { withAgentSigner, type SealedAgent } from "./wallet";

const X25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");

function decodeRaw32(b64: string): Buffer | null {
  const t = b64.trim();
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(t)) return null;
  const raw = Buffer.from(t, /[-_]/.test(t) ? "base64url" : "base64");
  return raw.length === 32 ? raw : null;
}

/** base64 raw x25519 public key that pairs with `privateKeyB64`, or null when it is not a usable key. */
export function sealPublicKeyFromPrivate(privateKeyB64: string): string | null {
  const raw = decodeRaw32(privateKeyB64);
  if (!raw) return null;
  const der = Buffer.alloc(X25519_PKCS8_PREFIX.length + 32);
  try {
    X25519_PKCS8_PREFIX.copy(der, 0);
    raw.copy(der, X25519_PKCS8_PREFIX.length);
    const pub = createPublicKey(createPrivateKey({ key: der, format: "der", type: "pkcs8" })).export({ format: "der", type: "spki" });
    return Buffer.from(pub.subarray(pub.length - 32)).toString("base64");
  } catch {
    return null;
  } finally {
    der.fill(0);
    raw.fill(0);
  }
}

/** Same key, whatever base64 flavour / padding it was written in. */
export function sameSealKey(a: string, b: string): boolean {
  const ra = decodeRaw32(a);
  const rb = decodeRaw32(b);
  return ra !== null && rb !== null && ra.equals(rb);
}

/** The worker's seal public key ("" when it has no usable private key). */
export function workerSealPublicKey(): string {
  return config.walletSealPrivateKey ? (sealPublicKeyFromPrivate(config.walletSealPrivateKey) ?? "") : "";
}

export const sealCheckKey = (agentId: string) => `sealcheck:${agentId}`;

/** Open the agent's sealed secret and prove it signs for its deposit address. Records the result in Kv. */
export async function verifyAgentKey(agent: SealedAgent & { id: string }): Promise<{ ok: true } | { ok: false; error: string }> {
  let result: { ok: true } | { ok: false; error: string };
  try {
    await withAgentSigner(agent, async () => undefined);
    result = { ok: true };
  } catch (err) {
    result = { ok: false, error: errText(err, 160) };
  }
  await kvSet(sealCheckKey(agent.id), { ...result, at: new Date().toISOString() }).catch(() => undefined);
  return result;
}
