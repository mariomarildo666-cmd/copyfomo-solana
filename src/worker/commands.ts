// Owner commands (withdraw / close_all) enqueued by the web process. Polled every 2s, claimed atomically
// (pending → running), executed on the agent's serial queue, then marked done/failed with a JSON result.
//
// Withdrawals only ever go to the wallet that owns the agent (ownerWallet, the signed-in wallet; legacy agents
// without one: the payoutAddress fixed at creation). A row whose payoutAddress disagrees with its ownerWallet is
// refused (tampered or corrupt). Order of a live withdrawal:
//   1. optional close-all (sell every sleeve; untracked explainable tokens are adopted and sold too)
//   2. reclaim the rent of empty token accounts (rent.ts)
//   3. sweep owed platform fees to PLATFORM_FEE_WALLET (forced, any amount) — the platform's share never leaves
//      with the owner
//   4. transfer at most balance − fees still owed − reserve, where reserve = the sell reserve while the wallet still
//      holds tokens (so their exits can pay for themselves, finding F7), else LIVE_WITHDRAW_BUFFER_SOL; a full
//      withdrawal of an empty wallet with nothing owed sends everything but the network fee (finding F47).
// Every transfer is journaled before broadcast (inflight.ts), so an unconfirmed or interrupted one is settled from
// the chain later.

import type { Agent, Command } from "@prisma/client";
import { PublicKey } from "@solana/web3.js";
import { z } from "zod";
import { config } from "@/lib/config";
import { prisma } from "@/lib/db";
import { LIVE_WITHDRAW_BUFFER_SOL } from "@/lib/fees";
import { accountRejection } from "@/lib/infra";
import { connection, isValidSolanaAddress, LAMPORTS_PER_SOL } from "@/lib/solana";
import { requestBalanceRefresh } from "./balances";
import { sellAllPositions, type CloseAllResult } from "./executor";
import { sweepFees, type SweepResult } from "./feesweep";
import { holdingsFrom } from "./holdings";
import { dropJournal, inflightKey, journalRow, markActive, markDone, type InflightRecord, type InflightResolution } from "./inflight";
import { errText, logger } from "./log";
import { enqueueForAgent, isShuttingDown } from "./queue";
import { closeEmptyTokenAccounts, listTokenAccounts, type RentReclaim } from "./rent";
import { buildTransferTx, SendError, signAndSend, TRANSFER_FEE_LAMPORTS } from "./send";
import { liveSellReserveSol } from "./sizing";
import { withAgentSigner, workerHandlesMode } from "./wallet";

const log = logger("cmds");

const POLL_MS = 2000;
const BATCH = 20;
/** Smallest withdrawal worth a transaction. */
const MIN_WITHDRAW_SOL = 0.000001;
const EPS = 1e-9;

const withdrawPayloadSchema = z.object({
  amountSol: z.number().finite().positive().optional(),
  all: z.boolean().optional(),
  closePositions: z.boolean().optional(),
});
type WithdrawPayload = z.infer<typeof withdrawPayloadSchema>;

type CommandResult = { ok: true; [k: string]: unknown } | { ok: false; error: string; [k: string]: unknown };

function round9(n: number): number {
  return Math.round(n * 1e9) / 1e9;
}

function closeSummary(r: CloseAllResult) {
  return { sold: r.sold, skipped: r.skipped, failed: r.failed, pending: r.pending, proceedsSol: round9(r.proceedsSol), errors: r.errors.slice(0, 10) };
}

function rentSummary(r: RentReclaim) {
  return { closed: r.closed, failed: r.failed, reclaimedSol: round9(r.reclaimedSol), errors: r.errors.slice(0, 5) };
}

/**
 * Where a withdrawal of this agent may go: its owner wallet (legacy: the payout address fixed at creation).
 * Refuses rows whose payout disagrees with the owner wallet, and invalid / self destinations.
 */
export function withdrawDestination(agent: Pick<Agent, "ownerWallet" | "payoutAddress" | "depositAddress">): { to: string } | { error: string } {
  if (agent.ownerWallet && agent.payoutAddress !== agent.ownerWallet) {
    return { error: "payout address does not match the owner wallet — withdrawal refused" };
  }
  const to = agent.ownerWallet ?? agent.payoutAddress;
  if (!isValidSolanaAddress(to) || to === agent.depositAddress) return { error: "payout address is invalid" };
  if (config.platformFeeWallet && to === config.platformFeeWallet) return { error: "payout address is invalid" };
  return { to };
}

/**
 * Live only: close the agent's empty token accounts (rent back to the agent wallet). Never throws — a failure
 * is reported in the command result and the withdrawal / close-all carries on.
 */
async function reclaimRent(agent: Agent): Promise<ReturnType<typeof rentSummary> | null> {
  if (agent.mode !== "live") return null;
  try {
    return rentSummary(await withAgentSigner(agent, (signer) => closeEmptyTokenAccounts(signer)));
  } catch (err) {
    log.warn("token account cleanup failed", { agent: agent.name, err: errText(err) });
    return { closed: 0, failed: 0, reclaimedSol: 0, errors: [errText(err, 120)] };
  }
}

async function closeAll(agent: Agent): Promise<CommandResult> {
  const r = await sellAllPositions(agent);
  const rent = await reclaimRent(agent);
  if (agent.mode === "live") requestBalanceRefresh(agent.id);
  const extra = rent ? { rent } : {};
  if (r.failed > 0) return { ok: false, error: `${r.failed} position(s) could not be sold`, ...closeSummary(r), ...extra };
  if (r.pending > 0) return { ok: true, warning: `${r.pending} sell(s) still confirming`, ...closeSummary(r), ...extra };
  return { ok: true, ...closeSummary(r), ...extra };
}

async function withdrawPaper(agent: Agent, p: WithdrawPayload, to: string, clampAmount: boolean): Promise<CommandResult> {
  const available = agent.paperSol;
  const requested = p.all ? available : (p.amountSol ?? 0);
  // A set amount after a close-all is capped at what the sale left (the proceeds weren't known when it was asked).
  const clamped = clampAmount && !p.all && requested > available + EPS;
  const amount = clamped ? available : requested;
  if (!(amount >= MIN_WITHDRAW_SOL)) return { ok: false, error: "nothing to withdraw" };
  if (amount > available + EPS) return { ok: false, error: `insufficient balance (available ${round9(available)} SOL)` };
  const debited = await prisma.agent.updateMany({
    where: { id: agent.id, paperSol: { gte: amount - EPS } },
    data: { paperSol: { decrement: amount } },
  });
  if (debited.count !== 1) return { ok: false, error: "insufficient balance" };
  return { ok: true, mode: "paper", simulated: true, amountSol: round9(amount), to, ...(clamped ? { requestedSol: round9(requested), clamped: true } : {}) };
}

export interface LiveWithdrawPlan {
  /** Lamports to send (0 = nothing). */
  lamports: bigint;
  /** What stays in the wallet besides fees owed. */
  reserveSol: number;
  drain: boolean;
  error: string | null;
}

/**
 * Pure: what a live withdrawal may send.
 *   all: balance − owed − reserve, or — nothing held, nothing owed, no token accounts left — everything but the fee.
 *   amount: must fit under the same ceiling.
 */
export function planLiveWithdraw(p: {
  balanceLamports: bigint;
  feeOwedSol: number;
  holdsTokens: boolean;
  tokenAccountsLeft: number;
  /** Fee sweeps not settled yet (one may still land): never drain under them. */
  unsettledSweeps: number;
  all: boolean;
  amountSol: number | null;
  sellReserveSol: number;
  /** A set amount above the ceiling is lowered to it instead of refused (after a close-all, finding F37). */
  clampToMax?: boolean;
}): LiveWithdrawPlan {
  const reserveSol = p.holdsTokens ? Math.max(p.sellReserveSol, LIVE_WITHDRAW_BUFFER_SOL) : LIVE_WITHDRAW_BUFFER_SOL;
  // Fees are whole lamports; round away float noise so a fully swept debt reads as 0.
  const owedLamports = BigInt(Math.max(0, Math.round(p.feeOwedSol * LAMPORTS_PER_SOL)));
  const drain = p.all && !p.holdsTokens && p.tokenAccountsLeft === 0 && p.unsettledSweeps === 0 && owedLamports === BigInt(0);
  const fee = BigInt(TRANSFER_FEE_LAMPORTS);
  let max = drain
    ? p.balanceLamports - fee
    : p.balanceLamports - owedLamports - BigInt(Math.ceil(reserveSol * LAMPORTS_PER_SOL));
  if (max < BigInt(0)) max = BigInt(0);
  const minLamports = BigInt(Math.ceil(MIN_WITHDRAW_SOL * LAMPORTS_PER_SOL));
  if (p.all) {
    if (max < minLamports) return { lamports: BigInt(0), reserveSol, drain, error: "nothing to withdraw" };
    return { lamports: max, reserveSol, drain, error: null };
  }
  const want = BigInt(Math.floor((p.amountSol ?? 0) * LAMPORTS_PER_SOL + 1e-6));
  if (want < minLamports) return { lamports: BigInt(0), reserveSol, drain, error: "nothing to withdraw" };
  if (want > max && p.clampToMax && max >= minLamports) return { lamports: max, reserveSol, drain, error: null };
  if (want > max) {
    const why = p.feeOwedSol > 0 ? `; ${round9(p.feeOwedSol)} SOL of platform fees owed and ` : "; ";
    return {
      lamports: BigInt(0),
      reserveSol,
      drain,
      error: `insufficient balance (max ${round9(Number(max) / LAMPORTS_PER_SOL)} SOL${why}${reserveSol} SOL stays for ${p.holdsTokens ? "selling the open positions" : "rent + fee"})`,
    };
  }
  return { lamports: want, reserveSol, drain, error: null };
}

function sweepSummary(s: SweepResult | null) {
  if (!s) return undefined;
  return "skip" in s ? { swept: 0, skipped: s.skip } : { swept: round9(s.swept), signature: s.signature, status: s.status };
}

/**
 * The destination must be a plain wallet (finding F15): an account that does not exist yet, or one owned by the
 * System program and not executable. SOL sent to a mint, a token account or a program-owned account is gone.
 * Fails closed when the account cannot be read.
 */
async function payoutRejection(to: string): Promise<string | null> {
  let info: Awaited<ReturnType<ReturnType<typeof connection>["getMultipleAccountsInfo"]>>[number];
  try {
    [info] = await connection().getMultipleAccountsInfo([new PublicKey(to)], "confirmed");
  } catch (err) {
    return `could not check the payout wallet (${errText(err, 80)}) — nothing was sent; try again`;
  }
  const why = accountRejection(info ? { owner: info.owner.toBase58(), executable: info.executable, space: info.data?.length ?? null } : null);
  return why ? "payout is not a plain wallet — withdrawal refused" : null;
}

async function withdrawLive(
  agent: Agent,
  p: WithdrawPayload,
  to: string,
  cmdId: string,
  holdsTokens: boolean,
  tokenAccountsLeft: number,
  clampAmount: boolean,
): Promise<CommandResult> {
  const payoutProblem = await payoutRejection(to);
  if (payoutProblem) {
    log.error("withdrawal refused", { agent: agent.name, err: payoutProblem });
    return { ok: false, error: payoutProblem };
  }
  const sellReserveSol = liveSellReserveSol(config.maxPriorityFeeLamports);
  // 3. The platform's share first (any amount), leaving what the withdrawal itself needs.
  let sweep: SweepResult | null = null;
  try {
    sweep = await sweepFees(agent, { force: true, reserveSol: holdsTokens ? sellReserveSol : LIVE_WITHDRAW_BUFFER_SOL });
  } catch (err) {
    log.warn("fee sweep before withdrawal failed", { agent: agent.name, err: errText(err) });
  }
  const fresh = await prisma.agent.findUnique({ where: { id: agent.id }, select: { feeOwedSol: true } });
  const unsettled = await prisma.feeSweep.count({ where: { agentId: agent.id, status: { in: ["pending", "sent"] } } });
  const balanceLamports = BigInt(await connection().getBalance(new PublicKey(agent.depositAddress), "confirmed"));
  const plan = planLiveWithdraw({
    balanceLamports,
    feeOwedSol: fresh?.feeOwedSol ?? 0,
    holdsTokens,
    tokenAccountsLeft,
    unsettledSweeps: unsettled,
    all: p.all === true,
    amountSol: p.amountSol ?? null,
    sellReserveSol,
    clampToMax: clampAmount,
  });
  const fees = { sweep: sweepSummary(sweep), owedSol: round9(fresh?.feeOwedSol ?? 0) };
  if (plan.error) return { ok: false, error: plan.error, fees };

  const amountSol = Number(plan.lamports) / LAMPORTS_PER_SOL;
  const requestedSol = !p.all && p.amountSol !== undefined ? p.amountSol : null;
  const clampInfo = requestedSol !== null && amountSol + EPS < requestedSol ? { requestedSol: round9(requestedSol), clamped: true } : {};
  const sent: { sig: string | null } = { sig: null };
  try {
    const landed = await withAgentSigner(agent, async (signer) => {
      const tx = await buildTransferTx(signer.publicKey, to, plan.lamports);
      return signAndSend(tx, signer, {
        onSigned: async ({ signature, lastValidBlockHeight }) => {
          sent.sig = signature;
          markActive(signature);
          const rec: InflightRecord = {
            kind: "withdraw",
            signature,
            agentId: agent.id,
            owner: agent.depositAddress,
            lastValidBlockHeight,
            sentAt: Date.now(),
            commandId: cmdId,
            amountSol,
            to,
          };
          const row = journalRow(rec);
          await prisma.kv.upsert({ where: { key: row.key }, create: row, update: { value: row.value } });
        },
      });
    });
    await dropJournal(landed.signature);
    return { ok: true, mode: "live", amountSol: round9(amountSol), to, signature: landed.signature, fees, ...clampInfo, ...(plan.drain ? { drained: true } : {}) };
  } catch (err) {
    if (err instanceof SendError) {
      if (err.outcome === "unconfirmed" && err.signature) {
        return {
          ok: false,
          pending: true,
          error: "transfer sent; confirmation pending — the worker keeps checking (do not retry yet)",
          signature: err.signature,
          amountSol: round9(amountSol),
          to,
          fees,
        };
      }
      if (err.signature) await dropJournal(err.signature).catch(() => undefined);
      return { ok: false, error: `transfer ${err.outcome === "rejected" ? "rejected" : err.outcome} (nothing was sent)`, signature: err.signature, fees };
    }
    if (sent.sig) await dropJournal(sent.sig).catch(() => undefined);
    return { ok: false, error: `transfer failed: ${errText(err, 140)}`, fees };
  } finally {
    if (sent.sig) markDone(sent.sig);
    // Keep the dashboard balance fresh after money moved (balance loop, best effort).
    requestBalanceRefresh(agent.id);
  }
}

async function withdraw(agent: Agent, raw: unknown, cmdId: string): Promise<CommandResult> {
  const parsed = withdrawPayloadSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "invalid withdraw payload" };
  const p = parsed.data;
  if (!p.all && p.amountSol === undefined) return { ok: false, error: "amountSol or all is required" };
  const dest = withdrawDestination(agent);
  if ("error" in dest) {
    log.error("withdrawal refused", { agent: agent.name, err: dest.error });
    return { ok: false, error: dest.error };
  }

  // 1. Optional close-all, 2. rent back to the agent wallet (live) so it can be withdrawn too.
  let closed: CloseAllResult | null = null;
  if (p.closePositions) closed = await sellAllPositions(agent);
  const rent = await reclaimRent(agent);

  // Re-read: the close-all changed balances.
  const fresh = await prisma.agent.findUnique({ where: { id: agent.id } });
  if (!fresh) return { ok: false, error: "agent not found" };
  const positionsLeft = await prisma.position.count({ where: { agentId: agent.id } });

  // A set amount "after selling everything" (older queued rows; the API refuses it while positions are open,
  // finding F37): when a sell failed, send nothing — the owner asked for money from the sale, not the reserve.
  const setAmountAfterClose = p.closePositions === true && !p.all && closed !== null;
  if (setAmountAfterClose && closed && closed.failed > 0) {
    return {
      ok: false,
      error: `${closed.failed} position(s) could not be sold — nothing was withdrawn`,
      closed: closeSummary(closed),
      ...(rent ? { rent } : {}),
      positionsLeft,
      stopped: false,
    };
  }

  let res: CommandResult;
  let holdings = 0;
  if (fresh.mode === "paper") {
    res = await withdrawPaper(fresh, p, dest.to, setAmountAfterClose);
  } else {
    // What the wallet still holds on-chain (sleeves or not): while it holds tokens their sells need SOL.
    let tokenAccountsLeft = 1;
    try {
      const accounts = await listTokenAccounts(new PublicKey(fresh.depositAddress));
      tokenAccountsLeft = accounts.length;
      holdings = holdingsFrom(accounts).length;
    } catch (err) {
      holdings = Math.max(1, positionsLeft); // unknown: assume tokens are held (keeps the sell reserve)
      log.warn("could not list token accounts before withdrawal", { agent: fresh.name, err: errText(err) });
    }
    res = await withdrawLive(fresh, p, dest.to, cmdId, positionsLeft > 0 || holdings > 0, tokenAccountsLeft, setAmountAfterClose);
  }

  const leftOpen = positionsLeft > 0 || holdings > 0;
  const withClose: CommandResult = {
    ...res,
    ...(closed ? { closed: closeSummary(closed) } : {}),
    ...(rent ? { rent } : {}),
    ...(leftOpen ? { positionsLeft } : {}),
    ...(res.ok && leftOpen && p.closePositions
      ? { warning: `${Math.max(positionsLeft, holdings)} position(s) are still open; the agent keeps copying their exits` }
      : {}),
  };

  const windDown = p.all === true && p.closePositions === true;
  if (res.ok && windDown && closed && closed.failed === 0 && closed.pending === 0 && !leftOpen) {
    await prisma.agent.update({ where: { id: agent.id }, data: { status: "stopped" } });
    log.info("agent stopped after full withdrawal", { agent: fresh.name });
    return { ...withClose, stopped: true };
  }
  // "Everything + close" always says whether the agent stopped (finding F38): if not, it keeps copying exits.
  return windDown ? { ...withClose, stopped: false, positionsLeft: Math.max(positionsLeft, holdings) } : withClose;
}

/** inflight.ts handler: settle a withdrawal transfer left open by a restart or an unconfirmed send. */
export async function resolveWithdraw(rec: InflightRecord, res: InflightResolution): Promise<void> {
  if (rec.commandId) {
    const cmd = await prisma.command.findUnique({ where: { id: rec.commandId } });
    if (cmd && cmd.status !== "running") {
      const result =
        res.state === "landed"
          ? { ok: true, mode: "live", amountSol: rec.amountSol, to: rec.to, signature: rec.signature, reconciled: true }
          : { ok: false, error: res.state === "failed" ? "transfer failed on-chain (nothing was sent)" : "transfer did not land (nothing was sent)", signature: rec.signature, reconciled: true };
      await prisma.command.update({
        where: { id: cmd.id },
        data: { status: result.ok ? "done" : "failed", result: JSON.stringify(result), doneAt: new Date() },
      });
    }
  }
  await prisma.kv.deleteMany({ where: { key: inflightKey(rec.signature) } });
  requestBalanceRefresh(rec.agentId);
}

function parsePayload(payload: string): unknown {
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

/** Execute one claimed command (on the agent queue). Exported for tests. */
export async function runCommand(cmd: Command): Promise<void> {
  const clog = log.child({ cmd: cmd.id, type: cmd.type });
  let result: CommandResult;
  try {
    const agent = await prisma.agent.findUnique({ where: { id: cmd.agentId } });
    if (!agent) result = { ok: false, error: "agent not found" };
    else if (isShuttingDown()) result = { ok: false, error: "the worker is restarting — nothing was done; try again in a minute" };
    else if (cmd.type === "withdraw") result = await withdraw(agent, parsePayload(cmd.payload), cmd.id);
    else if (cmd.type === "close_all") result = await closeAll(agent);
    else result = { ok: false, error: `unknown command type "${cmd.type}"` };
  } catch (err) {
    result = { ok: false, error: errText(err, 160) };
  }
  await prisma.command.update({
    where: { id: cmd.id },
    data: { status: result.ok ? "done" : "failed", result: JSON.stringify(result), doneAt: new Date() },
  });
  if (result.ok) clog.info("command done");
  else clog.warn("command failed", { error: result.error });
}

async function pollOnce(): Promise<void> {
  const pending = await prisma.command.findMany({
    where: { status: "pending" },
    orderBy: { createdAt: "asc" },
    take: BATCH,
    include: { agent: { select: { mode: true } } },
  });
  for (const { agent, ...cmd } of pending) {
    if (!workerHandlesMode(agent.mode)) {
      const result = { ok: false, error: "this worker runs in paper mode; live agents need COPYFOMO_MODE=live" };
      await prisma.command.updateMany({
        where: { id: cmd.id, status: "pending" },
        data: { status: "failed", result: JSON.stringify(result), doneAt: new Date() },
      });
      continue;
    }
    const claimed = await prisma.command.updateMany({ where: { id: cmd.id, status: "pending" }, data: { status: "running" } });
    if (claimed.count !== 1) continue;
    log.info("command claimed", { cmd: cmd.id, type: cmd.type, agent: cmd.agentId });
    enqueueForAgent(cmd.agentId, () => runCommand(cmd)).catch((err: unknown) =>
      log.error("command task crashed", { cmd: cmd.id, err: errText(err) }),
    );
  }
}

/** Starts the 2s command poll. Returns a stop function. */
export function startCommandLoop(): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const tick = async () => {
    try {
      await pollOnce();
    } catch (err) {
      log.warn("command poll failed", { err: errText(err) });
    }
    if (!stopped) timer = setTimeout(tick, POLL_MS);
  };
  void tick();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
