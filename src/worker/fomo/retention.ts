// Daily retention (design §4.2), DB only:
//  1. a (wallet, mint) group's swaps go when ALL of them are older than 31 days and (policy.selectRetentionGroups)
//     - tracked wallet: no FomoPosition is open for it AND that is current — stats clean (statsDirty false) and
//       computed after the group's newest row was written (statsAt > max createdAt). FIFO needs every lot of an
//       open position, and backfill keeps inserting old buys that only the next stats pass turns into positions;
//     - excluded wallet: always (never ranked);
//     - candidates: rule 2 instead.
//     Only rows that existed when the groups were read are deleted (blockTime < cutoff, createdAt ≤ then).
//  2. swaps of candidate (untracked) wallets older than 45 days;
//  3. candidates whose decayed sample score is < 50 and whose last sample is older than 14 days (with their rows).
// Tracked, excluded, seed and followed wallets are never deleted; neither are pasted-wallet check results
// (candidates never sampled).

import { prisma } from "@/lib/db";
import { logger } from "../log";
import { DAY_MS, decayScore, selectRetentionGroups, type RetentionWallet } from "./policy";
import { state } from "./state";

const log = logger("fomo-retention");

const GROUP_MAX_AGE_MS = 31 * DAY_MS;
const CANDIDATE_SWAP_MAX_AGE_MS = 45 * DAY_MS;
const CANDIDATE_IDLE_MS = 14 * DAY_MS;
const CANDIDATE_MIN_SCORE = 50;
const DELETE_CHUNK = 200;
const IN_CHUNK = 500;

export async function retentionDaily(): Promise<void> {
  const now = Date.now();
  const cutoff = new Date(now - GROUP_MAX_AGE_MS);

  // 1. Old, closed (wallet, mint) groups.
  const readAt = new Date();
  const groups = await prisma.fomoSwap.groupBy({
    by: ["wallet", "mint"],
    _max: { blockTime: true, createdAt: true },
    having: { blockTime: { _max: { lt: cutoff } } },
  });
  let groupSwaps = 0;
  let kept = 0;
  if (groups.length > 0) {
    const open = new Set((await prisma.fomoPosition.findMany({ select: { wallet: true, mint: true } })).map((p) => `${p.wallet}:${p.mint}`));
    const walletIds = [...new Set(groups.map((g) => g.wallet))];
    const wallets = new Map<string, RetentionWallet>();
    for (let i = 0; i < walletIds.length; i += IN_CHUNK) {
      const rows = await prisma.fomoWallet.findMany({
        where: { wallet: { in: walletIds.slice(i, i + IN_CHUNK) } },
        select: { wallet: true, status: true, statsDirty: true, statsAt: true },
      });
      for (const r of rows) wallets.set(r.wallet, { status: r.status, statsDirty: r.statsDirty, statsAtMs: r.statsAt?.getTime() ?? null });
    }
    const deletable = selectRetentionGroups(
      groups.map((g) => ({ wallet: g.wallet, mint: g.mint, maxCreatedAtMs: g._max.createdAt?.getTime() ?? null })),
      wallets,
      open,
    );
    const isTracked = (g: { wallet: string }) => wallets.get(g.wallet)?.status === "tracked";
    kept = groups.filter(isTracked).length - deletable.filter(isTracked).length;
    for (let i = 0; i < deletable.length; i += DELETE_CHUNK) {
      if (state.stopping) return;
      const chunk = deletable.slice(i, i + DELETE_CHUNK);
      const res = await prisma.fomoSwap.deleteMany({
        where: {
          OR: chunk.map((g) => ({ wallet: g.wallet, mint: g.mint })),
          // A row written after the groups were read (live or backfill) is not part of what was checked.
          blockTime: { lt: cutoff },
          createdAt: { lte: readAt },
        },
      });
      groupSwaps += res.count;
    }
  }

  // 2. Old swaps of candidate wallets.
  const candidateSwaps = await prisma.fomoSwap.deleteMany({
    where: { blockTime: { lt: new Date(now - CANDIDATE_SWAP_MAX_AGE_MS) }, fomoWallet: { status: "candidate" } },
  });

  // 3. Idle low-score candidates (score decayed to now).
  const idle = await prisma.fomoWallet.findMany({
    where: { status: "candidate", origin: "discovered", lastSampleAt: { lt: new Date(now - CANDIDATE_IDLE_MS) } },
    select: { wallet: true, sampleScore: true, sampleScoreAt: true },
  });
  const drop = idle
    .filter((c) => !state.followed.has(c.wallet) && decayScore(c.sampleScore, c.sampleScoreAt?.getTime() ?? null, now) < CANDIDATE_MIN_SCORE)
    .map((c) => c.wallet);
  let candidates = 0;
  for (let i = 0; i < drop.length; i += DELETE_CHUNK) {
    if (state.stopping) return;
    const res = await prisma.fomoWallet.deleteMany({ where: { wallet: { in: drop.slice(i, i + DELETE_CHUNK) }, status: "candidate" } });
    candidates += res.count;
  }

  log.info("retention done", { groupSwaps, trackedGroupsKept: kept, candidateSwaps: candidateSwaps.count, candidates });
}
