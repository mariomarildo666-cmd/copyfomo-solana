// copyfomo worker: watches trader wallets, mirrors their swaps into copy agents, runs owner commands, sweeps
// platform fees.
//   npm run worker   (tsx --env-file-if-exists=.env --env-file-if-exists=.env.worker src/worker/index.ts)
// Run exactly ONE worker per database. Startup recovery fails work that never reached the chain and hands every
// signed transaction (the in-flight journal) to the reconciler, which settles it from the chain.

import { randomBytes } from "node:crypto";
import { config, liveConfigErrors } from "@/lib/config";
import { generateSealKeypair, openSecret, sealSecret } from "@/lib/crypto";
import { kvSet, prisma } from "@/lib/db";
import { meter } from "@/lib/helius";
import { connection, getSolBalance } from "@/lib/solana";
import { startBalanceLoop } from "./balances";
import { resolveWithdraw, startCommandLoop } from "./commands";
import { dispatchEvent, resolveCopyBuy, resolveCopySell, retryCopySell } from "./executor";
import { resolveFeeSweep, startFeeSweepLoop } from "./feesweep";
import { startFomoIndexer } from "./fomo";
import { startHoldingsLoop } from "./holdings";
import { inflightKey, journalRow, startInflightLoop, type InflightKind, type InflightRecord } from "./inflight";
import { errText, logger, redactUrl } from "./log";
import { beginShutdown, drainQueues, pendingAgentQueues } from "./queue";
import { sameSealKey, workerSealPublicKey } from "./sealcheck";
import { startSellRetryLoop } from "./sellretry";
import { MAX_CONFIRM_WAIT_MS } from "./send";
import { Watcher } from "./watcher";

const log = logger("worker");
const HEARTBEAT_MS = 10_000;
/** In-flight sends may need their whole confirmation window (block-height expiry + final lookups). */
const SHUTDOWN_DRAIN_MS = MAX_CONFIRM_WAIT_MS + 15_000;
/** Journal-less "sending" rows found at startup get this many blocks (~2 min) before they may count as expired. */
const RECOVERY_EXPIRY_BLOCKS = 300;

function fatal(message: string): never {
  console.error(`\nFATAL: ${message}\n`);
  process.exit(1);
}

/** Live mode must be safe to run before touching funds: config, fee wallet, seal key pair (round-trip). */
function validateConfig(): void {
  if (config.mode !== "live") return;
  const errors = liveConfigErrors();
  if (!/^https:\/\//i.test(config.jupiterUrl)) errors.push("JUPITER_API_URL must use https in live mode (swap transactions are signed from its answers).");
  if (errors.length) fatal(`live mode refused:\n       - ${errors.join("\n       - ")}`);
  if (!config.walletSealPrivateKey) {
    fatal(
      "COPYFOMO_MODE=live requires WALLET_SEAL_PRIVATE_KEY (the worker signs swaps and withdrawals).\n" +
        "       Generate a pair with `npm run keys:gen`, give the web process only WALLET_SEAL_PUBLIC_KEY.",
    );
  }
  const derived = workerSealPublicKey();
  if (!derived) fatal("WALLET_SEAL_PRIVATE_KEY is not a usable x25519 key (base64 of 32 raw bytes).");
  if (config.walletSealPublicKey && !sameSealKey(config.walletSealPublicKey, derived)) {
    fatal(
      "WALLET_SEAL_PUBLIC_KEY does not pair with WALLET_SEAL_PRIVATE_KEY. Agents sealed with it could never be opened.\n" +
        `       The public key for this worker's private key is ${derived} — the web must use exactly that value.`,
    );
  }
  // Round-trip through the real seal/open code path.
  const probe = new Uint8Array(randomBytes(32));
  try {
    const opened = openSecret(sealSecret(probe, derived));
    if (!opened.every((b, i) => b === probe[i])) throw new Error("seal round-trip mismatch");
  } catch (err) {
    fatal(`WALLET_SEAL_PRIVATE_KEY / WALLET_SEAL_PUBLIC_KEY are unusable: ${errText(err)}`);
  }
  // An unrelated key must fail authentication (proves openSecret really authenticates).
  try {
    openSecret(sealSecret(probe, generateSealKeypair().publicKey));
    fatal("seal check: a blob sealed to another key opened — refusing to run");
  } catch (err) {
    if (!/authentication failed/.test(errText(err))) fatal(`seal check failed: ${errText(err)}`);
  }
  log.info("seal key pair ok", { sealPublicKey: derived });
}

/** Warn when the fee wallet can't receive small sweeps (a 0-lamport recipient needs ≥ its rent-exempt minimum). */
async function checkFeeWallet(): Promise<void> {
  if (config.mode !== "live" || !config.platformFeeWallet) return;
  const sol = await getSolBalance(config.platformFeeWallet).catch(() => null);
  if (sol === 0) log.warn("PLATFORM_FEE_WALLET holds no SOL: fund it with ~0.001 SOL so small fee sweeps can land", { wallet: config.platformFeeWallet });
}

/**
 * Anything left mid-flight by a previous process: work that never reached the chain is failed with a reason; every
 * signed transaction stays with the reconciler (inflight.ts). Nothing is retried blindly.
 */
async function recoverInterrupted(): Promise<void> {
  const trades = await prisma.copyTrade.updateMany({
    where: { status: "pending" },
    data: { status: "failed", reason: "interrupted by worker restart (nothing was sent)" },
  });

  // Signed rows whose journal record is missing (should not happen: both are written in one transaction).
  const height = await connection().getBlockHeight("confirmed").catch(() => null);
  const sending = await prisma.copyTrade.findMany({ where: { status: "sending", signature: { not: null } }, include: { agent: true } });
  for (const t of sending) {
    const exists = await prisma.kv.findUnique({ where: { key: inflightKey(t.signature!) } });
    if (exists) continue;
    const rec: InflightRecord = {
      kind: (t.side === "sell" ? "copy_sell" : "copy_buy") as InflightKind,
      signature: t.signature!,
      agentId: t.agentId,
      owner: t.agent.depositAddress,
      lastValidBlockHeight: (height ?? 0) + RECOVERY_EXPIRY_BLOCKS,
      sentAt: t.createdAt.getTime(),
      mint: t.mint,
      tradeId: t.id,
      traderId: t.traderId ?? undefined,
      symbol: t.symbol,
      decimals: t.decimals,
      refMs: null,
    };
    if (t.side === "sell" && t.traderId) {
      const pos = await prisma.position.findUnique({ where: { agentId_traderId_mint: { agentId: t.agentId, traderId: t.traderId, mint: t.mint } } });
      rec.positionId = pos?.id;
    }
    await prisma.kv.create({ data: journalRow(rec) }).catch(() => undefined);
  }

  // Parked sell retries resume from their Kv record; a row without one can't be resumed.
  const retrying = await prisma.copyTrade.findMany({ where: { status: "retrying" }, select: { id: true } });
  let orphanRetries = 0;
  for (const r of retrying) {
    const rec = await prisma.kv.findUnique({ where: { key: `sellretry:${r.id}` } });
    if (!rec) {
      orphanRetries++;
      await prisma.copyTrade.update({ where: { id: r.id }, data: { status: "failed", reason: "interrupted by worker restart (exit not retried)" } });
    }
  }

  const sweeps = await prisma.feeSweep.updateMany({
    where: { status: "pending" },
    data: { status: "failed", error: "interrupted by worker restart (nothing was sent)" },
  });
  const sentSweeps = await prisma.feeSweep.findMany({ where: { status: "sent", signature: { not: null } }, include: { agent: true } });
  for (const s of sentSweeps) {
    if (await prisma.kv.findUnique({ where: { key: inflightKey(s.signature!) } })) continue;
    const rec: InflightRecord = {
      kind: "fee_sweep",
      signature: s.signature!,
      agentId: s.agentId,
      owner: s.agent.depositAddress,
      lastValidBlockHeight: (height ?? 0) + RECOVERY_EXPIRY_BLOCKS,
      sentAt: s.createdAt.getTime(),
      feeSweepId: s.id,
      amountSol: s.amountSol,
      to: config.platformFeeWallet,
    };
    await prisma.kv.create({ data: journalRow(rec) }).catch(() => undefined);
  }
  const cmds = await prisma.command.updateMany({
    where: { status: "running" },
    data: {
      status: "failed",
      result: JSON.stringify({ ok: false, error: "interrupted by worker restart — check the balance before retrying" }),
      doneAt: new Date(),
    },
  });
  if (trades.count || cmds.count || sweeps.count || orphanRetries || sending.length) {
    log.warn("recovered interrupted work", {
      trades: trades.count,
      commands: cmds.count,
      feeSweeps: sweeps.count,
      retriesLost: orphanRetries,
      inFlightSwaps: sending.length,
    });
  }
}

async function main(): Promise<void> {
  validateConfig();
  log.info("starting", {
    mode: config.mode,
    rpc: redactUrl(config.rpcUrl),
    ws: config.wsUrl ? redactUrl(config.wsUrl) : "derived",
    pollMs: config.pollIntervalMs,
    maxEventAgeMs: config.maxEventAgeMs,
    copyVenue: config.copyVenue,
    platformFeeBps: config.platformFeeBps,
  });

  await prisma.$connect();
  await recoverInterrupted();
  void checkFeeWallet();

  if (config.mode === "paper") {
    const live = await prisma.agent.count({ where: { mode: "live", status: { not: "stopped" } } });
    if (live > 0) log.warn("live agents are ignored while the worker runs in paper mode", { liveAgents: live });
  }

  const stopInflight = startInflightLoop({
    copy_buy: resolveCopyBuy,
    copy_sell: resolveCopySell,
    fee_sweep: resolveFeeSweep,
    withdraw: resolveWithdraw,
  });
  const stopRetries = startSellRetryLoop(retryCopySell);
  const watcher = new Watcher(dispatchEvent);
  watcher.start();
  const stopCommands = startCommandLoop();
  const stopBalances = startBalanceLoop();
  const stopSweeps = config.mode === "live" ? startFeeSweepLoop() : () => undefined;
  const stopHoldings = config.mode === "live" ? startHoldingsLoop() : () => undefined;
  const stopFomo = startFomoIndexer(); // FOMO on-chain indexer (src/worker/fomo); no-op without HELIUS_API_KEY

  const sealPublicKey = config.mode === "live" ? workerSealPublicKey() : "";
  const beat = () =>
    kvSet("worker:heartbeat", {
      at: new Date().toISOString(),
      mode: config.mode,
      watching: watcher.size,
      watchTransport: watcher.transport,
      // Public: the web refuses to create live agents sealed to any other key (finding F12).
      ...(sealPublicKey ? { sealPublicKey } : {}),
    }).catch((err: unknown) => log.warn("heartbeat failed", { err: errText(err) }));
  void beat();
  const heartbeat = setInterval(beat, HEARTBEAT_MS);

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) {
      log.warn("second signal, exiting now (signed transactions are settled from the chain on the next start)");
      process.exit(1);
    }
    stopping = true;
    // Queued work that has not broadcast anything stands down; sends already in flight are waited for.
    beginShutdown();
    log.info("stopping", { signal, busyAgents: pendingAgentQueues() });
    clearInterval(heartbeat);
    stopCommands();
    stopBalances();
    stopSweeps();
    stopHoldings();
    stopRetries();
    await watcher.stop().catch((err: unknown) => log.warn("watcher stop failed", { err: errText(err) }));
    await stopFomo().catch((err: unknown) => log.warn("FOMO indexer stop failed", { err: errText(err) }));
    const drained = await drainQueues(SHUTDOWN_DRAIN_MS);
    if (!drained) log.warn("gave up waiting for in-flight work; the in-flight journal settles it on the next start", { busyAgents: pendingAgentQueues() });
    stopInflight();
    // Copy-engine Helius usage (watcher, balances, fills) is metered even when the indexer is off.
    await meter.flush().catch(() => undefined);
    await prisma.$disconnect().catch(() => undefined);
    log.info("stopped");
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  // Windows: closing the console window (SIGHUP) and Ctrl+Break (SIGBREAK) take the same graceful path.
  process.on("SIGHUP", () => void shutdown("SIGHUP"));
  if (process.platform === "win32") process.on("SIGBREAK", () => void shutdown("SIGBREAK"));

  // Smoke tests / CI: run for a fixed time, then take the same graceful path as a signal
  // (Windows has no way to send SIGINT/SIGTERM to a background process).
  const exitAfterMs = Number(process.env.WORKER_EXIT_AFTER_MS ?? "");
  if (Number.isFinite(exitAfterMs) && exitAfterMs > 0) {
    setTimeout(() => void shutdown(`WORKER_EXIT_AFTER_MS=${exitAfterMs}`), exitAfterMs);
  }

  log.info("running", { exitAfterMs: exitAfterMs > 0 ? exitAfterMs : undefined });
}

process.on("unhandledRejection", (reason) => {
  log.error("unhandled rejection", { err: errText(reason) });
});

main().catch((err: unknown) => {
  console.error(err);
  fatal(`worker failed to start: ${errText(err)}`);
});
