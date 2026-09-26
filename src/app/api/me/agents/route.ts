import { listMyAgents } from "@/lib/agents";
import { requireSession } from "@/lib/session";
import type { MyAgentsDTO } from "@/lib/types";
import { getHandler, ok } from "../../_lib/request";

/** GET /api/me/agents — agents owned by the signed-in wallet, newest first (stored balances; no RPC). 401 if signed out. */
export const GET = getHandler(async (req) => {
  const wallet = requireSession(req);
  return ok<MyAgentsDTO>({ agents: await listMyAgents(wallet) });
});
