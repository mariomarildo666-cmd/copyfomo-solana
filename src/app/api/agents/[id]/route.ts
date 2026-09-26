import type { Agent, Prisma } from "@prisma/client";
import type { NextRequest } from "next/server";
import { getAgentDetail } from "@/lib/agents";
import { requireOwner } from "@/lib/auth";
import { config } from "@/lib/config";
import { prisma } from "@/lib/db";
import { handle, HttpError } from "@/lib/http";
import { clientIp, rateLimit } from "@/lib/ratelimit";
import { assertSameOrigin, requestDomain } from "@/lib/session";
import type { AgentDetailDTO, AgentDTO, AgentStatus } from "@/lib/types";
import { assertNotStopped, isFunded, ownerAgentDTO } from "../../_lib/agents";
import { agentRef, getHandler, ok, parseBody } from "../../_lib/request";
import { LIVE_MAX_SLIPPAGE_BPS, liveSlippageMessage, updateAgentSchema, type UpdateAgentBody } from "../../_lib/schemas";
import { createStepUp, riskRaisingChanges, stepUpRequired, verifyStepUp } from "../../_lib/stepup";
import { assertFollowableTraders } from "../../_lib/traderGuard";
import { followRows, resolveTraders } from "../../_lib/traders";

/**
 * GET /api/agents/[id] — agent detail by id or slug. Public view for everyone; the owner (session wallet, or a
 * legacy x-owner-key) also gets ownerWallet / payoutAddress and a fresh balance.
 */
export const GET = getHandler(async (req, ctx: RouteContext<"/api/agents/[id]">) => {
  // Dashboards poll every 5 s (12/min); 60/min per IP leaves room for a few tabs, not for scraping loops.
  rateLimit(`agent:${clientIp(req)}`, 60, 60_000);
  const { id } = await ctx.params;
  const detail = await getAgentDetail(agentRef(id), { req });
  if (!detail) throw new HttpError(404, "agent not found");
  return ok<AgentDetailDTO>(detail);
});

/**
 * PATCH /api/agents/[id] — owner updates rules, pauses/resumes, or replaces the follow list.
 * Positions opened for dropped traders are kept (close-all still sells them).
 * LIVE agents: a change that adds a wallet to copy or raises sizing / max size / slippage needs the owner's
 * wallet to sign it (428 → `confirm`, see _lib/stepup.ts); slippage is capped at LIVE_MAX_SLIPPAGE_BPS.
 */
export const PATCH = handle(async (req: NextRequest, ctx: RouteContext<"/api/agents/[id]">) => {
  assertSameOrigin(req);
  const { id } = await ctx.params;
  const agent = await requireOwner(req, agentRef(id));
  const input = await parseBody(req, updateAgentSchema);
  assertNotStopped(agent);
  if (input.traders) {
    // Each follow-list change re-points the watcher and the indexer: keep it rare (finding F14).
    rateLimit(`follow-edit:${agent.id}`, 10, 10 * 60_000);
    rateLimit(`follow-edit-ip:${clientIp(req)}`, 30, 10 * 60_000);
  }

  const live = agent.mode === "live";
  if (live && input.slippageBps !== undefined && input.slippageBps > LIVE_MAX_SLIPPAGE_BPS) {
    const msg = liveSlippageMessage();
    throw new HttpError(400, msg, { slippageBps: msg });
  }

  const follows = await prisma.follow.findMany({ where: { agentId: agent.id }, select: { trader: { select: { wallet: true } } } });
  const followed = new Set(follows.map((f) => f.trader.wallet));

  if (live) {
    const stepUp = await liveStepUp(req, agent, followed, input);
    if (stepUp) return stepUp;
  }

  const status = await nextStatus(agent, input.status);
  const traders = input.traders ? await resolveTraders(input.traders, { alreadyFollowed: followed }) : null;
  const statusChanges = status !== agent.status;

  const data: Prisma.AgentUpdateManyMutationInput = {
    sizingMode: input.sizingMode,
    fixedSol: input.fixedSol,
    maxPerTradeSol: input.maxPerTradeSol,
    slippageBps: input.slippageBps,
    copySells: input.copySells,
    status: statusChanges ? status : undefined,
    updatedAt: new Date(),
  };
  // Optimistic guard: a status change only applies to the status we validated against (the worker may
  // have just funded or stopped the agent); rule edits on a live agent only apply to the rules the owner's
  // wallet confirmed; other edits only need the agent to not be stopped.
  const where: Prisma.AgentWhereInput = {
    id: agent.id,
    ...(statusChanges ? { status: agent.status } : { status: { not: "stopped" } }),
    ...(live
      ? { sizingMode: agent.sizingMode, fixedSol: agent.fixedSol, maxPerTradeSol: agent.maxPerTradeSol, slippageBps: agent.slippageBps }
      : {}),
  };

  await prisma.$transaction(async (tx) => {
    const res = await tx.agent.updateMany({ where, data });
    if (res.count === 0) {
      throw new HttpError(409, "the agent changed while saving (funded, stopped or edited elsewhere) — reload and try again");
    }
    if (traders) {
      await tx.follow.deleteMany({ where: { agentId: agent.id } });
      await tx.follow.createMany({ data: followRows(traders).map((f) => ({ ...f, agentId: agent.id })) });
    }
  });

  return ok<{ agent: AgentDTO }>({ agent: await ownerAgentDTO(agent.id) });
});

const STEP_UP_CHALLENGES_PER_10_MIN = 20;

/**
 * Live agents: null when the change lowers risk (or is already confirmed by the owner's wallet), else the 428
 * challenge to sign. Throws 401 on a bad confirmation, 403 for legacy owner-key agents (no wallet to sign).
 */
async function liveStepUp(req: NextRequest, agent: Agent, followed: ReadonlySet<string>, input: UpdateAgentBody): Promise<Response | null> {
  const lines = riskRaisingChanges(
    { sizingMode: agent.sizingMode, fixedSol: agent.fixedSol, maxPerTradeSol: agent.maxPerTradeSol, slippageBps: agent.slippageBps, traders: [...followed] },
    {
      sizingMode: input.sizingMode,
      fixedSol: input.fixedSol,
      maxPerTradeSol: input.maxPerTradeSol,
      slippageBps: input.slippageBps,
      traders: input.traders?.map((t) => t.wallet),
    },
  );
  if (lines.length === 0) return null;
  if (!agent.ownerWallet) {
    throw new HttpError(403, "this agent has no owner wallet to confirm with — it can only lower its risk, pause or withdraw");
  }
  const domain = requestDomain(req);
  if (!input.confirm) {
    // Don't ask for a signature on something that will be refused anyway.
    if (input.traders) await assertFollowableTraders(input.traders.map((t) => t.wallet), { alreadyFollowed: followed });
    rateLimit(`stepup:${agent.id}`, STEP_UP_CHALLENGES_PER_10_MIN, 10 * 60_000);
    return stepUpRequired(await createStepUp({ domain, wallet: agent.ownerWallet, agent, lines }));
  }
  await verifyStepUp({ domain, wallet: agent.ownerWallet, agent, lines, confirm: input.confirm });
  return null;
}

/**
 * Owner-driven status transitions: active ⇄ paused. An agent awaiting its first deposit can only be
 * switched on once funded, and can't be paused (there is nothing running to pause yet).
 */
async function nextStatus(agent: Agent, requested: Extract<AgentStatus, "active" | "paused"> | undefined): Promise<string> {
  if (!requested || requested === agent.status) return agent.status;
  if (agent.status === "awaiting_deposit") {
    if (requested === "paused") {
      throw new HttpError(409, "fund the agent first — pause and resume unlock once it's active");
    }
    if (!(await isFunded(agent))) {
      throw new HttpError(409, `deposit at least ${config.minDepositSol} SOL before switching the agent on`);
    }
  }
  return requested;
}
