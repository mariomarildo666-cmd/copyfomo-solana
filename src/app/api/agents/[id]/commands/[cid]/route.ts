import { toCommandDTO } from "@/lib/agents";
import { requireOwner } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { HttpError } from "@/lib/http";
import type { CommandDTO } from "@/lib/types";
import { agentRef, getHandler, ok } from "../../../../_lib/request";

/** GET /api/agents/[id]/commands/[cid] — owner polls a queued withdraw / close_all. */
export const GET = getHandler(async (req, ctx: RouteContext<"/api/agents/[id]/commands/[cid]">) => {
  const { id, cid } = await ctx.params;
  const agent = await requireOwner(req, agentRef(id));
  // Scoped to the agent: a key for agent A can't read agent B's commands.
  const command = /^[A-Za-z0-9_-]{1,80}$/.test(cid)
    ? await prisma.command.findFirst({ where: { id: cid, agentId: agent.id } })
    : null;
  if (!command) throw new HttpError(404, "command not found");
  return ok<{ command: CommandDTO }>({ command: toCommandDTO(command) });
});
