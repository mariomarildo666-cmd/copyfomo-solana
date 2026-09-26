import type { NextRequest } from "next/server";
import { findAgent, toCommandDTO, withdrawLimits } from "@/lib/agents";
import { requireOwner } from "@/lib/auth";
import { handle, HttpError } from "@/lib/http";
import { assertSameOrigin } from "@/lib/session";
import type { CommandDTO } from "@/lib/types";
import { CommandConflictError, enqueueCommand } from "../../../_lib/commands";
import { agentRef, ok, parseBody } from "../../../_lib/request";
import { withdrawSchema } from "../../../_lib/schemas";
import { planWithdraw } from "../../../_lib/withdraw";

/**
 * POST /api/agents/[id]/withdraw — queue a withdrawal. It can only go to the agent's payout address, which is
 * the owner's signed-in wallet for wallet-owned agents (fixed at creation; there is no destination field).
 * Works in any status (including stopped) so the owner can always get funds out. The ceiling is
 * balance − platform fees owed − the live rent/fee buffer; the worker sweeps owed fees first and re-checks the
 * real balance before it sends. 409 (with the open command) while another withdrawal is in flight.
 */
export const POST = handle(async (req: NextRequest, ctx: RouteContext<"/api/agents/[id]/withdraw">) => {
  assertSameOrigin(req);
  const { id } = await ctx.params;
  const owned = await requireOwner(req, agentRef(id));
  const input = await parseBody(req, withdrawSchema);
  const agent = await findAgent(owned.id);
  if (!agent) throw new HttpError(404, "agent not found");

  const limits = await withdrawLimits(agent);
  const payload = planWithdraw(
    {
      withdrawableSol: limits.withdrawableSol,
      reserveSol: limits.reserveSol,
      feeOwedSol: limits.feeOwedSol,
      hasPositions: agent.positions.length > 0,
    },
    input,
  );
  try {
    const command = await enqueueCommand(agent.id, "withdraw", payload, {
      conflictMessage: "a withdrawal is already in progress — wait for it to finish",
    });
    return ok<{ command: CommandDTO }>({ command: toCommandDTO(command) }, 202);
  } catch (err) {
    if (err instanceof CommandConflictError) return err.toResponse();
    throw err;
  }
});
