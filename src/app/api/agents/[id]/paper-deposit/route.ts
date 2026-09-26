import type { NextRequest } from "next/server";
import { requireOwner } from "@/lib/auth";
import { creditPaperDeposit } from "@/lib/deposit";
import { handle } from "@/lib/http";
import { rateLimit } from "@/lib/ratelimit";
import { assertSameOrigin, readSession } from "@/lib/session";
import type { AgentDTO } from "@/lib/types";
import { assertNotStopped, ownerAgentDTO } from "../../../_lib/agents";
import { agentRef, ok, parseBody } from "../../../_lib/request";
import { paperDepositSchema } from "../../../_lib/schemas";

/**
 * POST /api/agents/[id]/paper-deposit {amountSol} — owner adds SIMULATED SOL (paper-mode agents only; nothing is
 * transferred). Recorded as a confirmed Deposit; the deposit that reaches minDepositSol switches the agent on.
 * Live agents are funded from the owner's wallet (deposit-tx → deposit-submit) or by sending SOL manually.
 */
export const POST = handle(async (req: NextRequest, ctx: RouteContext<"/api/agents/[id]/paper-deposit">) => {
  assertSameOrigin(req);
  const { id } = await ctx.params;
  const agent = await requireOwner(req, agentRef(id));
  assertNotStopped(agent);
  const { amountSol } = await parseBody(req, paperDepositSchema);
  rateLimit(`paper-deposit:${agent.id}`, 30, 60_000);
  await creditPaperDeposit({
    agent,
    amountSol,
    // Wallet-owned: ownerWallet (= the session wallet). Legacy owner-key agents: the caller's wallet, else payout.
    fromWallet: agent.ownerWallet ?? readSession(req) ?? agent.payoutAddress,
  });
  return ok<{ agent: AgentDTO }>({ agent: await ownerAgentDTO(agent.id) });
});
