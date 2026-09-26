// Token metadata via Jupiter Tokens API v2: GET /tokens/v2/search?query=<mint> → [{ id, symbol, name, icon, decimals, … }].
// Found tokens are cached in Kv "token:<mint>" forever (metadata is effectively immutable).

import { z } from "zod";
import { kvGet, kvSet } from "./db";
import { jupiterRequest } from "./jupiter";
import { isValidSolanaAddress, SOL_MINT, USDC_MINT, USDT_MINT } from "./solana";

export interface TokenMeta {
  symbol: string | null;
  name: string | null;
  icon: string | null;
  decimals: number | null;
}

const EMPTY: TokenMeta = Object.freeze({ symbol: null, name: null, icon: null, decimals: null });

const KNOWN: Record<string, TokenMeta> = {
  [SOL_MINT]: { symbol: "SOL", name: "Wrapped SOL", icon: null, decimals: 9 },
  [USDC_MINT]: { symbol: "USDC", name: "USD Coin", icon: null, decimals: 6 },
  [USDT_MINT]: { symbol: "USDT", name: "USDT", icon: null, decimals: 6 },
};

/** Tokens Jupiter doesn't know yet may get indexed later: only remember a miss for a while. */
const MISS_TTL_MS = 10 * 60_000;

const memory = new Map<string, TokenMeta>();
const misses = new Map<string, number>();
const inflight = new Map<string, Promise<TokenMeta>>();

const searchItemSchema = z
  .object({
    id: z.string(),
    symbol: z.string().nullish(),
    name: z.string().nullish(),
    icon: z.string().nullish(),
    decimals: z.number().int().min(0).max(255).nullish(),
  })
  .passthrough();

const searchSchema = z.array(z.unknown());

const storedSchema = z.object({
  symbol: z.string().nullable(),
  name: z.string().nullable(),
  icon: z.string().nullable(),
  decimals: z.number().int().nullable(),
});

function cleanText(s: string | null | undefined, max: number): string | null {
  if (!s) return null;
  const t = s.trim().slice(0, max);
  return t.length ? t : null;
}

function cleanIcon(s: string | null | undefined): string | null {
  return s && /^https:\/\//i.test(s.trim()) ? s.trim() : null;
}

async function fetchMeta(mint: string): Promise<TokenMeta> {
  const stored = await kvGet<unknown>(`token:${mint}`);
  if (stored) {
    const parsed = storedSchema.safeParse(stored.value);
    if (parsed.success) return parsed.data;
  }

  const { data } = await jupiterRequest(`/tokens/v2/search?query=${encodeURIComponent(mint)}`, searchSchema, {
    label: "jupiter tokens",
  });
  for (const row of data) {
    const item = searchItemSchema.safeParse(row);
    if (!item.success || item.data.id !== mint) continue;
    const meta: TokenMeta = {
      symbol: cleanText(item.data.symbol, 32),
      name: cleanText(item.data.name, 64),
      icon: cleanIcon(item.data.icon),
      decimals: item.data.decimals ?? null,
    };
    await kvSet(`token:${mint}`, meta);
    return meta;
  }
  misses.set(mint, Date.now());
  return EMPTY;
}

/** Symbol/name/icon/decimals for a mint; all-null when unknown or when Jupiter is unreachable. */
export async function getTokenMeta(mint: string): Promise<TokenMeta> {
  const known = KNOWN[mint];
  if (known) return known;
  if (!isValidSolanaAddress(mint)) return EMPTY;

  const hit = memory.get(mint);
  if (hit) return hit;
  const missedAt = misses.get(mint);
  if (missedAt !== undefined && Date.now() - missedAt < MISS_TTL_MS) return EMPTY;

  let p = inflight.get(mint);
  if (!p) {
    p = fetchMeta(mint)
      .then((meta) => {
        if (meta !== EMPTY) memory.set(mint, meta);
        return meta;
      })
      .catch((err: unknown) => {
        console.warn(`[tokens] ${mint}: ${err instanceof Error ? err.message : String(err)}`);
        return EMPTY;
      })
      .finally(() => inflight.delete(mint));
    inflight.set(mint, p);
  }
  return p;
}
