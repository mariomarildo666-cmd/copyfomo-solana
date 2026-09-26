// Agent signing keys live in memory only for the duration of one operation.
//
// The sealed secret (64 bytes: ed25519 seed ‖ public key) is opened, turned into a node:crypto KeyObject (the
// private key then lives in OpenSSL memory, which is cleansed when the key is freed) and every plaintext copy we
// made is zeroed at once. We never build a web3.js Keypair: its `secretKey` getter and `sign()` hand out
// unzeroed copies of the secret on every call (finding F45). Signatures come from `AgentSigner.sign`.

import { createPrivateKey, createPublicKey, sign as cryptoSign, type KeyObject } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { config } from "@/lib/config";
import { agentSealAad, openSecret, sealedVersion } from "@/lib/crypto";

export interface SealedAgent {
  sealedSecret: string;
  depositAddress: string;
  /**
   * The wallet that owns the agent. v2 blobs are sealed under agentSealAad(depositAddress, ownerWallet) (finding
   * F10): a rewritten ownerWallet can't open the key, so it can never redirect withdrawals. null: legacy agent.
   */
  ownerWallet: string | null;
}

/** The AES-GCM binding to open this agent's blob with (v2), or undefined for legacy v1 blobs. */
function bindingOf(agent: SealedAgent): string | undefined {
  if (sealedVersion(agent.sealedSecret) !== "v2") return undefined;
  if (!agent.ownerWallet) throw new Error("openSecret: this key is bound to an owner wallet, but the agent has none");
  return agentSealAad(agent.depositAddress, agent.ownerWallet);
}

/** Signs for exactly one agent wallet (the deposit address). */
export interface AgentSigner {
  readonly publicKey: PublicKey;
  /** base58 of publicKey (= the agent's deposit address). */
  readonly address: string;
  /** ed25519 signature (64 bytes) of `message`. */
  sign(message: Uint8Array): Uint8Array;
}

/** DER prefixes that wrap a raw 32-byte ed25519 seed / public key for node:crypto. */
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const SEED_LEN = 32;
const SECRET_LEN = 64;

function rawEd25519Public(key: KeyObject): Buffer {
  const der = createPublicKey(key).export({ format: "der", type: "spki" });
  return Buffer.from(der.subarray(der.length - 32));
}

/** A signer from a 64-byte Solana secret key. The caller zeroes `secret`; nothing here keeps a JS copy of it. */
export function signerFromSecret(secret: Uint8Array): AgentSigner {
  if (secret.length !== SECRET_LEN) throw new Error(`agent secret must be ${SECRET_LEN} bytes, got ${secret.length}`);
  const der = Buffer.alloc(ED25519_PKCS8_PREFIX.length + SEED_LEN); // own allocation (not the shared pool)
  let key: KeyObject;
  try {
    ED25519_PKCS8_PREFIX.copy(der, 0);
    der.set(secret.subarray(0, SEED_LEN), ED25519_PKCS8_PREFIX.length);
    key = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
  } finally {
    der.fill(0);
  }
  const pub = rawEd25519Public(key);
  // The stored public half must be the one the seed derives (a corrupt or swapped secret never signs).
  if (!pub.equals(Buffer.from(secret.subarray(SEED_LEN)))) throw new Error("agent secret is inconsistent (public half does not match the seed)");
  const publicKey = new PublicKey(pub);
  return {
    publicKey,
    address: publicKey.toBase58(),
    sign: (message) => new Uint8Array(cryptoSign(null, Buffer.from(message.buffer, message.byteOffset, message.byteLength), key)),
  };
}

/**
 * Open the agent's sealed secret, run `fn` with a signer for it, then drop the key. Refuses to sign for any wallet
 * other than the agent's deposit address.
 */
export async function withAgentSigner<T>(agent: SealedAgent, fn: (signer: AgentSigner) => Promise<T>): Promise<T> {
  const secret = openSecret(agent.sealedSecret, undefined, bindingOf(agent));
  let signer: AgentSigner;
  try {
    signer = signerFromSecret(secret);
  } finally {
    secret.fill(0);
  }
  if (signer.address !== agent.depositAddress) {
    throw new Error("sealed key does not match the agent's deposit address");
  }
  return fn(signer);
}

/** openSecret / key-mismatch failures: the agent's key can't be used (wrong seal key pair, tampered blob). */
export function isSealKeyError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /openSecret:|sealed key does not match|agent secret (must be|is inconsistent)/.test(msg);
}

/** Paper agents are always simulated; live agents are only touched by a worker running in live mode. */
export function workerHandlesMode(agentMode: string): boolean {
  return agentMode === "paper" || (agentMode === "live" && config.mode === "live");
}
