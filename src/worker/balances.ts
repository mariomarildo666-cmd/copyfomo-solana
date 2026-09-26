// Live agents: keep the on-chain SOL balance (Agent.lastBalanceSol / balanceAt) fresh and activate agents
// waiting for their first deposit. Paper balances are handled by the paper-deposit API.
//
// Cadence (design §5.8, schedule.ts): awaiting_deposit every 30 s, active/paused every 300 s, plus a forced
// refresh after each live fill or withdrawal (requestBalanceRefresh). A balance the web process refreshed
// recently (agentBalanceSol) counts, so a watched dashboard does not double the RPC traffic.
//
// Deposits: the web relays wallet-signed deposits (Deposit rows) and activates the agent when one confirms; a
// deposit whose confirmation timed out stays "submitted" — this loop settles it from the chain. SOL sent to the
// deposit address by hand is simply seen in the balance. Either way an agent is switched on only once its sealed
// key has been proven to open here (sealcheck.ts, finding F12); an agent whose key can't be opened is paused.

import { config } from "@/lib/config";
import { prisma } from "@/lib/db";
import { getSolBalance } from "@/lib/solana";
import { errText, logger } from "./log";
import { balanceRefreshDue } from "./schedule";
import { verifyAgentKey } from "./sealcheck";
import { lookupSignature } from "./send";
import { forEachLimit, RpcLimiter } from "./util";

const log = logger("balances");
/** How often the loop looks for due agents (a DB query only; RPC calls follow the per-status cadence). */
const TICK_MS = 5_000;
/** A forced refresh waits this long so a burst of fills costs one RPC call. */
const REQUEST_DEBOUNCE_MS = 1_500;
const CONCURRENCY = 4;
/** "submitted" deposits older than this are looked up on-chain; not found after DEPOSIT_GIVE_UP_MS → failed. */
const DEPOSIT_CHECK_AFTER_MS = 20_000;
const DEPOSIT_GIVE_UP_MS = 5 * 60_000;

const limiter = new RpcLimiter(CONCURRENCY, (ms) => log.warn("rate limited, backing off", { ms }));
const requested = new Set<string>();
let wake: (() => void) | null = null;
/** Agents whose sealed key opened in this process (checked once each). */
const keyOk = new Set<string>();
const keyBad = new Set<string>();

/** Refresh this live agent's balance soon (after a fill, a close-all or a withdrawal). Never throws. */
export function requestBalanceRefresh(agentId: string): void {
  requested.add(agentId);
  const w = wake;
  if (w) setTimeout(w, REQUEST_DEBOUNCE_MS).unref();
}

async function keyUsable(a: {
  id: string;
  name: string;
  status: string;
  sealedSecret: string;
  depositAddress: string;
  ownerWallet: string | null;
}): Promise<boolean> {
  if (keyOk.has(a.id)) return true;
  if (keyBad.has(a.id)) return false;
  const res = await verifyAgentKey(a);
  if (res.ok) {
    keyOk.add(a.id);
    return true;
  }
  keyBad.add(a.id);
  const paused = a.status === "active" ? await prisma.agent.updateMany({ where: { id: a.id, status: "active" }, data: { status: "paused" } }) : null;
  log.error("agent key cannot be opened by this worker — deposits to it are unusable until fixed (check the seal key pair)", {
    agent: a.name,
    paused: paused?.count === 1,
    err: res.error,
  });
  return false;
}

/** Settle wallet-signed deposits whose relay timed out ("submitted") from the chain. */
async function settleSubmittedDeposits(now: number): Promise<Set<string>> {
  const touched = new Set<string>();
  const rows = await prisma.deposit.findMany({
    where: { status: "submitted", createdAt: { lt: new Date(now - DEPOSIT_CHECK_AFTER_MS) }, agent: { mode: "live" } },
    select: { id: true, agentId: true, signature: true, createdAt: true },
    take: 50,
  });
  for (const d of rows) {
    const s = await lookupSignature(d.signature);
    if (s.state === "landed") {
      await prisma.deposit.updateMany({ where: { id: d.id, status: "submitted" }, data: { status: "confirmed", confirmedAt: new Date(), error: null } });
      touched.add(d.agentId);
    } else if (s.state === "failed") {
      await prisma.deposit.updateMany({ where: { id: d.id, status: "submitted" }, data: { status: "failed", error: "failed on-chain (nothing was transferred)" } });
    } else if (s.state === "missing" && now - d.createdAt.getTime() > DEPOSIT_GIVE_UP_MS) {
      await prisma.deposit.updateMany({ where: { id: d.id, status: "submitted" }, data: { status: "failed", error: "did not land (nothing was transferred)" } });
    }
  }
  return touched;
}

async function refreshOnce(): Promise<void> {
  // A paper-mode worker never touches live agents.
  if (config.mode !== "live") return;
  const now = Date.now();
  const forced = new Set(requested);
  requested.clear();
  try {
    for (const id of await settleSubmittedDeposits(now)) forced.add(id);
  } catch (err) {
    log.warn("deposit settlement failed", { err: errText(err) });
  }
  const agents = await prisma.agent.findMany({
    where: { mode: "live", status: { in: ["awaiting_deposit", "active", "paused"] } },
    select: { id: true, name: true, depositAddress: true, ownerWallet: true, sealedSecret: true, status: true, lastBalanceSol: true, balanceAt: true },
  });
  await forEachLimit(agents, CONCURRENCY, async (a) => {
    try {
      let sol: number | null = a.balanceAt ? a.lastBalanceSol : null;
      if (forced.has(a.id) || balanceRefreshDue(a.status, a.balanceAt, now)) {
        sol = await limiter.run(() => getSolBalance(a.depositAddress));
        await prisma.agent.update({ where: { id: a.id }, data: { lastBalanceSol: sol, balanceAt: new Date() } });
      }
      const usable = await keyUsable(a);
      if (usable && a.status === "awaiting_deposit" && sol !== null && sol >= config.minDepositSol) {
        // Conditional update: the owner may have changed the status meanwhile.
        const flipped = await prisma.agent.updateMany({
          where: { id: a.id, status: "awaiting_deposit" },
          data: { status: "active" },
        });
        if (flipped.count === 1) log.info("deposit received, agent active", { agent: a.name, sol: sol.toFixed(4) });
      }
    } catch (err) {
      log.warn("balance refresh failed", { agent: a.name, err: errText(err) });
    }
  });
}

/** Starts the balance loop (per-status cadence, see schedule.ts). Returns a stop function. */
export function startBalanceLoop(): () => void {
  let stopped = false;
  let running = false;
  let timer: NodeJS.Timeout | undefined;
  const tick = async () => {
    if (stopped || running) return;
    running = true;
    clearTimeout(timer);
    try {
      await refreshOnce();
    } catch (err) {
      log.warn("balance loop failed", { err: errText(err) });
    } finally {
      running = false;
    }
    if (!stopped) timer = setTimeout(() => void tick(), requested.size > 0 ? REQUEST_DEBOUNCE_MS : TICK_MS);
  };
  wake = () => void tick();
  void tick();
  return () => {
    stopped = true;
    wake = null;
    clearTimeout(timer);
  };
}
