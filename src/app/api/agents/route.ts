import { Prisma, type Trader } from "@prisma/client";
import type { NextRequest } from "next/server";
import { agentInclude, type AgentWithRelations } from "@/lib/agents";
import { config } from "@/lib/config";
import { newSealedAgentWallet } from "@/lib/crypto";
import { prisma } from "@/lib/db";
import { creditPaperDeposit, prepareDeposit } from "@/lib/deposit";
import { handle, HttpError } from "@/lib/http";
import { clientIp, rateLimit } from "@/lib/ratelimit";
import { assertWorkerCanOpenNewKeys } from "@/lib/sealguard";
import { assertSameOrigin, requireSession } from "@/lib/session";
import type { CreateAgentResult, DepositTxDTO } from "@/lib/types";
import { ownerAgentDTO } from "../_lib/agents";
import { defaultAgentName, newSlug } from "../_lib/naming";
import { ok, parseBody, upstream } from "../_lib/request";
import { createAgentSchema } from "../_lib/schemas";
import { accountRejection, defaultAccountProbe } from "../_lib/traderGuard";
import { followRows, resolveTraders } from "../_lib/traders";

const CREATE_MAX = 5;
const CREATE_WINDOW_MS = 10 * 60_000;
/** Site-wide ceiling on agent creation (every agent adds watch-set and indexer load). */
const CREATE_GLOBAL_MAX = 60;
const SLUG_ATTEMPTS = 5;
/** Agents one wallet may run at once (not stopped). Keeps one session from filling the watch set. */
const MAX_OPEN_AGENTS_PER_WALLET = 20;

/**
 * POST /api/agents — create a copy agent owned by the signed-in wallet (session cookie; 401 otherwise).
 * The owner wallet is also the only withdrawal destination (payoutAddress = ownerWallet, fixed).
 *  - live: the response carries `deposit`, the unsigned transfer owner wallet → agent deposit address for
 *    `depositSol`; the wallet signs it and the client posts it to /api/agents/[id]/deposit-submit.
 *  - paper: `depositSol` is credited at once as simulated SOL (no transfer); `deposit` is null.
 * Order: same-origin + session → validation → rate limit (typos don't burn the budget) → trader checks → DB work.
 */
export const POST = handle(async (req: NextRequest) => {
  assertSameOrigin(req);
  const owner = requireSession(req);
  if (!config.walletSealPublicKey) {
    throw new HttpError(500, "server not configured: WALLET_SEAL_PUBLIC_KEY missing");
  }
  const input = await parseBody(req, createAgentSchema);
  rateLimit(`create-agent:${clientIp(req)}`, CREATE_MAX, CREATE_WINDOW_MS);
  rateLimit(`create-agent-w:${owner}`, CREATE_MAX, CREATE_WINDOW_MS);
  rateLimit("create-agent:global", CREATE_GLOBAL_MAX, CREATE_WINDOW_MS);

  // An agent wallet can't own another agent: its withdrawals would loop between custodial wallets.
  if (await prisma.agent.findUnique({ where: { depositAddress: owner }, select: { id: true } })) {
    throw new HttpError(400, "you signed in with a copyfomo agent's wallet — sign in with your own wallet");
  }

  const running = await prisma.agent.count({ where: { ownerWallet: owner, status: { not: "stopped" } } });
  if (running >= MAX_OPEN_AGENTS_PER_WALLET) {
    throw new HttpError(409, `this wallet already runs ${running} agents — withdraw everything from one to stop it first`);
  }

  const traders = await resolveTraders(input.traders);
  if (config.mode === "live") {
    await assertOwnerIsPlainWallet(owner);
    // Never hand out a deposit address the running worker couldn't open (finding F12).
    await assertWorkerCanOpenNewKeys();
  }
  const name = input.name ?? defaultAgentName(traders[0]!);

  const wallet = newSealedWallet(owner);
  if (wallet.depositAddress === owner) {
    // Astronomically unlikely with a fresh keypair; checked because withdrawals would loop back.
    throw new HttpError(500, "could not create the agent wallet — try again");
  }

  // Live: build the unsigned deposit BEFORE saving, so an RPC outage never leaves an agent nobody can fund.
  let deposit: DepositTxDTO | null = null;
  if (config.mode === "live") {
    deposit = await upstream("deposit tx build", "couldn't reach the Solana network to prepare your deposit — try again", () =>
      prepareDeposit({
        agent: { id: "", mode: "live", status: "awaiting_deposit", ownerWallet: owner, depositAddress: wallet.depositAddress },
        amountSol: input.depositSol,
      }),
    );
  }

  const agent = await createWithUniqueSlug(
    {
      name,
      // Wallet-owned: the legacy owner-key path is never used for this agent (auth.requireOwner).
      ownerKeyHash: "",
      ownerWallet: owner,
      payoutAddress: owner,
      depositAddress: wallet.depositAddress,
      sealedSecret: wallet.sealedSecret,
      mode: config.mode,
      status: "awaiting_deposit",
      // A keypair generated a moment ago provably holds 0 SOL; stamping it spares the RPC call in toAgentDTO.
      ...(config.mode === "live" ? { lastBalanceSol: 0, balanceAt: new Date() } : {}),
      sizingMode: input.sizingMode,
      fixedSol: input.fixedSol,
      maxPerTradeSol: input.maxPerTradeSol,
      slippageBps: input.slippageBps,
      copySells: input.copySells,
    },
    traders,
  );

  if (config.mode === "paper") {
    // Simulated SOL only: nothing is transferred, the deposit address is never funded for real.
    await creditPaperDeposit({ agent, amountSol: input.depositSol, fromWallet: owner });
  }

  return ok<CreateAgentResult>({ agent: await ownerAgentDTO(agent.id), deposit }, 201);
});

/**
 * Withdrawals go to the signed-in wallet. It proved it holds an ed25519 key, but a key can also be a token mint's
 * (vanity mints are keypairs): SOL sent there is gone (finding F15). Live agents only accept an owner wallet
 * that doesn't exist yet or is a plain System-owned account.
 */
async function assertOwnerIsPlainWallet(owner: string): Promise<void> {
  const acct = await upstream("owner account check", "couldn't check your wallet right now — try again", () => defaultAccountProbe(owner));
  const why = accountRejection(acct);
  if (why) {
    throw new HttpError(400, `the wallet you signed in with can't receive withdrawals: ${why.replace(/ — .*$/, "")} — sign in with a normal wallet`);
  }
}

/**
 * Fresh agent wallet (node:crypto ed25519, finding F45): only the sealed secret survives, every raw copy is wiped.
 * The blob is v2, bound to the deposit address and the owner wallet (finding F10), so a rewritten owner / payout
 * in the database can't redirect withdrawals: the worker could no longer open the key.
 */
function newSealedWallet(ownerWallet: string): { depositAddress: string; sealedSecret: string } {
  try {
    return newSealedAgentWallet({ ownerWallet, sealPublicKey: config.walletSealPublicKey });
  } catch (err) {
    console.error(`[api] sealing agent key failed: ${err instanceof Error ? err.message : String(err)}`);
    throw new HttpError(500, "server not configured: WALLET_SEAL_PUBLIC_KEY is invalid");
  }
}

type AgentFields = Omit<
  Prisma.AgentUncheckedCreateInput,
  "slug" | "follows" | "trades" | "positions" | "commands" | "deposits" | "feeSweeps"
>;

/** Agent + Follow rows in one nested (atomic) create; retries on the rare slug collision. */
async function createWithUniqueSlug(fields: AgentFields, traders: readonly Trader[]): Promise<AgentWithRelations> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await prisma.agent.create({
        data: { ...fields, slug: newSlug(fields.name), follows: { create: followRows(traders) } },
        include: agentInclude,
      });
    } catch (err) {
      // The only unique columns a fresh agent can clash on are slug (random suffix) and depositAddress (fresh key).
      const clash = err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
      if (!clash || attempt >= SLUG_ATTEMPTS) throw err;
    }
  }
}
