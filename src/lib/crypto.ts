// Sealed-box encryption for agent wallet secrets (x25519 + HKDF-SHA256 + AES-256-GCM) and
// owner-key helpers. node:crypto only.
//
// Blob format: "<v>." + base64url(ephemeralPub[32] | iv[12] | tag[16] | ciphertext)
// Key = HKDF-SHA256(ikm = X25519(eph, recipient), salt = ephPub || recipientPub, info = "copyfomo-seal-<v>", 32)
//   v1: no associated data (agents created before the payout binding).
//   v2: AES-GCM associated data = the agent binding (agentSealAad: deposit address + owner wallet). Opening needs
//       the SAME binding, so rewriting an agent's ownerWallet / payoutAddress in the database makes its key
//       unusable instead of redirecting withdrawals (finding F10).

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
  verify as cryptoVerify,
  type KeyObject,
} from "node:crypto";
import bs58 from "bs58";
import { config } from "./config";

const SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");
const PKCS8_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");
type SealVersion = "v1" | "v2";
const HKDF_INFO: Record<SealVersion, Buffer> = {
  v1: Buffer.from("copyfomo-seal-v1", "utf8"),
  v2: Buffer.from("copyfomo-seal-v2", "utf8"),
};
const KEY_LEN = 32;
const IV_LEN = 12;
const TAG_LEN = 16;
const HEADER_LEN = KEY_LEN + IV_LEN + TAG_LEN;

function decodeRawKey(b64: string, what: string): Buffer {
  const trimmed = b64.trim();
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(trimmed)) {
    throw new Error(`${what} is not valid base64`);
  }
  const raw = Buffer.from(trimmed, trimmed.includes("-") || trimmed.includes("_") ? "base64url" : "base64");
  if (raw.length !== KEY_LEN) {
    throw new Error(`${what} must be base64 of exactly ${KEY_LEN} raw bytes (got ${raw.length})`);
  }
  return raw;
}

function publicKeyObject(raw: Buffer): KeyObject {
  return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: "der", type: "spki" });
}

function privateKeyObject(raw: Buffer): KeyObject {
  return createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, raw]), format: "der", type: "pkcs8" });
}

function rawPublic(key: KeyObject): Buffer {
  const der = key.export({ format: "der", type: "spki" });
  return Buffer.from(der.subarray(der.length - KEY_LEN));
}

function rawPrivate(key: KeyObject): Buffer {
  const der = key.export({ format: "der", type: "pkcs8" });
  return Buffer.from(der.subarray(der.length - KEY_LEN));
}

function deriveKey(shared: Buffer, ephPub: Buffer, recipientPub: Buffer, version: SealVersion): Buffer {
  return Buffer.from(hkdfSync("sha256", shared, Buffer.concat([ephPub, recipientPub]), HKDF_INFO[version], 32));
}

/**
 * The binding a v2 agent secret is sealed under: the agent's deposit address and the wallet that owns it (the only
 * withdrawal destination). The web seals with it at creation; the worker opens with it.
 */
export function agentSealAad(depositAddress: string, ownerWallet: string): string {
  return "copyfomo-agent-v2|" + depositAddress + "|" + ownerWallet;
}

/** Version prefix of a sealed blob ("v1" / "v2"), or null when malformed. */
export function sealedVersion(sealed: string): string | null {
  const dot = sealed.indexOf(".");
  return dot > 0 ? sealed.slice(0, dot) : null;
}

/** New x25519 keypair as base64 raw 32-byte keys (for WALLET_SEAL_PUBLIC_KEY / WALLET_SEAL_PRIVATE_KEY). */
export function generateSealKeypair(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  return {
    publicKey: rawPublic(publicKey).toString("base64"),
    privateKey: rawPrivate(privateKey).toString("base64"),
  };
}

/**
 * Encrypt `secret` to the holder of the private key matching `publicKeyB64`. With `aad` (agentSealAad) the blob is
 * v2 and can only be opened with that same binding; without it, v1.
 */
export function sealSecret(secret: Uint8Array, publicKeyB64: string = config.walletSealPublicKey, aad?: string): string {
  if (!publicKeyB64) throw new Error("sealSecret: WALLET_SEAL_PUBLIC_KEY is not configured");
  if (secret.length === 0) throw new Error("sealSecret: secret is empty");
  if (aad !== undefined && aad.length === 0) throw new Error("sealSecret: empty binding (aad)");
  const version: SealVersion = aad === undefined ? "v1" : "v2";
  const recipientPub = decodeRawKey(publicKeyB64, "WALLET_SEAL_PUBLIC_KEY");

  const eph = generateKeyPairSync("x25519");
  const ephPub = rawPublic(eph.publicKey);
  const shared = diffieHellman({ privateKey: eph.privateKey, publicKey: publicKeyObject(recipientPub) });
  const key = deriveKey(shared, ephPub, recipientPub, version);
  const iv = randomBytes(IV_LEN);

  const cipher = createCipheriv("aes-256-gcm", key, iv);
  if (aad !== undefined) cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(secret), cipher.final()]);
  const tag = cipher.getAuthTag();
  key.fill(0);
  shared.fill(0);

  return `${version}.${Buffer.concat([ephPub, iv, tag, ciphertext]).toString("base64url")}`;
}

/**
 * Decrypt a blob produced by sealSecret. v2 blobs need the binding they were sealed with (`aad`); v1 blobs ignore
 * it. Throws a descriptive error on any failure.
 */
export function openSecret(sealed: string, privateKeyB64: string = config.walletSealPrivateKey, aad?: string): Uint8Array {
  if (!privateKeyB64) throw new Error("openSecret: WALLET_SEAL_PRIVATE_KEY is not configured");

  const dot = sealed.indexOf(".");
  if (dot < 0) throw new Error("openSecret: sealed blob is malformed (no version prefix)");
  const version = sealed.slice(0, dot);
  if (version !== "v1" && version !== "v2") throw new Error(`openSecret: unsupported sealed blob version "${version}"`);
  if (version === "v2" && !aad) throw new Error("openSecret: this key is bound to its agent — the binding (aad) is required");
  const body = sealed.slice(dot + 1);
  if (!/^[A-Za-z0-9_-]+$/.test(body)) throw new Error("openSecret: sealed blob is malformed (not base64url)");
  const bytes = Buffer.from(body, "base64url");
  if (bytes.length <= HEADER_LEN) throw new Error("openSecret: sealed blob is malformed (too short)");

  const ephPub = bytes.subarray(0, KEY_LEN);
  const iv = bytes.subarray(KEY_LEN, KEY_LEN + IV_LEN);
  const tag = bytes.subarray(KEY_LEN + IV_LEN, HEADER_LEN);
  const ciphertext = bytes.subarray(HEADER_LEN);

  const recipientPriv = privateKeyObject(decodeRawKey(privateKeyB64, "WALLET_SEAL_PRIVATE_KEY"));
  const recipientPub = rawPublic(createPublicKey(recipientPriv));

  let shared: Buffer;
  try {
    shared = diffieHellman({ privateKey: recipientPriv, publicKey: publicKeyObject(Buffer.from(ephPub)) });
  } catch {
    throw new Error("openSecret: sealed blob is malformed (bad ephemeral key)");
  }
  const key = deriveKey(shared, ephPub, recipientPub, version);
  shared.fill(0);

  let chunk: Buffer | null = null;
  let tail: Buffer | null = null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    if (version === "v2") decipher.setAAD(Buffer.from(aad ?? "", "utf8"));
    decipher.setAuthTag(tag);
    // Keep every plaintext buffer so all of them are wiped (finding F45: the update() chunk held a copy too).
    chunk = decipher.update(ciphertext);
    tail = decipher.final();
    const out = new Uint8Array(chunk.length + tail.length);
    out.set(chunk, 0);
    out.set(tail, chunk.length);
    return out;
  } catch {
    throw new Error(
      version === "v2"
        ? "openSecret: authentication failed (wrong private key, wrong agent binding or tampered blob)"
        : "openSecret: authentication failed (wrong private key or tampered blob)",
    );
  } finally {
    chunk?.fill(0);
    tail?.fill(0);
    key.fill(0);
  }
}

/**
 * A fresh agent wallet, sealed for the worker and bound to its owner (v2, agentSealAad). The ed25519 key is made
 * with node:crypto (no web3.js Keypair, whose secretKey getter hands out copies nobody can wipe — finding F45);
 * the seed, the 64-byte Solana secret (seed ‖ public key) and every DER export are zeroed before returning.
 * Only the deposit address (public key) and the sealed blob leave this function.
 */
export function newSealedAgentWallet(p: { ownerWallet: string; sealPublicKey?: string }): { depositAddress: string; sealedSecret: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pkcs8 = privateKey.export({ format: "der", type: "pkcs8" });
  const spki = publicKey.export({ format: "der", type: "spki" });
  const secret = new Uint8Array(64);
  try {
    if (pkcs8.length < KEY_LEN || spki.length < KEY_LEN) throw new Error("newSealedAgentWallet: unexpected key encoding");
    secret.set(pkcs8.subarray(pkcs8.length - KEY_LEN), 0);
    secret.set(spki.subarray(spki.length - KEY_LEN), KEY_LEN);
    const depositAddress = bs58.encode(secret.subarray(KEY_LEN));
    const sealedSecret = sealSecret(secret, p.sealPublicKey ?? config.walletSealPublicKey, agentSealAad(depositAddress, p.ownerWallet));
    return { depositAddress, sealedSecret };
  } finally {
    secret.fill(0);
    pkcs8.fill(0);
    spki.fill(0);
  }
}

/** Owner key shown once at agent creation: "cf_" + base58(32 random bytes). */
export function newOwnerKey(): string {
  return `cf_${bs58.encode(randomBytes(32))}`;
}

export function hashOwnerKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/**
 * ed25519 signature check (Solana wallets: signMessage, transaction signatures) with node:crypto.
 * false on any malformed input; never throws.
 */
export function verifyEd25519(message: Uint8Array, signature: Uint8Array, publicKey: Uint8Array): boolean {
  if (signature.length !== 64 || publicKey.length !== 32) return false;
  try {
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKey)]), format: "der", type: "spki" });
    return cryptoVerify(null, Buffer.from(message), key, Buffer.from(signature));
  } catch {
    return false;
  }
}

/** Constant-time comparison of two hex strings; false for malformed input or length mismatch. */
export function safeEqualHex(a: string, b: string): boolean {
  const hex = /^(?:[0-9a-fA-F]{2})*$/;
  if (a.length === 0 || a.length !== b.length || !hex.test(a) || !hex.test(b)) return false;
  const ba = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
