// Helius identity labels (design §3.3), daily at 03:00 UTC, P4. Paid plans only, and only when the
// batch-identity probe passed. Tracked wallets with no label check in 7 days, then the top 500 candidates by
// score, in chunks of 100 (100 credits each).
//  - A name `"<h>" on Fomo` becomes the handle (handleSource "helius", verified). Other names are ignored.
//  - A seed handle is never overwritten (conflicts are logged); a matching Helius label marks it verified.
//  - Tags are stored as heliusTags. Nothing typed by users ever becomes a label.

import { Prisma } from "@prisma/client";
import { config } from "@/lib/config";
import { prisma } from "@/lib/db";
import { batchIdentity, canSpend, HELIUS_CREDITS, HELIUS_PRIORITY, parseFomoHandleLabel, type HeliusIdentity } from "@/lib/helius";
import { logger } from "../log";
import { DAY_MS } from "./policy";
import { safeErr, state } from "./state";

const log = logger("fomo-identity");

const RECHECK_MS = 7 * DAY_MS;
const TOP_CANDIDATES = 500;
const CHUNK = 100;
const MAX_TAGS = 20;
/** Consecutive failed chunks after which the run stops (the API is down: the rest waits for tomorrow). */
const MAX_CHUNK_FAILURES = 2;

export function identityEnabled(): boolean {
  return config.fomoIdentity && state.caps?.identity === true;
}

export async function identityDaily(): Promise<void> {
  if (!identityEnabled()) return;
  const stale = { OR: [{ identityAt: null }, { identityAt: { lt: new Date(Date.now() - RECHECK_MS) } }] };
  const [tracked, candidates] = await Promise.all([
    prisma.fomoWallet.findMany({ where: { status: "tracked", ...stale }, select: { wallet: true } }),
    prisma.fomoWallet.findMany({ where: { status: "candidate", ...stale }, orderBy: { sampleScore: "desc" }, take: TOP_CANDIDATES, select: { wallet: true } }),
  ]);
  const wallets = [...tracked, ...candidates].map((r) => r.wallet);
  let labelled = 0;
  let checked = 0;
  let failedChunks = 0;
  let failedInARow = 0;
  for (let i = 0; i < wallets.length; i += CHUNK) {
    if (state.stopping) break;
    if (!canSpend(HELIUS_PRIORITY.identity, HELIUS_CREDITS.batchIdentity)) {
      log.info("identity labelling paused by the daily credit cap", { checked });
      break;
    }
    const chunk = wallets.slice(i, i + CHUNK);
    let ids: HeliusIdentity[];
    try {
      ids = await batchIdentity(chunk, { priority: HELIUS_PRIORITY.identity });
    } catch (err) {
      // Not rethrown: the daily loop would re-run (and re-bill) the whole job every 10 minutes. These wallets
      // are still stale, so the next daily run picks them up again.
      failedChunks++;
      failedInARow++;
      log.warn("batch-identity chunk failed; retried in the next daily run", { wallets: chunk.length, err: safeErr(err) });
      if (failedInARow >= MAX_CHUNK_FAILURES) break;
      continue;
    }
    failedInARow = 0;
    labelled += await applyIdentities(chunk, ids);
    checked += chunk.length;
  }
  if (checked > 0 || failedChunks > 0) log.info("Helius identity labels refreshed", { checked, fomoHandles: labelled, failedChunks });
}

async function applyIdentities(requested: string[], ids: HeliusIdentity[]): Promise<number> {
  const byAddress = new Map(ids.map((i) => [i.address, i]));
  const rows = await prisma.fomoWallet.findMany({
    where: { wallet: { in: requested } },
    select: { wallet: true, status: true, handle: true, handleLower: true, handleSource: true, handleVerified: true },
  });
  const now = new Date();
  let labelled = 0;
  for (const row of rows) {
    const id = byAddress.get(row.wallet);
    const data: Prisma.FomoWalletUpdateInput = { identityAt: now };
    if (id) data.heliusTags = JSON.stringify(id.tags.slice(0, MAX_TAGS));
    const label = parseFomoHandleLabel(id?.name);
    let traderHandle: string | null = null;
    if (label) {
      labelled++;
      const lower = label.toLowerCase();
      if (row.handleSource === "seed" && row.handle) {
        if (row.handleLower !== lower) {
          log.warn("Helius FOMO label differs from the seed handle; keeping the seed", { wallet: row.wallet, seed: row.handle, helius: label });
        } else if (!row.handleVerified) {
          data.handleVerified = true;
          traderHandle = row.handle;
        }
      } else if (row.handle !== label || !row.handleVerified) {
        data.handle = label;
        data.handleLower = lower;
        data.handleSource = "helius";
        data.handleVerified = true;
        traderHandle = label;
      }
    }
    await prisma.fomoWallet.update({ where: { wallet: row.wallet }, data });
    if (traderHandle && row.status !== "excluded") {
      await prisma.trader.updateMany({ where: { wallet: row.wallet }, data: { handle: traderHandle, verified: true } });
    }
  }
  return labelled;
}
