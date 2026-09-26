// Wallet sign-in (Sign-In With Solana style) and the signed session cookie. Web process only.
//
// Flow: POST /api/auth/nonce {wallet} → createSignInChallenge → the wallet signs `message` (signMessage, UTF-8)
//   → POST /api/auth/verify {wallet, message, signature(base58)} → verifySignIn → issueSession → Set-Cookie.
//
//  - Nonces live in Kv ("siws:<nonce>"), bound to the wallet and domain they were issued for, valid 10 minutes
//    and single use (consumed with an atomic delete, so a replayed signature is rejected).
//  - The server rebuilds the exact message from what it stored and compares byte for byte: a client can't
//    slip in other text, another domain or a later expiry.
//  - Signatures are ed25519 over the UTF-8 message bytes (node:crypto; no extra dependency).
//  - The session is a stateless HMAC-SHA256-signed cookie: HttpOnly, SameSite=Lax, Path=/, Secure (and the
//    "__Host-" name prefix) in production. It carries only the wallet and its expiry.
//  - assertSameOrigin blocks cross-site state-changing requests (Sec-Fetch-Site / Origin / Referer).

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import bs58 from "bs58";
import { config } from "./config";
import { verifyEd25519 } from "./crypto";
import { prisma } from "./db";
import { HttpError } from "./http";

export const NONCE_TTL_MS = 10 * 60_000;
export const SESSION_TTL_MS = 7 * 24 * 3600_000;
/** Clock skew tolerated between the server that issued a challenge and the one verifying it. */
const CLOCK_SKEW_MS = 60_000;
const NONCE_KV_PREFIX = "siws:";
const MAX_MESSAGE_CHARS = 2_000;
const STATEMENT = "Sign in to copyfomo. This only proves you own this wallet: it sends no transaction and costs nothing.";
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

const isProduction = (): boolean => process.env.NODE_ENV === "production";

/** Cookie name: "__Host-" prefix (Secure, Path=/, no Domain enforced by browsers) in production. */
export function sessionCookieName(): string {
  return isProduction() ? "__Host-cf_session" : "cf_session";
}

function isWalletAddress(s: unknown): s is string {
  if (typeof s !== "string" || s.length < 32 || s.length > 44) return false;
  try {
    return bs58.decode(s).length === 32;
  } catch {
    return false;
  }
}

// ── Challenge ───────────────────────────────────────────────────────────────────────────────────────

export interface SignInFields {
  /** The site's host (e.g. "copyfomo.app" or "localhost:3001"), as the browser sees it. */
  domain: string;
  wallet: string;
  nonce: string;
  issuedAt: Date;
  expiresAt: Date;
}

/** The exact text the wallet signs. Line-oriented (SIWS / EIP-4361 layout) so wallets can display and check it. */
export function buildSignInMessage(f: SignInFields): string {
  return [
    `${f.domain} wants you to sign in with your Solana account:`,
    f.wallet,
    "",
    STATEMENT,
    "",
    `URI: ${isProduction() ? "https" : "http"}://${f.domain}`,
    "Version: 1",
    "Chain ID: mainnet",
    `Nonce: ${f.nonce}`,
    `Issued At: ${f.issuedAt.toISOString()}`,
    `Expiration Time: ${f.expiresAt.toISOString()}`,
  ].join("\n");
}

interface StoredNonce {
  wallet: string | null;
  domain: string | null;
  issuedAt: string;
  expiresAt: string;
}

let lastPrune = 0;

/** Delete expired nonces now and then (bounded work; Kv keys are the primary key). */
async function pruneNonces(now: number): Promise<void> {
  if (now - lastPrune < 60_000) return;
  lastPrune = now;
  await prisma.kv
    .deleteMany({ where: { key: { startsWith: NONCE_KV_PREFIX }, updatedAt: { lt: new Date(now - NONCE_TTL_MS - CLOCK_SKEW_MS) } } })
    .catch(() => undefined);
}

/**
 * A fresh single-use nonce (base58, 16 random bytes) stored in Kv for 10 minutes, optionally bound to the wallet
 * and domain it is issued for (verifySignIn then requires both to match).
 */
export async function createNonce(
  bind: { wallet?: string; domain?: string } = {},
  now: Date = new Date(),
): Promise<{ nonce: string; issuedAt: Date; expiresAt: Date }> {
  if (bind.wallet !== undefined && !isWalletAddress(bind.wallet)) {
    throw new HttpError(400, "invalid input", { wallet: "not a Solana address" });
  }
  const nonce = bs58.encode(randomBytes(16));
  const issuedAt = new Date(Math.floor(now.getTime() / 1000) * 1000); // whole seconds: stable ISO text
  const expiresAt = new Date(issuedAt.getTime() + NONCE_TTL_MS);
  const stored: StoredNonce = {
    wallet: bind.wallet ?? null,
    domain: bind.domain ?? null,
    issuedAt: issuedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };
  await prisma.kv.create({ data: { key: `${NONCE_KV_PREFIX}${nonce}`, value: JSON.stringify(stored) } });
  void pruneNonces(now.getTime());
  return { nonce, issuedAt, expiresAt };
}

/** createNonce bound to `wallet` + `domain`, plus the message to sign. Shape of SignInChallengeDTO. */
export async function createSignInChallenge(p: {
  wallet: string;
  domain: string;
  now?: Date;
}): Promise<{ message: string; nonce: string; expiresAt: string }> {
  const { nonce, issuedAt, expiresAt } = await createNonce({ wallet: p.wallet, domain: p.domain }, p.now);
  const message = buildSignInMessage({ domain: p.domain, wallet: p.wallet, nonce, issuedAt, expiresAt });
  return { message, nonce, expiresAt: expiresAt.toISOString() };
}

// ── Verification ────────────────────────────────────────────────────────────────────────────────────

function field(lines: string[], label: string): string | null {
  const prefix = `${label}: `;
  const hits = lines.filter((l) => l.startsWith(prefix));
  return hits.length === 1 ? hits[0]!.slice(prefix.length) : null;
}

const unauthorized = (why: string) => new HttpError(401, why);

/**
 * Verify a signed challenge and consume its nonce. Returns the wallet on success; throws HttpError 400
 * (malformed input) or 401 (wrong domain / wallet, expired or already used nonce, bad signature).
 */
export async function verifySignIn(p: {
  wallet: string;
  message: string;
  /** base58 ed25519 signature (64 bytes). */
  signature: string;
  expectedDomain: string;
  now?: Date;
}): Promise<string> {
  const now = (p.now ?? new Date()).getTime();
  if (!isWalletAddress(p.wallet)) throw new HttpError(400, "invalid input", { wallet: "not a Solana address" });
  if (typeof p.message !== "string" || p.message.length === 0 || p.message.length > MAX_MESSAGE_CHARS) {
    throw new HttpError(400, "invalid input", { message: "missing or too long" });
  }
  let sig: Uint8Array;
  try {
    sig = bs58.decode(p.signature);
  } catch {
    throw new HttpError(400, "invalid input", { signature: "not base58" });
  }
  if (sig.length !== 64) throw new HttpError(400, "invalid input", { signature: "must be a 64-byte ed25519 signature" });

  const lines = p.message.split("\n");
  if (lines[0] !== `${p.expectedDomain} wants you to sign in with your Solana account:`) {
    throw unauthorized("this sign-in message was made for another site");
  }
  if (lines[1] !== p.wallet) throw unauthorized("this sign-in message is for another wallet");
  const nonce = field(lines, "Nonce");
  if (!nonce || !/^[1-9A-HJ-NP-Za-km-z]{10,40}$/.test(nonce)) throw unauthorized("sign-in message has no valid nonce");

  const key = `${NONCE_KV_PREFIX}${nonce}`;
  const row = await prisma.kv.findUnique({ where: { key } });
  if (!row) throw unauthorized("sign-in request expired or already used — try again");
  let stored: StoredNonce;
  try {
    stored = JSON.parse(row.value) as StoredNonce;
  } catch {
    throw unauthorized("sign-in request expired or already used — try again");
  }
  const issuedAt = new Date(stored.issuedAt);
  const expiresAt = new Date(stored.expiresAt);
  if (!(expiresAt.getTime() > now)) throw unauthorized("sign-in request expired — try again");
  if (issuedAt.getTime() > now + CLOCK_SKEW_MS) throw unauthorized("sign-in request is not valid yet");
  if (stored.wallet !== null && stored.wallet !== p.wallet) throw unauthorized("this sign-in request was issued for another wallet");
  if (stored.domain !== null && stored.domain !== p.expectedDomain) throw unauthorized("this sign-in message was made for another site");

  const expected = buildSignInMessage({ domain: p.expectedDomain, wallet: p.wallet, nonce, issuedAt, expiresAt });
  if (p.message !== expected) throw unauthorized("sign-in message does not match the request");
  if (!verifyEd25519(Buffer.from(p.message, "utf8"), sig, bs58.decode(p.wallet))) {
    throw unauthorized("signature does not match this wallet");
  }

  // Single use: exactly one verifier can delete the row.
  const consumed = await prisma.kv.deleteMany({ where: { key } });
  if (consumed.count !== 1) throw unauthorized("sign-in request already used — try again");
  return p.wallet;
}

/** The site host the browser used (Host header), for building and checking the sign-in message domain. */
export function requestDomain(req: Request): string {
  const host = req.headers.get("host")?.trim();
  if (host && /^[A-Za-z0-9.-]+(:\d{1,5})?$|^\[[0-9A-Fa-f:.]+\](:\d{1,5})?$/.test(host)) return host.toLowerCase();
  try {
    return new URL(req.url).host.toLowerCase();
  } catch {
    throw new HttpError(400, "missing host");
  }
}

// ── Session cookie ──────────────────────────────────────────────────────────────────────────────────

let ephemeralKey: Buffer | null = null;
let warnedEphemeral = false;

function sessionKey(): Buffer {
  const secret = config.sessionSecret;
  if (secret) {
    // Node's base64 decoder accepts both the standard and the URL-safe alphabet.
    const raw = Buffer.from(secret, "base64");
    if (raw.length < 32) throw new HttpError(500, "server not configured: SESSION_SECRET must be at least 32 random bytes");
    return createHmac("sha256", raw).update("copyfomo-session-v1").digest();
  }
  if (isProduction()) throw new HttpError(500, "server not configured: SESSION_SECRET missing");
  if (!warnedEphemeral) {
    warnedEphemeral = true;
    console.warn("[session] SESSION_SECRET is not set: using a per-process key (sessions end on restart). Run npm run keys:gen.");
  }
  return (ephemeralKey ??= randomBytes(32));
}

interface SessionPayload {
  v: 1;
  w: string;
  /** Expiry, unix seconds. */
  exp: number;
}

function sign(payloadB64: string): string {
  return createHmac("sha256", sessionKey()).update(payloadB64).digest("base64url");
}

/** Cookie value for `wallet`: base64url(JSON payload) + "." + base64url(HMAC). */
export function encodeSessionToken(wallet: string, now: number = Date.now()): string {
  const payload: SessionPayload = { v: 1, w: wallet, exp: Math.floor((now + SESSION_TTL_MS) / 1000) };
  const b64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${b64}.${sign(b64)}`;
}

/** The wallet a token was issued for, or null when it is malformed, forged or expired. */
export function decodeSessionToken(token: string, now: number = Date.now()): string | null {
  if (typeof token !== "string" || token.length > 512) return null;
  const dot = token.indexOf(".");
  if (dot <= 0 || dot !== token.lastIndexOf(".")) return null;
  const b64 = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  let expected: Buffer;
  let given: Buffer;
  try {
    expected = Buffer.from(sign(b64), "base64url");
    given = Buffer.from(mac, "base64url");
  } catch {
    return null;
  }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let payload: SessionPayload;
  try {
    payload = JSON.parse(Buffer.from(b64, "base64url").toString("utf8")) as SessionPayload;
  } catch {
    return null;
  }
  if (payload?.v !== 1 || !isWalletAddress(payload.w) || typeof payload.exp !== "number") return null;
  if (payload.exp * 1000 <= now) return null;
  return payload.w;
}

function cookieAttrs(maxAgeSec: number): string {
  return `Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${isProduction() ? "; Secure" : ""}`;
}

/** Set-Cookie header value that signs `wallet` in for SESSION_TTL_MS. */
export function issueSession(wallet: string): string {
  if (!isWalletAddress(wallet)) throw new HttpError(400, "invalid wallet");
  return `${sessionCookieName()}=${encodeSessionToken(wallet)}; ${cookieAttrs(Math.floor(SESSION_TTL_MS / 1000))}`;
}

/** Set-Cookie header value that signs the browser out. */
export function clearSession(): string {
  return `${sessionCookieName()}=; ${cookieAttrs(0)}`;
}

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/** The signed-in wallet, or null (no cookie, forged, expired, or SESSION_SECRET problems). Never throws. */
export function readSession(req: Request): string | null {
  const token = readCookie(req, sessionCookieName());
  if (!token) return null;
  try {
    return decodeSessionToken(token);
  } catch {
    return null;
  }
}

/**
 * The signed-in wallet, else HttpError(401). For state-changing methods it also runs assertSameOrigin, so a
 * route that forgets the explicit call is still protected.
 */
export function requireSession(req: Request): string {
  if (!SAFE_METHODS.has(req.method.toUpperCase())) assertSameOrigin(req);
  const wallet = readSession(req);
  if (!wallet) throw new HttpError(401, "sign in with your wallet first");
  return wallet;
}

// ── CSRF / same-origin ──────────────────────────────────────────────────────────────────────────────

function hostOf(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Hosts this server answers as: Host / X-Forwarded-Host, the request URL, NEXT_PUBLIC_SITE_URL. (A cross-site
 * page cannot make a victim's browser send a custom X-Forwarded-Host without a CORS preflight we never allow.)
 */
function allowedHosts(req: Request): Set<string> {
  const hosts = new Set<string>();
  const host = req.headers.get("host")?.trim().toLowerCase();
  if (host) hosts.add(host);
  const fwd = req.headers.get("x-forwarded-host")?.split(",")[0]?.trim().toLowerCase();
  if (fwd) hosts.add(fwd);
  const fromUrl = hostOf(req.url);
  if (fromUrl) hosts.add(fromUrl);
  const site = hostOf(config.siteUrl);
  if (site && process.env.NEXT_PUBLIC_SITE_URL) hosts.add(site);
  return hosts;
}

/**
 * 403 unless a state-changing request comes from our own pages. Browsers always label cross-site requests:
 *  - Sec-Fetch-Site must be "same-origin" or "none" when present;
 *  - Origin (else Referer) must name one of our hosts when present; "null" origins are rejected.
 * Requests with none of these headers are not from a browser page (curl, server-to-server) and pass: CSRF needs
 * a victim's browser. GET/HEAD/OPTIONS always pass.
 */
export function assertSameOrigin(req: Request): void {
  if (SAFE_METHODS.has(req.method.toUpperCase())) return;
  const blocked = () => new HttpError(403, "cross-site request blocked");

  const site = req.headers.get("sec-fetch-site")?.trim().toLowerCase();
  if (site && site !== "same-origin" && site !== "none") throw blocked();

  const hosts = allowedHosts(req);
  const origin = req.headers.get("origin")?.trim();
  if (origin) {
    if (origin === "null") throw blocked();
    const h = hostOf(origin);
    if (!h || !hosts.has(h)) throw blocked();
    return;
  }
  const referer = req.headers.get("referer")?.trim();
  if (referer) {
    const h = hostOf(referer);
    if (!h || !hosts.has(h)) throw blocked();
  }
}
