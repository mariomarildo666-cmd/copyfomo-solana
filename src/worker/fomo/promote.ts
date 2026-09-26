// Promotion (hourly) and demotion (daily) of discovered wallets (design §5.6). DB only.
//  - Promote: candidates with ≥ FOMO_PROMOTE_MIN_HITS sample hits, decayed score ≥ $1,000 and a sample in the last
//    3 days, best first, up to the daily allowance (FOMO_PROMOTE_PER_DAY) and the tracked cap (FOMO_MAX_TRACKED;
//    logs mode can only cover 240 live). They become tracked with a fresh backfill.
//  - Demote: tracked wallets of origin "discovered" / "user", not followed, not eligible in any window for 14 days
//    → candidate. Their data stays until retention removes it. Seed wallets are never demoted automatically.

import { config } from "@/lib/config";
import { kvGet, kvSet, prisma } from "@/lib/db";
import { utcDay } from "@/lib/helius";
import { logger } from "../log";
import { LOGS_MAX_CONNECTIONS, LOGS_PER_CONNECTION, PROMOTE_RECENT_MS, promotionAllowance, selectDemotions, selectPromotions } from "./policy";
import { refreshTracked, state } from "./state";

const log = logger("fomo-promote");

const PROMOTIONS_KV_KEY = "fomo:promotions";
/** Kv map wallet → ISO time a window was last eligible (written by stats.ts). */
export const LAST_ELIGIBLE_KV_KEY = "fomo:lastEligibleAt";
const CANDIDATE_POOL = 1_000;

/** FOMO_MAX_TRACKED, bounded by what logs mode can cover live. */
export function effectiveMaxTracked(): number {
  return state.mode === "logs" ? Math.min(config.fomoMaxTracked, LOGS_PER_CONNECTION * LOGS_MAX_CONNECTIONS) : config.fomoMaxTracked;
}

async function promotedToday(): Promise<number> {
  const row = await kvGet<{ day?: unknown; count?: unknown }>(PROMOTIONS_KV_KEY).catch(() => null);
  const v = row?.value;
  return v && v.day === utcDay() && typeof v.count === "number" ? v.count : 0;
}

export async function promoteTick(): Promise<void> {
  const now = Date.now();
  const [tracked, today] = await Promise.all([prisma.fomoWallet.count({ where: { status: "tracked" } }), promotedToday()]);
  const allowance = promotionAllowance({ perDay: config.fomoPromotePerDay, promotedToday: today, maxTracked: effectiveMaxTracked(), tracked });
  if (allowance <= 0) return;

  const rows = await prisma.fomoWallet.findMany({
    where: { status: "candidate", sampleHits: { gte: config.fomoPromoteMinHits }, lastSampleAt: { gte: new Date(now - PROMOTE_RECENT_MS) } },
    orderBy: { sampleScore: "desc" },
    take: CANDIDATE_POOL,
    select: { wallet: true, sampleScore: true, sampleScoreAt: true, sampleHits: true, lastSampleAt: true },
  });
  const picks = selectPromotions(
    rows.map((r) => ({
      wallet: r.wallet,
      sampleScore: r.sampleScore,
      sampleScoreAtMs: r.sampleScoreAt?.getTime() ?? null,
      sampleHits: r.sampleHits,
      lastSampleAtMs: r.lastSampleAt?.getTime() ?? null,
    })),
    { nowMs: now, minHits: config.fomoPromoteMinHits, limit: allowance },
  );
  if (picks.length === 0) return;

  const at = new Date(now);
  let promoted = 0;
  for (const p of picks) {
    const res = await prisma.fomoWallet.updateMany({
      where: { wallet: p.wallet, status: "candidate" },
      data: { status: "tracked", trackedAt: at, backfillState: "pending", backfillCursor: null, coveredFrom: null, gapFrom: null, statsDirty: true },
    });
    promoted += res.count;
  }
  await kvSet(PROMOTIONS_KV_KEY, { day: utcDay(now), count: today + promoted });
  log.info("candidates promoted to tracked", { promoted, allowance, top: picks[0] ? Math.round(picks[0].score) : undefined });
  await refreshTracked();
}

export async function lastEligibleMap(): Promise<Record<string, string>> {
  const row = await kvGet<unknown>(LAST_ELIGIBLE_KV_KEY).catch(() => null);
  const v = row?.value;
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: Record<string, string> = {};
  for (const [k, s] of Object.entries(v as Record<string, unknown>)) if (typeof s === "string") out[k] = s;
  return out;
}

export async function demoteTick(): Promise<void> {
  const now = Date.now();
  const [rows, lastEligible] = await Promise.all([
    prisma.fomoWallet.findMany({
      where: { status: "tracked", origin: { in: ["discovered", "user"] } },
      select: { wallet: true, origin: true, trackedAt: true, stats: { select: { eligible: true } } },
    }),
    lastEligibleMap(),
  ]);
  const picks = selectDemotions(
    rows.map((r) => {
      const le = lastEligible[r.wallet] ? Date.parse(lastEligible[r.wallet]!) : NaN;
      return {
        wallet: r.wallet,
        origin: r.origin,
        trackedAtMs: r.trackedAt?.getTime() ?? null,
        lastEligibleAtMs: Number.isFinite(le) ? le : null,
        eligibleNow: r.stats.some((s) => s.eligible),
        followed: state.followed.has(r.wallet),
      };
    }),
    now,
  );
  if (picks.length === 0) return;
  for (let i = 0; i < picks.length; i += 200) {
    const chunk = picks.slice(i, i + 200);
    await prisma.$transaction([
      prisma.fomoWallet.updateMany({ where: { wallet: { in: chunk }, status: "tracked" }, data: { status: "candidate", statsDirty: false } }),
      prisma.fomoWalletStats.updateMany({ where: { wallet: { in: chunk } }, data: { rank: null } }),
    ]);
  }
  log.info("tracked wallets demoted to candidate (not eligible for 14 days)", { demoted: picks.length });
  await refreshTracked();
}
