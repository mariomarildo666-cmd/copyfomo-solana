import { toCommandDTO } from "@/lib/agents";
import { requireOwner } from "@/lib/auth";
import type { CommandDTO } from "@/lib/types";
import { recentCommands } from "../../../_lib/commands";
import { agentRef, getHandler, ok, parseQuery } from "../../../_lib/request";
import { commandsQuery } from "../../../_lib/schemas";

/**
 * GET /api/agents/[id]/commands?type=withdraw|close_all&limit=5 — OWNER only (results carry amounts, transfer
 * signatures and errors, so they never appear in the public agent detail). Open (pending/running) commands first,
 * then the newest finished ones, so a reloaded or second-device dashboard can resume polling the one in flight
 * and still show how the last withdrawal ended (finding F39).
 */
export const GET = getHandler(async (req, ctx: RouteContext<"/api/agents/[id]/commands">) => {
  const { id } = await ctx.params;
  const agent = await requireOwner(req, agentRef(id));
  const { type, limit } = parseQuery(req, commandsQuery);
  const commands = await recentCommands(agent.id, { type, limit });
  return ok<{ commands: CommandDTO[] }>({ commands: commands.map(toCommandDTO) });
});
