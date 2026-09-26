// Discovery (design §5.6): sample FOMO trades network-wide from the MARKER address and score their traders.
//  - Each tick (Free 30 min, paid 60 s), P3: with gTFA the newest 100 full transactions (10 credits); without it
//    getSignaturesForAddress(200) + getTransaction on 20 random successful ones (21 credits).
//  - Each trade: bumpCandidate(user, usd) → sampleScore × exp(−Δt/3 d) + usd, sampleHits++, lastSampleAt = now.
//    Unknown wallets become FomoWallet {origin "discovered", status "candidate"}; excluded wallets are skipped.
//    A tracked trader's sampled trade is also ingested (source "sample").
//  - Paused while the ingest queue is under pressure (> 15,000) or P3 is paused by the daily credit cap.
//  - Business (FOMO_DISCOVERY=stream): the S2 stream feeds recordStreamTrade instead; flushed every 60 s.

import { Prisma } from "@prisma/client";
import { config } from "@/lib/config";
import { prisma } from "@/lib/db";
import { classifyFomoTx, FOMO_MARKER, normalizeTx, USDC_DECIMALS, type MiniTx } from "@/lib/fomo-chain";
import {
  canSpend,
  getSignatures,
  getTransaction,
  getTransactionsForAddress,
  HELIUS_CREDITS,
  HELIUS_PRIORITY,
  isHeliusError,
} from "@/lib/helius";
import { logger } from "../log";
import { LruSet } from "../util";
import { enqueueFomoTx, ingestQueueSize } from "./ingest";
import { aggregateHits, bumpScore, discoveryPaused } from "./policy";
import { safeErr, state } from "./state";

const log = logger("fomo-sampler");

const GTFA_SAMPLE_LIMIT = 100;
const RPC_SAMPLE_SIGS = 200;
const RPC_SAMPLE_TXS = 20;
const WRITE_CHUNK = 300;
const STREAM_HITS_MAX = 200_000;

const sampled = new LruSet(20_000);
/** gTFA on the marker refused definitively (plan change, …): use the RPC path for the rest of the process. */
let gtfaRefused = false;
let streamHits: { user: string; usd: number }[] = [];

const usdOf = (usdcRaw: bigint) => Number(usdcRaw) / 10 ** USDC_DECIMALS;

/** S2 stream (Business): remember a network-wide FOMO trade for the next candidate flush. */
export function recordStreamTrade(user: string, usd: number): void {
  if (streamHits.length < STREAM_HITS_MAX) streamHits.push({ user, usd });
}

/** Write the S2 hits gathered since the last flush (every 60 s). */
export async function flushStreamHits(): Promise<void> {
  if (streamHits.length === 0) return;
  const hits = streamHits;
  streamHits = [];
  await recordCandidateHits(hits);
}

async function sampleViaGtfa(): Promise<MiniTx[]> {
  try {
    const page = await getTransactionsForAddress(FOMO_MARKER, {
      priority: HELIUS_PRIORITY.discovery,
      transactionDetails: "full",
      limit: GTFA_SAMPLE_LIMIT,
      sortOrder: "desc",
      filters: { status: "succeeded" },
    });
    return page.data.map(normalizeTx).filter((t): t is MiniTx => t !== null);
  } catch (err) {
    if (isHeliusError(err, "rpc", "invalid_response") || (isHeliusError(err, "http") && err.status !== null && err.status < 500)) {
      gtfaRefused = true;
      log.warn("gTFA sampling refused; falling back to getSignaturesForAddress sampling", { err: safeErr(err) });
    }
    throw err;
  }
}

async function sampleViaRpc(): Promise<MiniTx[]> {
  const sigs = await getSignatures(FOMO_MARKER, { priority: HELIUS_PRIORITY.discovery, limit: RPC_SAMPLE_SIGS });
  const pool = sigs.filter((s) => (s.err === null || s.err === undefined) && !sampled.has(s.signature));
  // Random picks (Fisher–Yates prefix) so the sample is not biased to one block.
  for (let i = 0; i < Math.min(RPC_SAMPLE_TXS, pool.length); i++) {
    const j = i + Math.floor(Math.random() * (pool.length - i));
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }
  const out: MiniTx[] = [];
  for (const s of pool.slice(0, RPC_SAMPLE_TXS)) {
    if (!canSpend(HELIUS_PRIORITY.discovery, HELIUS_CREDITS.rpc)) break;
    const raw = await getTransaction(s.signature, { priority: HELIUS_PRIORITY.discovery });
    const tx = raw ? normalizeTx(raw) : null;
    if (tx) out.push(tx);
  }
  return out;
}

/** One sampler tick (P3). */
export async function sampleTick(): Promise<void> {
  if (config.fomoDiscovery !== "sample") return;
  const queued = ingestQueueSize();
  if (discoveryPaused(queued)) {
    log.debug("sampler paused: ingest queue under pressure", { queued });
    return;
  }
  const useGtfa = state.caps?.gtfa === true && !gtfaRefused;
  if (!canSpend(HELIUS_PRIORITY.discovery, useGtfa ? HELIUS_CREDITS.gtfa : 1 + RPC_SAMPLE_TXS)) return;

  const txs = useGtfa ? await sampleViaGtfa() : await sampleViaRpc();
  const hits: { user: string; usd: number }[] = [];
  let ingested = 0;
  for (const tx of txs) {
    if (sampled.has(tx.signature)) continue;
    sampled.add(tx.signature);
    const cls = classifyFomoTx(tx);
    if (cls.kind !== "trade") continue;
    hits.push({ user: cls.user, usd: usdOf(cls.usdcRaw) });
    if (state.tracked.has(cls.user) && enqueueFomoTx(tx, "sample", { lane: "discovery" })) ingested++;
  }
  await recordCandidateHits(hits);
  log.debug("sampled", { txs: txs.length, trades: hits.length, ingested });
}

/** bumpCandidate for a batch of sampled trades (one DB round per chunk of wallets). */
export async function recordCandidateHits(hits: readonly { user: string; usd: number }[]): Promise<void> {
  if (hits.length === 0) return;
  const agg = aggregateHits(hits);
  const now = Date.now();
  const at = new Date(now);
  const users = [...agg.keys()];
  for (let i = 0; i < users.length; i += WRITE_CHUNK) {
    const chunk = users.slice(i, i + WRITE_CHUNK);
    const rows = await prisma.fomoWallet.findMany({
      where: { wallet: { in: chunk } },
      select: { wallet: true, status: true, sampleScore: true, sampleScoreAt: true },
    });
    const byWallet = new Map(rows.map((r) => [r.wallet, r]));
    const creates: Prisma.FomoWalletCreateManyInput[] = [];
    const updates: Prisma.PrismaPromise<unknown>[] = [];
    for (const user of chunk) {
      const a = agg.get(user)!;
      const r = byWallet.get(user);
      if (r?.status === "excluded") continue;
      if (!r) {
        creates.push({ wallet: user, origin: "discovered", status: "candidate", sampleScore: a.usd, sampleScoreAt: at, sampleHits: a.hits, lastSampleAt: at });
        continue;
      }
      updates.push(
        prisma.fomoWallet.updateMany({
          where: { wallet: user },
          data: {
            sampleScore: bumpScore({ score: r.sampleScore, atMs: r.sampleScoreAt?.getTime() ?? null }, a.usd, now),
            sampleScoreAt: at,
            sampleHits: { increment: a.hits },
            lastSampleAt: at,
          },
        }),
      );
    }
    if (creates.length > 0) {
      try {
        await prisma.fomoWallet.createMany({ data: creates });
      } catch (err) {
        if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")) throw err;
        // Created meanwhile (e.g. a pasted-wallet check in the web process): bump them one by one.
        for (const c of creates) {
          await prisma.fomoWallet
            .upsert({ where: { wallet: c.wallet }, create: c, update: { sampleHits: { increment: c.sampleHits ?? 1 }, lastSampleAt: at } })
            .catch((e: unknown) => log.debug("candidate upsert failed", { wallet: c.wallet, err: safeErr(e) }));
        }
      }
    }
    if (updates.length > 0) await prisma.$transaction(updates);
  }
}
