// SOL/USD by hour for SOL-denominated PnL (design §4.3): SolUsdHour rows.
//  - recorder: Jupiter getSolUsd() every 60 s (0 Helius credits), last write per hour wins.
//  - startup: Binance klines calls fill the missing hourly history (public, no key) back to the oldest stored
//    FomoSwap (retention keeps open lots indefinitely), never before FOMO_MARKER_SINCE. It may be geo-blocked
//    (HTTP 451 in the US): then pnlSol stays null for older trades until the recorder has data. Never fatal.

import { z } from "zod";
import { config } from "@/lib/config";
import { prisma } from "@/lib/db";
import { FOMO_MARKER_SINCE } from "@/lib/fomo-chain";
import { getSolUsd } from "@/lib/prices";
import { logger } from "../log";
import { DAY_MS, firstUnpricedHour, HOUR_MS, hourStartMs, MINUTE_MS } from "./policy";
import { safeErr } from "./state";

const log = logger("fomo-solprice");

const BINANCE_KLINES = "https://api.binance.com/api/v3/klines";
/** Backfill window at least (37-day backfill + the retention margin), longer when older swaps are stored. */
const HISTORY_DAYS = 45;
const KLINES_LIMIT = 1_000;
/** ≤ 12 × 1,000 hours (~500 days) per startup. */
const KLINES_MAX_PAGES = 12;
const MIN_SANE_PRICE = 1;
const MAX_SANE_PRICE = 100_000;

let latest: { price: number; at: number } | null = null;

/** Latest recorded SOL/USD when fresher than `maxAgeMs`, else null (callers then leave solUsd null). */
export function currentSolUsd(maxAgeMs = 5 * MINUTE_MS): number | null {
  return latest && Date.now() - latest.at <= maxAgeMs ? latest.price : null;
}

/** One recorder tick: Jupiter SOL/USD → SolUsdHour for the current UTC hour. */
export async function recordSolPrice(): Promise<void> {
  const price = await getSolUsd();
  if (!(price >= MIN_SANE_PRICE && price <= MAX_SANE_PRICE)) throw new Error(`implausible SOL/USD ${price}`);
  const now = Date.now();
  latest = { price, at: now };
  const hour = new Date(hourStartMs(now));
  await prisma.solUsdHour.upsert({ where: { hour }, create: { hour, price, source: "jupiter" }, update: { price, source: "jupiter" } });
}

/** Binance klines rows [openTime, open, high, low, close, …] → {hourMs, price = open} (price at the hour start). */
export function parseBinanceKlines(raw: unknown): { hourMs: number; price: number }[] {
  const rows = z.array(z.array(z.unknown())).safeParse(raw);
  if (!rows.success) return [];
  const out: { hourMs: number; price: number }[] = [];
  for (const r of rows.data) {
    const openTime = r[0];
    const open = typeof r[1] === "string" ? Number(r[1]) : r[1];
    if (typeof openTime !== "number" || !Number.isFinite(openTime) || typeof open !== "number" || !Number.isFinite(open)) continue;
    if (open < MIN_SANE_PRICE || open > MAX_SANE_PRICE) continue;
    out.push({ hourMs: hourStartMs(openTime), price: open });
  }
  return out;
}

/** Fill missing SolUsdHour hours from Binance (SOLUSDC 1h), back to the oldest stored swap. Never throws. */
export async function backfillSolPrices(): Promise<void> {
  if (config.solPriceBackfill !== "binance") return;
  const now = Date.now();
  const to = hourStartMs(now) - HOUR_MS;
  try {
    const oldest = await prisma.fomoSwap.aggregate({ _min: { blockTime: true } }).catch(() => null);
    const oldestMs = oldest?._min.blockTime?.getTime() ?? null;
    const from = hourStartMs(Math.max(FOMO_MARKER_SINCE, Math.min(now - HISTORY_DAYS * DAY_MS, oldestMs !== null ? oldestMs - HOUR_MS : Infinity)));
    if (to <= from) return;
    const existing = await prisma.solUsdHour.findMany({ where: { hour: { gte: new Date(from - DAY_MS), lte: new Date(to) } }, select: { hour: true } });
    const have = new Set(existing.map((r) => r.hour.getTime()));
    // Small holes (worker downtime) are fine: SOL PnL uses the nearest stored hour within ±6 h.
    const firstHole = firstUnpricedHour(have, from, to);
    if (firstHole === null) return;

    let start = firstHole;
    let inserted = 0;
    for (let page = 0; page < KLINES_MAX_PAGES && start <= to; page++) {
      const url = `${BINANCE_KLINES}?symbol=SOLUSDC&interval=1h&startTime=${start}&limit=${KLINES_LIMIT}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000), headers: { accept: "application/json" } });
      if (!res.ok) {
        await res.text().catch(() => "");
        log.warn("SOL/USD history unavailable from Binance; SOL PnL stays null for older trades until the recorder has data", {
          status: res.status,
        });
        return;
      }
      const points = parseBinanceKlines(await res.json());
      if (points.length === 0) break;
      const fresh = points.filter((p) => p.hourMs >= from && p.hourMs <= to && !have.has(p.hourMs));
      if (fresh.length > 0) {
        await prisma.solUsdHour.createMany({ data: fresh.map((p) => ({ hour: new Date(p.hourMs), price: p.price, source: "binance" })) });
        for (const p of fresh) have.add(p.hourMs);
        inserted += fresh.length;
      }
      start = points[points.length - 1]!.hourMs + HOUR_MS;
      if (points.length < KLINES_LIMIT) break;
    }
    log.info("SOL/USD hourly history filled", { inserted, source: "binance" });
  } catch (err) {
    log.warn("SOL/USD history backfill failed; SOL PnL may be null for older trades", { err: safeErr(err) });
  }
}
