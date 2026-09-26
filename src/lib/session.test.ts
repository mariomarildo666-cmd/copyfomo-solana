// Run: npx tsx --test src/lib/session.test.ts
// Wallet sign-in + session cookie + same-origin checks, against a throwaway SQLite DB (nonces live in Kv).
import "./__testing__/env"; // first: keeps the real .env (keys, RPC URLs) out of this test
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, sign as edSign, type KeyObject } from "node:crypto";
import bs58 from "bs58";
import { createTestDatabase } from "./__testing__/db";

const testDb = createTestDatabase();
process.env.SESSION_SECRET = randomBytes(32).toString("base64url");

type Session = typeof import("./session");
type Auth = typeof import("./auth");
let s: Session;
let auth: Auth;
let prisma: typeof import("./db").prisma;
let HttpError: typeof import("./http").HttpError;

before(async () => {
  s = await import("./session");
  auth = await import("./auth");
  ({ prisma } = await import("./db"));
  ({ HttpError } = await import("./http"));
});

after(async () => {
  await prisma?.$disconnect();
  testDb.cleanup();
});

function wallet(): { address: string; privateKey: KeyObject } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const der = publicKey.export({ format: "der", type: "spki" });
  return { address: bs58.encode(der.subarray(der.length - 32)), privateKey };
}

function signText(message: string, privateKey: KeyObject): string {
  return bs58.encode(edSign(null, Buffer.from(message, "utf8"), privateKey));
}

function isHttp(status: number, match?: RegExp) {
  return (err: unknown) => {
    assert.ok(err instanceof HttpError, `expected HttpError, got ${String(err)}`);
    assert.equal(err.status, status);
    if (match) assert.match(err.message, match);
    return true;
  };
}

const DOMAIN = "copyfomo.test:3001";

test("sign in: a wallet-signed challenge verifies once and returns the wallet", async () => {
  const w = wallet();
  const ch = await s.createSignInChallenge({ wallet: w.address, domain: DOMAIN });
  assert.ok(ch.message.startsWith(`${DOMAIN} wants you to sign in with your Solana account:\n${w.address}\n`));
  assert.ok(ch.message.includes(`Nonce: ${ch.nonce}`));
  const signature = signText(ch.message, w.privateKey);
  assert.equal(await s.verifySignIn({ wallet: w.address, message: ch.message, signature, expectedDomain: DOMAIN }), w.address);
});

test("replayed nonce: the same signed message is rejected the second time", async () => {
  const w = wallet();
  const ch = await s.createSignInChallenge({ wallet: w.address, domain: DOMAIN });
  const signature = signText(ch.message, w.privateKey);
  await s.verifySignIn({ wallet: w.address, message: ch.message, signature, expectedDomain: DOMAIN });
  await assert.rejects(
    s.verifySignIn({ wallet: w.address, message: ch.message, signature, expectedDomain: DOMAIN }),
    isHttp(401, /already used|expired/),
  );
});

test("wrong domain: a message signed for another site is rejected (and the nonce is not burned)", async () => {
  const w = wallet();
  const ch = await s.createSignInChallenge({ wallet: w.address, domain: DOMAIN });
  const signature = signText(ch.message, w.privateKey);
  await assert.rejects(
    s.verifySignIn({ wallet: w.address, message: ch.message, signature, expectedDomain: "evil.example" }),
    isHttp(401, /another site/),
  );
  // A phishing site that re-labels the domain line cannot reuse the nonce either.
  const relabelled = ch.message.replace(DOMAIN, "evil.example");
  await assert.rejects(
    s.verifySignIn({ wallet: w.address, message: relabelled, signature: signText(relabelled, w.privateKey), expectedDomain: "evil.example" }),
    isHttp(401),
  );
  // The legit verification still works afterwards.
  assert.equal(await s.verifySignIn({ wallet: w.address, message: ch.message, signature, expectedDomain: DOMAIN }), w.address);
});

test("expired: a challenge older than 10 minutes is rejected", async () => {
  const w = wallet();
  const ch = await s.createSignInChallenge({ wallet: w.address, domain: DOMAIN, now: new Date(Date.now() - 11 * 60_000) });
  const signature = signText(ch.message, w.privateKey);
  await assert.rejects(s.verifySignIn({ wallet: w.address, message: ch.message, signature, expectedDomain: DOMAIN }), isHttp(401, /expired/));
});

test("bad signatures, other wallets and edited messages are rejected", async () => {
  const w = wallet();
  const other = wallet();
  const ch = await s.createSignInChallenge({ wallet: w.address, domain: DOMAIN });
  // Signed by another key.
  await assert.rejects(
    s.verifySignIn({ wallet: w.address, message: ch.message, signature: signText(ch.message, other.privateKey), expectedDomain: DOMAIN }),
    isHttp(401, /signature/),
  );
  // Claiming the challenge for a different wallet.
  await assert.rejects(
    s.verifySignIn({ wallet: other.address, message: ch.message, signature: signText(ch.message, other.privateKey), expectedDomain: DOMAIN }),
    isHttp(401),
  );
  // Extra text the server did not issue (even if the wallet signed it).
  const edited = `${ch.message}\nResources:\n- https://evil.example`;
  await assert.rejects(
    s.verifySignIn({ wallet: w.address, message: edited, signature: signText(edited, w.privateKey), expectedDomain: DOMAIN }),
    isHttp(401, /does not match/),
  );
  // A later expiry than issued.
  const later = ch.message.replace(/Expiration Time: .*/, `Expiration Time: ${new Date(Date.now() + 86_400_000).toISOString()}`);
  await assert.rejects(
    s.verifySignIn({ wallet: w.address, message: later, signature: signText(later, w.privateKey), expectedDomain: DOMAIN }),
    isHttp(401, /does not match/),
  );
  // Malformed input is a 400.
  await assert.rejects(s.verifySignIn({ wallet: "nope", message: ch.message, signature: "x", expectedDomain: DOMAIN }), isHttp(400));
  await assert.rejects(s.verifySignIn({ wallet: w.address, message: ch.message, signature: "111", expectedDomain: DOMAIN }), isHttp(400));
  // The untouched original still verifies (nothing above consumed the nonce).
  assert.equal(
    await s.verifySignIn({ wallet: w.address, message: ch.message, signature: signText(ch.message, w.privateKey), expectedDomain: DOMAIN }),
    w.address,
  );
});

test("unknown nonce (never issued) is rejected", async () => {
  const w = wallet();
  const now = new Date();
  const message = s.buildSignInMessage({ domain: DOMAIN, wallet: w.address, nonce: "1111111111111111", issuedAt: now, expiresAt: new Date(now.getTime() + 60_000) });
  await assert.rejects(
    s.verifySignIn({ wallet: w.address, message, signature: signText(message, w.privateKey), expectedDomain: DOMAIN }),
    isHttp(401, /expired or already used/),
  );
});

function reqWith(headers: Record<string, string>, method = "GET", url = "http://copyfomo.test:3001/api/x"): Request {
  return new Request(url, { method, headers });
}

function cookieFrom(setCookie: string): string {
  return setCookie.split(";")[0]!;
}

test("session cookie: issue → read; attributes; forged, expired and cleared cookies read as signed out", () => {
  const w = wallet();
  const setCookie = s.issueSession(w.address);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);
  assert.match(setCookie, /Path=\//);
  assert.equal(s.readSession(reqWith({ cookie: `other=1; ${cookieFrom(setCookie)}` })), w.address);

  // Forged: payload swapped for another wallet, old MAC kept.
  const [name, token] = cookieFrom(setCookie).split("=") as [string, string];
  const other = wallet().address;
  const forgedPayload = Buffer.from(JSON.stringify({ v: 1, w: other, exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url");
  const forged = `${forgedPayload}.${token.split(".")[1]}`;
  assert.equal(s.readSession(reqWith({ cookie: `${name}=${forged}` })), null);
  assert.equal(s.readSession(reqWith({ cookie: `${name}=garbage` })), null);

  // Expired.
  const old = s.encodeSessionToken(w.address, Date.now() - s.SESSION_TTL_MS - 1000);
  assert.equal(s.readSession(reqWith({ cookie: `${name}=${old}` })), null);

  // Cleared.
  assert.match(s.clearSession(), /Max-Age=0/);
  assert.equal(s.readSession(reqWith({})), null);
  assert.throws(() => s.requireSession(reqWith({})), isHttp(401));
  assert.equal(s.requireSession(reqWith({ cookie: cookieFrom(setCookie) })), w.address);
});

test("assertSameOrigin: blocks cross-site state changes, allows same-origin and non-browser clients", () => {
  const host = "copyfomo.test:3001";
  const post = (h: Record<string, string>) => reqWith({ host, ...h }, "POST");
  assert.doesNotThrow(() => s.assertSameOrigin(post({ origin: `http://${host}`, "sec-fetch-site": "same-origin" })));
  assert.doesNotThrow(() => s.assertSameOrigin(post({ referer: `http://${host}/create` })));
  assert.doesNotThrow(() => s.assertSameOrigin(post({})), "curl / server-to-server");
  assert.doesNotThrow(() => s.assertSameOrigin(reqWith({ host, origin: "https://evil.example" }, "GET")), "GET is never blocked");
  assert.throws(() => s.assertSameOrigin(post({ origin: "https://evil.example" })), isHttp(403));
  assert.throws(() => s.assertSameOrigin(post({ origin: "null" })), isHttp(403));
  assert.throws(() => s.assertSameOrigin(post({ "sec-fetch-site": "cross-site" })), isHttp(403));
  assert.throws(() => s.assertSameOrigin(post({ "sec-fetch-site": "same-site", origin: `http://${host}` })), isHttp(403));
  assert.throws(() => s.assertSameOrigin(post({ referer: "https://evil.example/page" })), isHttp(403));
  // requireSession runs it for unsafe methods.
  const w = wallet();
  const cookie = cookieFrom(s.issueSession(w.address));
  assert.throws(() => s.requireSession(post({ cookie, origin: "https://evil.example" })), isHttp(403));
});

test("requireOwner: session wallet owns wallet agents; legacy agents keep the owner key; cross-site blocked", async () => {
  const { hashOwnerKey, newOwnerKey } = await import("./crypto");
  const owner = wallet();
  const stranger = wallet();
  const base = {
    payoutAddress: owner.address,
    sealedSecret: "v1.x",
    mode: "paper",
    status: "active",
  };
  const agent = await prisma.agent.create({
    data: { ...base, name: "a.copy", slug: "a-copy-0001", ownerKeyHash: "", ownerWallet: owner.address, depositAddress: wallet().address },
  });
  const legacyKey = newOwnerKey();
  const legacy = await prisma.agent.create({
    data: { ...base, name: "b.copy", slug: "b-copy-0001", ownerKeyHash: hashOwnerKey(legacyKey), ownerWallet: null, depositAddress: wallet().address },
  });

  const host = "copyfomo.test:3001";
  const as = (w: string | null, method = "GET", extra: Record<string, string> = {}) =>
    reqWith({ host, ...(w ? { cookie: cookieFrom(s.issueSession(w)) } : {}), ...extra }, method);

  assert.equal((await auth.requireOwner(as(owner.address), agent.slug)).id, agent.id);
  await assert.rejects(auth.requireOwner(as(null), agent.id), isHttp(401));
  await assert.rejects(auth.requireOwner(as(stranger.address), agent.id), isHttp(403));
  await assert.rejects(auth.requireOwner(as(owner.address, "POST", { origin: "https://evil.example" }), agent.id), isHttp(403));
  // An owner key never unlocks a wallet-owned agent.
  await assert.rejects(auth.requireOwner(as(null, "GET", { "x-owner-key": legacyKey }), agent.id), isHttp(401));
  await assert.rejects(auth.requireOwner(as(owner.address), "nope"), isHttp(404));

  // Legacy path.
  assert.equal((await auth.requireOwner(as(null, "GET", { "x-owner-key": legacyKey }), legacy.id)).id, legacy.id);
  await assert.rejects(auth.requireOwner(as(owner.address), legacy.id), isHttp(401));
  await assert.rejects(auth.requireOwner(as(null, "GET", { "x-owner-key": newOwnerKey() }), legacy.id), isHttp(401));

  assert.equal(auth.isOwnerOf(as(owner.address), agent), true);
  assert.equal(auth.isOwnerOf(as(stranger.address), agent), false);
  assert.equal(auth.isOwnerOf(null, agent), false);
  assert.equal(auth.isOwnerOf(as(null, "GET", { "x-owner-key": legacyKey }), legacy), true);
});
