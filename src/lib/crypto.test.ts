import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import bs58 from "bs58";
import {
  agentSealAad,
  generateSealKeypair,
  hashOwnerKey,
  newOwnerKey,
  openSecret,
  safeEqualHex,
  sealSecret,
} from "./crypto";

test("generateSealKeypair returns base64 raw 32-byte keys", () => {
  const { publicKey, privateKey } = generateSealKeypair();
  assert.equal(Buffer.from(publicKey, "base64").length, 32);
  assert.equal(Buffer.from(privateKey, "base64").length, 32);
  assert.notEqual(publicKey, privateKey);
});

test("seal → open roundtrip (64-byte Solana secret)", () => {
  const { publicKey, privateKey } = generateSealKeypair();
  const secret = new Uint8Array(randomBytes(64));
  const sealed = sealSecret(secret, publicKey);
  assert.match(sealed, /^v1\.[A-Za-z0-9_-]+$/);
  assert.deepEqual(openSecret(sealed, privateKey), secret);
});

test("sealing is randomized (fresh ephemeral key + IV each time)", () => {
  const { publicKey, privateKey } = generateSealKeypair();
  const secret = new Uint8Array([1, 2, 3, 4]);
  const a = sealSecret(secret, publicKey);
  const b = sealSecret(secret, publicKey);
  assert.notEqual(a, b);
  assert.deepEqual(openSecret(a, privateKey), secret);
  assert.deepEqual(openSecret(b, privateKey), secret);
});

test("wrong private key fails authentication", () => {
  const alice = generateSealKeypair();
  const mallory = generateSealKeypair();
  const sealed = sealSecret(new Uint8Array(randomBytes(64)), alice.publicKey);
  assert.throws(() => openSecret(sealed, mallory.privateKey), /authentication failed/);
});

test("tampering with any part of the blob fails", () => {
  const { publicKey, privateKey } = generateSealKeypair();
  const sealed = sealSecret(new Uint8Array(randomBytes(64)), publicKey);
  const bytes = Buffer.from(sealed.slice(3), "base64url");
  // ephemeral key, iv, tag, ciphertext
  for (const offset of [0, 33, 45, 60, bytes.length - 1]) {
    const copy = Buffer.from(bytes);
    copy[offset] ^= 0x01;
    const tampered = `v1.${copy.toString("base64url")}`;
    assert.throws(() => openSecret(tampered, privateKey), /openSecret:/, `offset ${offset}`);
  }
});

test("openSecret rejects bad versions, malformed blobs and missing keys", () => {
  const { publicKey, privateKey } = generateSealKeypair();
  const sealed = sealSecret(new Uint8Array([9, 9, 9]), publicKey);
  assert.throws(() => openSecret(sealed.replace(/^v1/, "v3"), privateKey), /unsupported sealed blob version/);
  assert.throws(() => openSecret("no-dot-here", privateKey), /malformed/);
  assert.throws(() => openSecret("v1.@@@", privateKey), /malformed/);
  assert.throws(() => openSecret("v1.AAAA", privateKey), /too short/);
  assert.throws(() => openSecret(sealed, ""), /WALLET_SEAL_PRIVATE_KEY is not configured/);
  assert.throws(() => sealSecret(new Uint8Array([1]), ""), /WALLET_SEAL_PUBLIC_KEY is not configured/);
  assert.throws(() => sealSecret(new Uint8Array([1]), Buffer.alloc(16).toString("base64")), /32 raw bytes/);
});

test("owner keys: format, hashing, constant-time compare", () => {
  const key = newOwnerKey();
  assert.match(key, /^cf_[1-9A-HJ-NP-Za-km-z]+$/);
  assert.equal(bs58.decode(key.slice(3)).length, 32);
  assert.notEqual(newOwnerKey(), key);

  const hash = hashOwnerKey(key);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(hashOwnerKey(key), hash);
  assert.notEqual(hashOwnerKey(`${key}x`), hash);

  assert.equal(safeEqualHex(hash, hashOwnerKey(key)), true);
  assert.equal(safeEqualHex(hash, hashOwnerKey(newOwnerKey())), false);
  assert.equal(safeEqualHex(hash, hash.slice(0, 62)), false);
  assert.equal(safeEqualHex(hash, "zz".repeat(32)), false);
  assert.equal(safeEqualHex("", ""), false);
});

test("v2 blobs are bound to their agent: the same binding opens them, any other binding or none fails (F10)", () => {
  const { publicKey, privateKey } = generateSealKeypair();
  const secret = new Uint8Array(randomBytes(64));
  const aad = agentSealAad("Dep1111111111111111111111111111111111111111", "Own1111111111111111111111111111111111111111");
  const sealed = sealSecret(secret, publicKey, aad);
  assert.match(sealed, /^v2\.[A-Za-z0-9_-]+$/);
  assert.deepEqual(openSecret(sealed, privateKey, aad), secret);
  // Rewriting the owner wallet (the withdrawal destination) in the DB breaks the key instead of redirecting funds.
  const moved = agentSealAad("Dep1111111111111111111111111111111111111111", "Att1111111111111111111111111111111111111111");
  assert.throws(() => openSecret(sealed, privateKey, moved), /authentication failed/);
  assert.throws(() => openSecret(sealed, privateKey), /binding \(aad\) is required/);
  // Relabelling a v2 blob as v1 (to skip the binding) fails authentication: different KDF info + AAD.
  assert.throws(() => openSecret(sealed.replace(/^v2/, "v1"), privateKey), /authentication failed/);
  // v1 blobs still open, with or without a binding (agents created before v2).
  const legacy = sealSecret(secret, publicKey);
  assert.deepEqual(openSecret(legacy, privateKey, aad), secret);
  assert.throws(() => sealSecret(secret, publicKey, ""), /empty binding/);
});

test("newSealedAgentWallet: v2 blob bound to the owner; opens to seed ‖ pub of the deposit address (F10/F45)", async () => {
  const { newSealedAgentWallet } = await import("./crypto");
  const { createPrivateKey, createPublicKey } = await import("node:crypto");
  const { publicKey, privateKey } = generateSealKeypair();
  const owner = "Own1111111111111111111111111111111111111111";
  const w = newSealedAgentWallet({ ownerWallet: owner, sealPublicKey: publicKey });
  assert.equal(bs58.decode(w.depositAddress).length, 32);
  assert.match(w.sealedSecret, /^v2\./);
  const secret = openSecret(w.sealedSecret, privateKey, agentSealAad(w.depositAddress, owner));
  assert.equal(secret.length, 64);
  assert.equal(bs58.encode(secret.subarray(32)), w.depositAddress);
  // The seed really derives the stored public half.
  const der = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(secret.subarray(0, 32))]);
  const spki = createPublicKey(createPrivateKey({ key: der, format: "der", type: "pkcs8" })).export({ format: "der", type: "spki" });
  assert.equal(bs58.encode(spki.subarray(spki.length - 32)), w.depositAddress);
  assert.throws(() => openSecret(w.sealedSecret, privateKey, agentSealAad(w.depositAddress, "Att1111111111111111111111111111111111111111")), /authentication failed/);
  assert.notEqual(newSealedAgentWallet({ ownerWallet: owner, sealPublicKey: publicKey }).depositAddress, w.depositAddress);
});
