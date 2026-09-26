// In-memory token buckets, per process. Good enough for a single web instance; use a shared store
// (Redis / DB) if the web tier is ever scaled horizontally.

import { isIP } from "node:net";
import { config, type TrustedIpSource } from "./config";
import { HttpError } from "./http";

interface Bucket {
  tokens: number;
  updatedAt: number;
  /** Refill rate in tokens/ms. */
  rate: number;
  max: number;
}

const MAX_BUCKETS = 10_000;
const globalForRl = globalThis as unknown as { __copyfomoBuckets?: Map<string, Bucket> };
const buckets = (globalForRl.__copyfomoBuckets ??= new Map<string, Bucket>());

function refill(b: Bucket, now: number): void {
  b.tokens = Math.min(b.max, b.tokens + (now - b.updatedAt) * b.rate);
  b.updatedAt = now;
}

function prune(now: number): void {
  for (const [key, b] of buckets) {
    refill(b, now);
    if (b.tokens >= b.max) buckets.delete(key);
  }
  // Still too many (e.g. under a spray of distinct IPs): drop the oldest entries.
  if (buckets.size > MAX_BUCKETS) {
    const excess = buckets.size - MAX_BUCKETS;
    let i = 0;
    for (const key of buckets.keys()) {
      if (i++ >= excess) break;
      buckets.delete(key);
    }
  }
}

/**
 * Allow at most `max` calls per `windowMs` for `key` (burst up to `max`, refilling continuously).
 * Throws HttpError(429) with a Retry-After header when exhausted.
 */
export function rateLimit(key: string, max: number, windowMs: number): void {
  if (max <= 0 || windowMs <= 0) throw new Error("rateLimit: max and windowMs must be positive");
  const now = Date.now();
  let b = buckets.get(key);
  if (!b) {
    if (buckets.size >= MAX_BUCKETS) prune(now);
    b = { tokens: max, updatedAt: now, rate: max / windowMs, max };
    buckets.set(key, b);
  } else {
    refill(b, now);
    b.max = max;
    b.rate = max / windowMs;
    b.tokens = Math.min(b.tokens, max);
  }

  if (b.tokens < 1) {
    const retryAfterSec = Math.max(1, Math.ceil((1 - b.tokens) / b.rate / 1000));
    throw new HttpError(429, "too many requests, slow down", undefined, { "retry-after": String(retryAfterSec) });
  }
  b.tokens -= 1;
}

/** Shared key when no trustworthy client IP exists: every such client shares one bucket (fails closed). */
export const UNKNOWN_CLIENT = "unknown";

/**
 * Normalize an IP for use as a rate-limit key: strips a port / brackets / IPv4-mapped prefix and aggregates
 * IPv6 to its /64 (one subscriber typically owns a whole /64, so per-address keys would be free to rotate).
 * Anything that isn't an IP becomes UNKNOWN_CLIENT.
 */
export function normalizeIp(raw: string | null | undefined): string {
  let s = (raw ?? "").trim();
  if (!s) return UNKNOWN_CLIENT;
  if (s.startsWith("[")) s = s.slice(1, s.indexOf("]") > 0 ? s.indexOf("]") : undefined);
  else if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(s)) s = s.slice(0, s.lastIndexOf(":"));
  if (/^::ffff:\d{1,3}(\.\d{1,3}){3}$/i.test(s)) s = s.slice(7);
  const kind = isIP(s);
  if (kind === 4) return s;
  if (kind !== 6) return UNKNOWN_CLIENT;
  return `${ipv6Prefix64(s)}::/64`;
}

/** First four hextets of an IPv6 address (expanding "::"), lower-case, no leading zeros. */
function ipv6Prefix64(addr: string): string {
  const [head, tail] = addr.toLowerCase().split("::") as [string, string | undefined];
  const h = head ? head.split(":") : [];
  const t = tail !== undefined && tail !== "" ? tail.split(":") : [];
  // An embedded IPv4 tail counts as two hextets.
  const width = (parts: string[]) => parts.reduce((n, p) => n + (p.includes(".") ? 2 : 1), 0);
  const fill = tail !== undefined ? Array<string>(Math.max(0, 8 - width(h) - width(t))).fill("0") : [];
  const all = [...h, ...fill, ...t];
  return all
    .slice(0, 4)
    .map((x) => (x.includes(".") ? "0" : x.replace(/^0+(?=.)/, "") || "0"))
    .join(":");
}

/**
 * Client IP for per-IP rate limits, from the one source config says is trustworthy (TRUSTED_IP_SOURCE,
 * finding F27). Never the leftmost X-Forwarded-For entry: clients control it.
 *  - "xff" (default): the entry TRUSTED_PROXY_HOPS positions from the RIGHT, i.e. what the outermost trusted
 *    proxy appended (nginx $proxy_add_x_forwarded_for, AWS ALB, Cloudflare → origin). With `next start`
 *    and no proxy, Next only fills X-Forwarded-For when the client sent none: run behind a proxy.
 *  - "x-real-ip" | "cf-connecting-ip" | "x-vercel-forwarded-for" | "fly-client-ip": a header your proxy
 *    OVERWRITES (for Cloudflare, also allow only Cloudflare's IP ranges at the origin).
 *  - "none": no per-client identity; everyone shares UNKNOWN_CLIENT's buckets.
 * IPv6 addresses are aggregated to /64.
 */
export function clientIp(
  req: Request,
  opts: { source?: TrustedIpSource; hops?: number } = {},
): string {
  const source = opts.source ?? config.trustedIpSource;
  const hops = Math.max(1, Math.floor(opts.hops ?? config.trustedProxyHops));
  switch (source) {
    case "none":
      return UNKNOWN_CLIENT;
    case "xff": {
      const entries = (req.headers.get("x-forwarded-for") ?? "")
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean);
      return normalizeIp(entries.length >= hops ? entries[entries.length - hops] : undefined);
    }
    case "x-vercel-forwarded-for":
      return normalizeIp(req.headers.get(source)?.split(",")[0]);
    default:
      return normalizeIp(req.headers.get(source));
  }
}
