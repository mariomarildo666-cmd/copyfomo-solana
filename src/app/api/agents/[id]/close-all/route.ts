import type { NextRequest } from "next/server";
import { toCommandDTO } from "@/lib/agents";
import { requireOwner } from "@/lib/auth";
import { handle } from "@/lib/http";
import { assertSameOrigin } from "@/lib/session";
import type { CommandDTO } from "@/lib/types";
import { CommandConflictError, enqueueCommand } from "../../../_lib/commands";
import { agentRef, ok, parseBody } from "../../../_lib/request";
import { emptySchema } from "../../../_lib/schemas";

/**
 * POST /api/agents/[id]/close-all — queue "sell every open position into SOL". No body.
 * Exclusive per agent so two overlapping close-alls can never race to sell the same sleeve; a conflict is
 * 409 { error, command } with the one still running.
 */
export const POST = handle(async (req: NextRequest, ctx: RouteContext<"/api/agents/[id]/close-all">) => {
  assertSameOrigin(req);
  const { id } = await ctx.params;
  const agent = await requireOwner(req, agentRef(id));
  await parseBody(req, emptySchema, { optional: true });
  try {
    const command = await enqueueCommand(agent.id, "close_all", {}, {
      conflictMessage: "positions are already being closed — wait for it to finish",
    });
    return ok<{ command: CommandDTO }>({ command: toCommandDTO(command) }, 202);
  } catch (err) {
    if (err instanceof CommandConflictError) return err.toResponse();
    throw err;
  }
});
