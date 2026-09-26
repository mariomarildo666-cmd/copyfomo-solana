import type { NextRequest } from "next/server";
import { requireOwner } from "@/lib/auth";
import { config } from "@/lib/config";
import { prepareDeposit } from "@/lib/deposit";
import { handle, HttpError } from "@/lib/http";
import { rateLimit } from "@/lib/ratelimit";
import { assertAgentKeyNotBroken, assertWorkerCanOpenNewKeys } from "@/lib/sealguard";
import { assertSameOrigin } from "@/lib/session";
import type { DepositTxDTO } from "@/lib/types";
import { agentRef, ok, parseBody, upstream } from "../../../_lib/request";
import { depositTxSchema } from "../../../_lib/schemas";

/**
 * POST /api/agents/[id]/deposit-tx {amountSol} — LIVE agents owned by the signed-in wallet: the unsigned
 * SystemProgram transfer owner wallet → agent deposit address (fee payer = owner wallet, recent blockhash from our
 * RPC). The wallet signs it (signTransaction) and the client posts it to deposit-submit. The browser never gets
 * an RPC URL. Paper agents: 400 (use paper-deposit).
 */
export const POST = handle(async (req: NextRequest, ctx: RouteContext<"/api/agents/[id]/deposit-tx">) => {
  assertSameOrigin(req);
  const { id } = await ctx.params;
  const agent = await requireOwner(req, agentRef(id));
  const { amountSol } = await parseBody(req, depositTxSchema);
  rateLimit(`deposit-tx:${agent.id}`, 20, 60_000);
  if (agent.mode === "live") {
    // Only fund keys the running worker can open (finding F12).
    await assertWorkerCanOpenNewKeys();
    await assertAgentKeyNotBroken(agent.id);
  }

  if (agent.mode === "live" && agent.status === "awaiting_deposit") {
    // The first deposit has to switch the agent on (stored balance: a manual transfer may already be counted).
    const missing = config.minDepositSol - agent.lastBalanceSol;
    if (missing > 1e-9 && amountSol + 1e-9 < missing) {
      const need = Math.ceil(missing * 1e6) / 1e6;
      const msg = `the first deposit must bring the agent to ${config.minDepositSol} SOL — add at least ${need} SOL`;
      throw new HttpError(400, msg, { amountSol: msg });
    }
  }

  const tx = await upstream("deposit tx build", "couldn't reach the Solana network to prepare your deposit — try again", () =>
    prepareDeposit({ agent, amountSol }),
  );
  return ok<DepositTxDTO>(tx);
});
