import { requireOwner } from "@/lib/auth";
import { agentRef, getHandler, ok } from "../../../_lib/request";

/**
 * GET /api/agents/[id]/verify — 200 when the caller owns this agent: the signed-in wallet for wallet-owned agents,
 * or (legacy agents only, ownerWallet null) a valid `x-owner-key` header. 401 / 403 otherwise.
 */
export const GET = getHandler(async (req, ctx: RouteContext<"/api/agents/[id]/verify">) => {
  const { id } = await ctx.params;
  await requireOwner(req, agentRef(id));
  return ok<{ ok: true }>({ ok: true });
});
