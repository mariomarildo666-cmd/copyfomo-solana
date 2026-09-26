// Jupiter Price API v3: GET /price/v3?ids=a,b (≤ 50 ids) → { [mint]: { usdPrice, … } }.
// Mints Jupiter cannot price are simply absent from the response.

import { z } from "zod";
import { JUP_PRIORITY, jupiterRequest } from "./jupiter";
import { SOL_MINT } from "./solana";

const TTL_MS = 20_000;
/** On upstream failure, a price this old is still better than none. */
const STALE_MAX_MS = 120_000;
const MAX_IDS_PER_CALL = 50;
/** After an upstream failure, serve stale/unknown for a moment instead of hammering Jupiter. */
const FAILURE_BACKOFF_MS = 5_000;

interface CacheEntry {
  /** null = Jupiter had no price for this mint (negative cache). */
  price: number | null;
  at: number;
}

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<number | null>>();
let backoffUntil = 0;

// Validated per entry so one odd token doesn't discard the whole batch.
const priceResponseSchema = z.record(z.string(), z.unknown());
const priceEntrySchema = z.object({ usdPrice: z.number().finite().positive() }).passthrough();

async function fetchChunk(mints: string[]): Promise<Record<string, number>> {
  const { data } = await jupiterRequest(`/price/v3?ids=${mints.map(encodeURIComponent).join(",")}`, priceResponseSchema, {
    label: "jupiter price",
    // SOL/USD is on the copy path (USDC-priced trades, sizing); other prices are dashboard valuation.
    priority: mints.includes(SOL_MINT) ? JUP_PRIORITY.entry : JUP_PRIORITY.background,
  });
  const out: Record<string, number> = {};
  for (const [mint, entry] of Object.entries(data)) {
    const parsed = priceEntrySchema.safeParse(entry);
    if (parsed.success) out[mint] = parsed.data.usdPrice;
  }
  return out;
}

function staleFallback(mint: string, now: number): number | null {
  const hit = cache.get(mint);
  return hit && hit.price !== null && now - hit.at <= STALE_MAX_MS ? hit.price : null;
}

/**
 * USD prices for `mints`. Missing entries mean "no price available" (unknown token or upstream
 * failure) — callers must treat them as unknown, never as zero.
 */
export async function getUsdPrices(mints: string[]): Promise<Record<string, number>> {
  const now = Date.now();
  const unique = [...new Set(mints.filter((m) => typeof m === "string" && m.length > 0))];
  const pending: Array<[string, Promise<number | null>]> = [];
  const toFetch: string[] = [];

  for (const mint of unique) {
    const hit = cache.get(mint);
    if (hit && now - hit.at < TTL_MS) continue;
    const running = inflight.get(mint);
    if (running) pending.push([mint, running]);
    else if (now < backoffUntil) pending.push([mint, Promise.resolve(staleFallback(mint, now))]);
    else toFetch.push(mint);
  }

  for (let i = 0; i < toFetch.length; i += MAX_IDS_PER_CALL) {
    const chunk = toFetch.slice(i, i + MAX_IDS_PER_CALL);
    const request = fetchChunk(chunk).then(
      (prices) => {
        const at = Date.now();
        for (const mint of chunk) cache.set(mint, { price: prices[mint] ?? null, at });
        return prices;
      },
      (err: unknown) => {
        backoffUntil = Date.now() + FAILURE_BACKOFF_MS;
        console.warn(`[prices] ${err instanceof Error ? err.message : String(err)}`);
        return null;
      },
    );
    for (const mint of chunk) {
      const p = request
        .then((prices) => (prices ? (prices[mint] ?? null) : staleFallback(mint, Date.now())))
        .finally(() => inflight.delete(mint));
      inflight.set(mint, p);
      pending.push([mint, p]);
    }
  }

  const resolved = new Map(await Promise.all(pending.map(async ([mint, p]) => [mint, await p] as const)));
  const out: Record<string, number> = {};
  for (const mint of unique) {
    const price = resolved.has(mint) ? resolved.get(mint) : cache.get(mint)?.price;
    if (typeof price === "number") out[mint] = price;
  }
  return out;
}

/**
 * getUsdPrices plus why each missing mint is missing:
 *  - `unpriced`: Jupiter answered and has no price for it (dead / rugged / not indexed yet);
 *  - `unavailable`: we couldn't ask (upstream failure, rate limit) and hold no fresh-enough price.
 * Valuation treats the two differently (finding F19): an outage must not zero out positions.
 */
export async function getUsdPriceStatus(
  mints: string[],
): Promise<{ prices: Record<string, number>; unpriced: Set<string>; unavailable: Set<string> }> {
  const prices = await getUsdPrices(mints);
  const now = Date.now();
  const unpriced = new Set<string>();
  const unavailable = new Set<string>();
  for (const mint of new Set(mints)) {
    if (prices[mint] !== undefined) continue;
    const hit = cache.get(mint);
    if (hit && hit.price === null && now - hit.at <= TTL_MS * 2) unpriced.add(mint);
    else unavailable.add(mint);
  }
  return { prices, unpriced, unavailable };
}

/** SOL/USD. Throws when no reasonably fresh price is available (callers skip rather than guess). */
export async function getSolUsd(): Promise<number> {
  const prices = await getUsdPrices([SOL_MINT]);
  const price = prices[SOL_MINT];
  if (price === undefined) throw new Error("SOL/USD price unavailable");
  return price;
}
