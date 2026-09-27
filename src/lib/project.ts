// The project's own public links, set by the operator: its X (Twitter) account and its token (ticker, contract
// address, where to buy it, its chart). Pure parsing, no I/O and no config import: config.ts validates the
// environment with it at startup, and the result reaches browsers through AppConfigDTO.project. Everything here
// is public by design; never add a secret to it.

import bs58 from "bs58";
import type { ProjectDTO } from "./types";

export const DEFAULT_TOKEN_SYMBOL = "COPYFOMO";

export const NO_PROJECT: ProjectDTO = Object.freeze({ xUrl: null, xHandle: null, token: null });

/** The settings this module reads (all optional). */
export type ProjectEnvName = "PROJECT_X_URL" | "TOKEN_SYMBOL" | "TOKEN_NAME" | "TOKEN_CA" | "TOKEN_BUY_URL" | "TOKEN_CHART_URL";
/** process.env, or a plain object in tests. */
export type ProjectEnv = Readonly<Record<string, string | undefined>>;

const X_HANDLE = /^@?([A-Za-z0-9_]{1,15})$/;
/** An X / Twitter profile URL: optional scheme, www. or mobile., a trailing slash or a share query (?s=21). */
const X_PROFILE_URL = /^(?:https?:\/\/)?(?:www\.|mobile\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/?(?:[?#].*)?$/i;
/** x.com paths that are pages, not accounts. */
const X_RESERVED = new Set([
  "compose",
  "explore",
  "hashtag",
  "home",
  "i",
  "intent",
  "login",
  "logout",
  "messages",
  "notifications",
  "privacy",
  "search",
  "settings",
  "share",
  "signup",
  "tos",
]);

/**
 * "https://x.com/<h>", "https://twitter.com/<h>", "@h" or "h" → { url: "https://x.com/<h>", handle: "<h>" }.
 * Anything else (another site, a post URL, a bad handle) → null.
 */
export function parseXAccount(raw: string): { url: string; handle: string } | null {
  const v = raw.trim();
  const m = X_PROFILE_URL.exec(v) ?? X_HANDLE.exec(v);
  const handle = m?.[1];
  if (!handle || X_RESERVED.has(handle.toLowerCase())) return null;
  return { url: `https://x.com/${handle}`, handle };
}

const SYMBOL = /^[A-Za-z0-9]{1,12}$/;

/** "$COPYFOMO" or "COPYFOMO" → "COPYFOMO"; 1–12 letters or digits, else null. Case is kept. */
export function parseTokenSymbol(raw: string): string | null {
  const v = raw.trim().replace(/^\$/, "");
  return SYMBOL.test(v) ? v : null;
}

const TOKEN_NAME = /^[A-Za-z0-9][A-Za-z0-9 .-]{0,31}$/;

/** "CopyFomo": 1–32 letters, digits, spaces, dots or dashes, starting with a letter or digit; else null. */
export function parseTokenName(raw: string): string | null {
  const v = raw.trim().replace(/s+/g, " ");
  return TOKEN_NAME.test(v) ? v : null;
}

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** A Solana mint address: 32–44 base58 characters that decode to exactly 32 bytes (catches typos). */
export function isTokenAddress(s: string): boolean {
  if (!BASE58.test(s)) return false;
  try {
    return bs58.decode(s).length === 32;
  } catch {
    return false;
  }
}

/** pump.fun mints are ground to end in "pump". */
export function isPumpMint(ca: string): boolean {
  return ca.endsWith("pump");
}

export function defaultBuyUrl(ca: string): string {
  return isPumpMint(ca) ? `https://pump.fun/coin/${ca}` : `https://jup.ag/swap/SOL-${ca}`;
}

export function defaultChartUrl(ca: string): string {
  return `https://dexscreener.com/solana/${ca}`;
}

/** An absolute https URL with a dotted host and no credentials, normalized; anything else → null. */
export function parseHttpsUrl(raw: string): string | null {
  const v = raw.trim();
  if (!v || v.length > 512) return null;
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username || u.password || !u.hostname.includes(".")) return null;
  return u.href;
}

/**
 * The project links from the environment. Throws on the first malformed value, naming the variable; unset or
 * blank values are simply absent. TOKEN_BUY_URL / TOKEN_CHART_URL only apply once TOKEN_CA is set.
 */
export function projectFromEnv(env: ProjectEnv): ProjectDTO {
  const get = (name: ProjectEnvName) => (env[name] ?? "").trim();

  const xRaw = get("PROJECT_X_URL");
  const x = xRaw ? parseXAccount(xRaw) : null;
  if (xRaw && !x) {
    throw new Error(`PROJECT_X_URL must be https://x.com/<handle>, https://twitter.com/<handle> or @handle, got "${xRaw}"`);
  }

  const symbolRaw = get("TOKEN_SYMBOL");
  const symbol = symbolRaw ? parseTokenSymbol(symbolRaw) : DEFAULT_TOKEN_SYMBOL;
  if (!symbol) throw new Error(`TOKEN_SYMBOL must be 1–12 letters or digits (e.g. COPYFOMO), got "${symbolRaw}"`);

  const nameRaw = get("TOKEN_NAME");
  const name = nameRaw ? parseTokenName(nameRaw) : null;
  if (nameRaw && !name) throw new Error(`TOKEN_NAME must be 1–32 letters, digits, spaces, dots or dashes (e.g. CopyFomo), got "${nameRaw}"`);

  const ca = get("TOKEN_CA");
  if (ca && !isTokenAddress(ca)) throw new Error(`TOKEN_CA must be a base58 Solana token address, got "${ca}"`);

  const url = (name: "TOKEN_BUY_URL" | "TOKEN_CHART_URL"): string | null => {
    const raw = get(name);
    if (!raw) return null;
    const parsed = parseHttpsUrl(raw);
    if (!parsed) throw new Error(`${name} must be an https:// URL, got "${raw}"`);
    return parsed;
  };
  const buyUrl = url("TOKEN_BUY_URL");
  const chartUrl = url("TOKEN_CHART_URL");

  // Anything set announces the token: before TOKEN_CA it reads "$SYMBOL · launching soon".
  const announced = Boolean(x || ca || symbolRaw || name);
  return {
    xUrl: x?.url ?? null,
    xHandle: x?.handle ?? null,
    token: announced
      ? {
          symbol,
          name,
          ca: ca || null,
          venue: ca ? (isPumpMint(ca) ? "pump.fun" : "Solana") : null,
          buyUrl: ca ? (buyUrl ?? defaultBuyUrl(ca)) : null,
          chartUrl: ca ? (chartUrl ?? defaultChartUrl(ca)) : null,
        }
      : null,
  };
}
