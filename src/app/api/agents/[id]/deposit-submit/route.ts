import type { NextRequest } from "next/server";
import { requireOwner } from "@/lib/auth";
import { relayDeposit } from "@/lib/deposit";
import { handle } from "@/lib/http";
import { rateLimit } from "@/lib/ratelimit";
import { assertAgentKeyNotBroken, assertWorkerCanOpenNewKeys } from "@/lib/sealguard";
import { assertSameOrigin } from "@/lib/session";
import type { DepositSubmitResultDTO } from "@/lib/types";
import { ownerAgentDTO } from "../../../_lib/agents";
import { agentRef, ok, parseBody, upstream } from "../../../_lib/request";
import { depositSubmitSchema } from "../../../_lib/schemas";

/**
 * POST /api/agents/[id]/deposit-submit {txBase64, amountSol} — LIVE agents owned by the signed-in wallet: relay the
 * wallet-signed deposit. lib/deposit.relayDeposit first proves it is EXACTLY the transfer owner wallet → this
 * agent's deposit address for `amountSol` (only ComputeBudget + one SystemProgram.transfer, fee payer = owner,
 * valid signature, nothing else) and refuses anything else with 400 — this endpoint never relays arbitrary
 * transactions. Then it records a Deposit row (a replayed signature is 409), sends, confirms, refreshes the
 * balance and switches an awaiting agent on at ≥ minDepositSol.
 * status "submitted": sent but not confirmed yet — the worker's balance loop picks it up when it lands.
 */
export const POST = handle(async (req: NextRequest, ctx: RouteContext<"/api/agents/[id]/deposit-submit">) => {
  assertSameOrigin(req);
  const { id } = await ctx.params;
  const agent = await requireOwner(req, agentRef(id));
  const { txBase64, amountSol } = await parseBody(req, depositSubmitSchema);
  rateLimit(`deposit-submit:${agent.id}`, 10, 60_000);
  if (agent.mode === "live") {
    // Only fund keys the running worker can open (finding F12).
    await assertWorkerCanOpenNewKeys();
    await assertAgentKeyNotBroken(agent.id);
  }

  const res = await upstream(
    "deposit relay",
    "the deposit could not be completed right now — check your wallet's activity before trying again",
    () => relayDeposit({ agent, txBase64, amountSol }),
  );
  return ok<DepositSubmitResultDTO>({ signature: res.signature, status: res.status, agent: await ownerAgentDTO(agent.id) });
});
