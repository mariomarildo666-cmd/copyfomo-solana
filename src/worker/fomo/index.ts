// FOMO indexer (design §4.2): detects FOMO trades of tracked wallets on-chain (rule R, src/lib/fomo-chain.ts)
// through Helius and keeps FomoSwap / FomoWalletStats / FomoPosition current for the leaderboard.
// No FOMO API is used. Started from src/worker/index.ts:
//
//   const stopFomo = startFomoIndexer();   …   await stopFomo();
//
// Without HELIUS_API_KEY, or with FOMO_INDEXER=off, it does nothing (enqueueFomoTx then returns false).
// Startup: PRAGMA journal_mode=WAL → probeCaps() → syncFomoSeed() → loops. Each loop catches its own errors.
//
//   loop          cadence                       Helius priority
//   stream        continuous (tS or logs)       P1   stream.ts
//   ingest        every 250 ms                  —    ingest.ts
//   gap-fill      on reconnect / restart        P1   gapfill.ts
//   backfill      continuous, one wallet        P2   backfill.ts
//   sampler       plan (60 s paid, 30 min free) P3   sampler.ts
//   promote       hourly (demote daily)         —    promote.ts
//   stats         5 min dirty, hourly all       —    stats.ts
//   prices        15 min                        —    prices.ts (Jupiter)
//   reconcile     daily                         P2   reconcile.ts
//   identity      daily 03:00 UTC (paid)        P4   identity.ts
//   solprice      60 s (+ Binance at startup)   —    solprice.ts
//   retention     daily                         —    retention.ts
//   status        10 s                          —    status.ts (Kv "fomo:indexer")

import WebSocket from "ws";
import { config } from "@/lib/config";
import { prisma } from "@/lib/db";
import { syncFomoSeed } from "@/lib/fomo";
import { heliusConfigured, meter, probeCaps, type HeliusCaps, type WebSocketCtor } from "@/lib/helius";
import { logger } from "../log";
import { backfillTick } from "./backfill";
import { requestGapFill, gapFillIdle } from "./gapfill";
import { identityDaily, identityEnabled } from "./identity";
import { startIngest, stopIngest } from "./ingest";
import { daily, every, type LoopHandle } from "./loop";
import { MINUTE_MS } from "./policy";
import { pricesTick, seedPriceCache } from "./prices";
import { demoteTick, promoteTick } from "./promote";
import { reconcileDaily } from "./reconcile";
import { retentionDaily } from "./retention";
import { flushStreamHits, sampleTick } from "./sampler";
import { backfillSolPrices, recordSolPrice } from "./solprice";
import { statsTick } from "./stats";
import { readPersistedLastMsgAt, writeStatus } from "./status";
import { StreamController } from "./stream";
import { refreshTracked, safeErr, state } from "./state";

export { enqueueFomoTx } from "./ingest";

const log = logger("fomo");

const TRACKED_REFRESH_MS = 30_000;
const STOP_STEP_MS = 5_000;

async function enableWal(): Promise<void> {
  if (!/^file:/i.test(process.env.DATABASE_URL ?? "")) return;
  try {
    const rows = await prisma.$queryRawUnsafe<{ journal_mode?: string }[]>("PRAGMA journal_mode=WAL;");
    log.debug("sqlite journal mode", { mode: rows[0]?.journal_mode ?? "?" });
  } catch (err) {
    log.warn("could not enable SQLite WAL mode", { err: safeErr(err) });
  }
}

function capsFallback(): HeliusCaps {
  return {
    plan: config.heliusPlan,
    ts: false,
    gtfa: false,
    identity: false,
    probedAt: new Date().toISOString(),
    definitive: false,
    errors: { ts: "probe failed", gtfa: "probe failed", identity: "probe failed" },
  };
}

/**
 * Start the FOMO indexer in the background. Returns an async stop function (idempotent, bounded ~20 s).
 * A no-op without HELIUS_API_KEY or with FOMO_INDEXER=off.
 */
export function startFomoIndexer(): () => Promise<void> {
  const loops: LoopHandle[] = [];
  let stream: StreamController | null = null;
  let stopped = false;

  const boot = (async () => {
    await enableWal();
    if (!heliusConfigured()) {
      log.info("FOMO indexer off: HELIUS_API_KEY is not set (no on-chain FOMO indexing)");
      return;
    }
    if (!config.fomoIndexer) {
      log.info("FOMO indexer off: FOMO_INDEXER=off");
      return;
    }

    state.caps = await probeCaps({ webSocket: WebSocket as unknown as WebSocketCtor }).catch((err: unknown) => {
      log.warn("Helius capability probe failed; using the most conservative mechanisms", { err: safeErr(err) });
      return capsFallback();
    });
    log.info("Helius capabilities", {
      plan: config.heliusPlan,
      transactionSubscribe: state.caps.ts,
      gTFA: state.caps.gtfa,
      identity: state.caps.identity,
      definitive: state.caps.definitive,
    });
    for (const [k, v] of Object.entries(state.caps.errors)) if (v) log.debug("probe detail", { feature: k, err: v });
    if (stopped) return;

    try {
      const seed = await syncFomoSeed();
      log.info("seed synced", seed);
    } catch (err) {
      log.warn("seed sync failed", { err: safeErr(err) });
    }
    await refreshTracked();
    if (stopped) return;
    // Newest known FOMO trade of a tracked wallet: the "no trade in 15 min while connected" alarm then also
    // fires when the live stream never delivers anything after a restart.
    const newest = await prisma.fomoWallet.aggregate({ where: { status: "tracked" }, _max: { lastTradeAt: true } }).catch(() => null);
    state.lastFomoTradeAt = newest?._max.lastTradeAt?.getTime() ?? null;

    state.enabled = true;
    startIngest();
    void backfillSolPrices();
    // Valuations of the previous run: the first stats pass (before pricesTick) must not null them.
    await seedPriceCache().catch((err: unknown) => log.warn("could not warm the price cache", { err: safeErr(err) }));

    // Restart gap: from the previous run's resume point (Kv), for every tracked wallet, as soon as the stream
    // has subscribed (however long that takes), so the repair reaches the start of live coverage.
    const previousResumeAt = await readPersistedLastMsgAt();
    stream = new StreamController((since, wallets, reason) => requestGapFill(since, wallets, reason), { resumeFromMs: previousResumeAt });
    stream.start(state.caps.ts ? "stream" : "logs");
    const streamGapSince = () => stream?.openGapSince() ?? null;

    let appliedVersion = state.trackedVersion;
    loops.push(
      every(
        "tracked refresh",
        TRACKED_REFRESH_MS,
        async () => {
          await refreshTracked();
          if (state.trackedVersion !== appliedVersion) {
            appliedVersion = state.trackedVersion;
            stream?.update();
          }
        },
        { initialDelayMs: TRACKED_REFRESH_MS },
      ),
    );

    loops.push(every("status", 10_000, () => writeStatus({ streamGapSince }), { initialDelayMs: 2_000 }));
    loops.push(every("solprice", 60_000, recordSolPrice, { initialDelayMs: 1_000 }));
    loops.push(every("backfill", 10_000, backfillTick, { initialDelayMs: 15_000 }));
    loops.push(every("stats", 5 * MINUTE_MS, statsTick, { initialDelayMs: 60_000 }));
    loops.push(every("prices", 15 * MINUTE_MS, pricesTick, { initialDelayMs: 3 * MINUTE_MS }));
    if (config.fomoDiscovery === "sample") {
      loops.push(every("sampler", config.fomoSampleIntervalMs, sampleTick, { initialDelayMs: 30_000 }));
    } else if (config.fomoDiscovery === "stream") {
      loops.push(every("S2 candidate flush", 60_000, flushStreamHits));
    }
    if (config.fomoDiscovery !== "off") loops.push(every("promote", 60 * MINUTE_MS, promoteTick, { initialDelayMs: 10 * MINUTE_MS }));
    loops.push(daily("demote", demoteTick, { initialDelayMs: 20 * MINUTE_MS }));
    loops.push(daily("reconcile", reconcileDaily, { initialDelayMs: 30 * MINUTE_MS }));
    loops.push(daily("retention", retentionDaily, { hourUtc: 4, initialDelayMs: 15 * MINUTE_MS }));
    if (identityEnabled()) loops.push(daily("identity", identityDaily, { hourUtc: 3, initialDelayMs: 2 * MINUTE_MS }));
    else if (config.fomoIdentity) log.info("Helius identity labels off: batch-identity probe did not pass");

    log.info("FOMO indexer running", {
      mode: state.mode,
      tracked: state.tracked.size,
      maxTracked: config.fomoMaxTracked,
      discovery: config.fomoDiscovery,
      sampleEverySec: Math.round(config.fomoSampleIntervalMs / 1000),
      creditCap: config.heliusDailyCreditCap,
    });
  })().catch((err: unknown) => log.error("FOMO indexer failed to start", { err: safeErr(err) }));

  return async () => {
    if (stopped) return;
    stopped = true;
    state.stopping = true;
    const step = <T>(p: Promise<T>) => Promise.race([p.catch(() => undefined), new Promise((r) => setTimeout(r, STOP_STEP_MS))]);
    await step(boot);
    if (!state.enabled) return;
    await step(Promise.all(loops.map((l) => l.stop(STOP_STEP_MS))));
    if (stream) await step(stream.stop());
    await step(gapFillIdle(STOP_STEP_MS));
    await step(stopIngest(STOP_STEP_MS));
    await step(writeStatus({ final: true, streamGapSince: () => stream?.openGapSince() ?? null }));
    await step(meter.flush());
    state.enabled = false;
    log.info("FOMO indexer stopped");
  };
}
