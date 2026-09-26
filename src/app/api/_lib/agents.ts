// Agent helpers shared by the owner routes.

import type { Agent } from "@prisma/client";
import { agentBalanceSol, findAgent, toAgentDTO } from "@/lib/agents";
import { config } from "@/lib/config";
import { HttpError } from "@/lib/http";
import type { AgentDTO } from "@/lib/types";

/**
 * Re-read with relations after a write and map to the OWNER view (owner-only fields, fresh balance). Only call
 * it from routes that already passed requireOwner / created the agent for the session wallet.
 */
export async function ownerAgentDTO(id: string): Promise<AgentDTO> {
  const a = await findAgent(id);
  if (!a) throw new HttpError(404, "agent not found");
  return toAgentDTO(a, { isOwner: true });
}

export function assertNotStopped(a: Pick<Agent, "status">): void {
  if (a.status === "stopped") throw new HttpError(409, "this agent is stopped for good — create a new one to copy again");
}

/** Has the agent received its minimum first deposit? (paper: virtual balance; live: on-chain, ≤ 20s stale) */
export async function isFunded(a: Agent): Promise<boolean> {
  return (await agentBalanceSol(a)) >= config.minDepositSol;
}
