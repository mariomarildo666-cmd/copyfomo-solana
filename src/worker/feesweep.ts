// Live platform fees: the copy engine adds each winning sell's fee to Agent.feeOwedSol (ledger.ts); this module
// transfers owed fees from the agent wallet to PLATFORM_FEE_WALLET.
//
//   - routine sweeps (loop every minute, and soon after a fee accrues): when owed ≥ FEE_SWEEP_MIN_SOL, keeping
//     the agent's reserve (max(minReserveSol, the sell reserve)) in the wallet so copying and exits keep working;
//   - forced sweep before every withdrawal (commands.ts): any amount, keeping only what the withdrawal itself needs;
//   - a sweep is a FeeSweep row: "pending" → signed: "sent" + signature + in-flight journal record → "confirmed"
//     (owed −= amount, feesPaidSol += amount) or "failed". An unsettled sweep blocks new ones for that agent (never
//     two transfers for the same debt); inflight.ts settles it from the chain after a restart / unconfirmed send;
//   - owed fees are never spendable or withdrawable (executor sizes buys from balance − owed; withdrawals send at
//     most balance − owed − buffer).
// Paper agents never sweep: their fees are deducted from paperSol at the sell.

import type { Agent } from "@prisma/client";
import { config } from "@/lib/config";
import { prisma } from "@/lib/db";
import { floorLamportsSol, LIVE_WITHDRAW_BUFFER_SOL, planFeeSweep, type FeeSweepPlan } from "@/lib/fees";
import { getSolBalance, LAMPORTS_PER_SOL } from "@/lib/solana";
import { requestBalanceRefresh } from "./balances";
import { dropJournal, inflightKey, journalRow, markActive, markDone, type InflightRecord, type InflightResolution } from "./inflight";
import { errText, logger } from "./log";
import { enqueueForAgent, isShuttingDown } from "./queue";
import { buildTransferTx, SendError, signAndSend } from "./send";
import { liveSellReserveSol } from "./sizing";
import { forEachLimit } from "./util";
import { withAgentSigner, workerHandlesMode } from "./wallet";

const log = logger("fees");
const LOOP_MS = 60_000;
const REQUEST_DELAY_MS = 5_000;

export type SweepResult =
  | { swept: number; signature: string; status: "confirmed" | "sent" }
  | { swept: 0; skip: FeeSweepPlan["skip"] | "no_fee_wallet" | "paper" | "unsettled_sweep" | "failed"; error?: string };

type SweepAgent = Pick<Agent, "id" | "name" | "mode" | "depositAddress" | "ownerWallet" | "sealedSecret" | "minReserveSol">;

/** Reserve a routine sweep leaves: never starve copying or exits to pay the platform. */
export function routineSweepReserveSol(agent: Pick<Agent, "minReserveSol">): number {
  return Math.max(agent.minReserveSol, liveSellReserveSol(config.maxPriorityFeeLamports), LIVE_WITHDRAW_BUFFER_SOL);
}

/** Settle a landed sweep: FeeSweep confirmed, owed −= amount (never below 0), paid += amount, journal dropped. */
async function settleConfirmed(feeSweepId: string, agentId: string, amountSol: number, signature: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const sweep = await tx.feeSweep.findUnique({ where: { id: feeSweepId } });
    if (!sweep || sweep.status === "confirmed") return;
    await tx.feeSweep.update({ where: { id: feeSweepId }, data: { status: "confirmed", signature, error: null } });
    const agent = await tx.agent.findUnique({ where: { id: agentId }, select: { feeOwedSol: true, feesPaidSol: true } });
    if (agent) {
      await tx.agent.update({
        where: { id: agentId },
        data: { feeOwedSol: Math.max(0, floorLamportsSol(agent.feeOwedSol - amountSol)), feesPaidSol: agent.feesPaidSol + amountSol },
      });
    }
    await tx.kv.deleteMany({ where: { key: inflightKey(signature) } });
  });
}

async function settleFailed(feeSweepId: string, error: string, signature: string | null): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.feeSweep.updateMany({ where: { id: feeSweepId, status: { in: ["pending", "sent"] } }, data: { status: "failed", error: error.slice(0, 200) } });
    if (signature) await tx.kv.deleteMany({ where: { key: inflightKey(signature) } });
  });
}

/**
 * Transfer owed fees of one live agent to PLATFORM_FEE_WALLET. Must run on the agent's queue.
 *   force: sweep any amount (before a withdrawal); otherwise only once owed ≥ FEE_SWEEP_MIN_SOL.
 *   reserveSol: SOL that must stay in the wallet.
 */
export async function sweepFees(agent: SweepAgent, opts: { force: boolean; reserveSol: number }): Promise<SweepResult> {
  if (agent.mode !== "live") return { swept: 0, skip: "paper" };
  const feeWallet = config.platformFeeWallet;
  if (!feeWallet) return { swept: 0, skip: "no_fee_wallet" };
  const unsettled = await prisma.feeSweep.count({ where: { agentId: agent.id, status: { in: ["pending", "sent"] } } });
  if (unsettled > 0) return { swept: 0, skip: "unsettled_sweep" };

  const fresh = await prisma.agent.findUnique({ where: { id: agent.id }, select: { feeOwedSol: true } });
  if (!fresh || !(fresh.feeOwedSol > 0)) return { swept: 0, skip: "nothing_owed" };
  const balanceSol = await getSolBalance(agent.depositAddress);
  const plan = planFeeSweep({ balanceSol, feeOwedSol: fresh.feeOwedSol, minSweepSol: config.feeSweepMinSol, force: opts.force, reserveSol: opts.reserveSol });
  if (plan.skip !== null) return { swept: 0, skip: plan.skip };

  const amountSol = plan.amountSol;
  const lamports = BigInt(Math.round(amountSol * LAMPORTS_PER_SOL));
  const sweep = await prisma.feeSweep.create({ data: { agentId: agent.id, amountSol, status: "pending" } });
  const sent: { sig: string | null } = { sig: null };
  try {
    const landed = await withAgentSigner(agent, async (signer) => {
      const tx = await buildTransferTx(signer.publicKey, feeWallet, lamports);
      return signAndSend(tx, signer, {
        onSigned: async ({ signature: sig, lastValidBlockHeight }) => {
          sent.sig = sig;
          markActive(sig);
          const rec: InflightRecord = {
            kind: "fee_sweep",
            signature: sig,
            agentId: agent.id,
            owner: agent.depositAddress,
            lastValidBlockHeight,
            sentAt: Date.now(),
            feeSweepId: sweep.id,
            amountSol,
            to: feeWallet,
          };
          const row = journalRow(rec);
          await prisma.$transaction([
            prisma.feeSweep.update({ where: { id: sweep.id }, data: { status: "sent", signature: sig } }),
            prisma.kv.upsert({ where: { key: row.key }, create: row, update: { value: row.value } }),
          ]);
        },
      });
    });
    await settleConfirmed(sweep.id, agent.id, amountSol, landed.signature);
    log.info("platform fee swept", { agent: agent.name, sol: amountSol.toFixed(9), sig: landed.signature });
    return { swept: amountSol, signature: landed.signature, status: "confirmed" };
  } catch (err) {
    if (err instanceof SendError && err.outcome === "unconfirmed" && err.signature) {
      log.warn("fee sweep unconfirmed; settled from the chain later", { agent: agent.name, sig: err.signature });
      return { swept: amountSol, signature: err.signature, status: "sent" };
    }
    const message = errText(err, 160);
    await settleFailed(sweep.id, message, sent.sig).catch(() => undefined);
    log.warn("fee sweep failed", { agent: agent.name, err: message });
    return { swept: 0, skip: "failed", error: message };
  } finally {
    if (sent.sig) markDone(sent.sig);
    requestBalanceRefresh(agent.id);
  }
}

/** inflight.ts handler: settle a sweep left open by a restart or an unconfirmed send. */
export async function resolveFeeSweep(rec: InflightRecord, res: InflightResolution): Promise<void> {
  if (!rec.feeSweepId) {
    await dropJournal(rec.signature);
    return;
  }
  if (res.state === "landed") await settleConfirmed(rec.feeSweepId, rec.agentId, rec.amountSol ?? 0, rec.signature);
  else await settleFailed(rec.feeSweepId, res.state === "failed" ? "failed on-chain" : "did not land (expired)", rec.signature);
  requestBalanceRefresh(rec.agentId);
}

const requested = new Set<string>();
let wake: (() => void) | null = null;

/** Sweep this agent soon (a fee just accrued). Never throws. */
export function requestFeeSweep(agentId: string): void {
  requested.add(agentId);
  const w = wake;
  if (w) setTimeout(w, REQUEST_DELAY_MS).unref();
}

async function sweepPass(): Promise<void> {
  if (!config.platformFeeWallet || isShuttingDown()) return;
  requested.clear();
  const due = await prisma.agent.findMany({
    where: { mode: "live", feeOwedSol: { gte: config.feeSweepMinSol } },
    select: { id: true, name: true, mode: true, depositAddress: true, ownerWallet: true, sealedSecret: true, minReserveSol: true },
  });
  const agents = due.filter((a) => workerHandlesMode(a.mode));
  await forEachLimit(agents, 2, (a) =>
    enqueueForAgent(a.id, () => sweepFees(a, { force: false, reserveSol: routineSweepReserveSol(a) })).then(
      () => undefined,
      (err: unknown) => log.warn("fee sweep crashed", { agent: a.name, err: errText(err) }),
    ),
  );
}

/** Starts the routine sweep loop (live mode). Returns a stop function. */
export function startFeeSweepLoop(): () => void {
  let stopped = false;
  let running = false;
  let timer: NodeJS.Timeout | undefined;
  const tick = async () => {
    if (stopped || running) return;
    running = true;
    clearTimeout(timer);
    try {
      await sweepPass();
    } catch (err) {
      log.warn("fee sweep pass failed", { err: errText(err) });
    } finally {
      running = false;
    }
    if (!stopped) timer = setTimeout(() => void tick(), LOOP_MS);
  };
  wake = () => void tick();
  timer = setTimeout(() => void tick(), REQUEST_DELAY_MS);
  return () => {
    stopped = true;
    wake = null;
    clearTimeout(timer);
  };
}
