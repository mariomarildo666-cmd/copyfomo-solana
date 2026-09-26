// Agent ownership. An agent created after wallet login belongs to `Agent.ownerWallet`: the signed-in session
// wallet must equal it. Legacy agents (ownerWallet null, created with an owner key) still accept the
// `x-owner-key` header; that path is never used for wallet-owned agents.

import type { Agent } from "@prisma/client";
import { hashOwnerKey, safeEqualHex } from "./crypto";
import { prisma } from "./db";
import { HttpError } from "./http";
import { assertSameOrigin, readSession } from "./session";

const OWNER_KEY_RE = /^cf_[1-9A-HJ-NP-Za-km-z]{30,60}$/;
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

type Ownable = Pick<Agent, "ownerWallet" | "ownerKeyHash">;

function legacyKeyMatches(req: Request, agent: Ownable): boolean {
  if (agent.ownerWallet !== null) return false;
  const key = req.headers.get("x-owner-key")?.trim() ?? "";
  return key !== "" && OWNER_KEY_RE.test(key) && safeEqualHex(hashOwnerKey(key), agent.ownerKeyHash);
}

/**
 * Does this request come from the agent's owner? Session wallet === ownerWallet, or (legacy agents only) a
 * valid x-owner-key. Never throws; use it to decide what a DTO may show (AgentDTO.isOwner).
 */
export function isOwnerOf(req: Request | null | undefined, agent: Ownable): boolean {
  if (!req) return false;
  if (agent.ownerWallet !== null) return readSession(req) === agent.ownerWallet;
  return legacyKeyMatches(req, agent);
}

/**
 * Resolve the agent (by id or slug) and require its owner. For state-changing methods it also runs
 * assertSameOrigin (403 on cross-site requests).
 *  - 404 agent not found
 *  - 401 not signed in (wallet-owned) / missing or wrong owner key (legacy)
 *  - 403 signed in with a different wallet
 */
export async function requireOwner(req: Request, idOrSlug: string): Promise<Agent> {
  if (!SAFE_METHODS.has(req.method.toUpperCase())) assertSameOrigin(req);

  const agent = idOrSlug ? await prisma.agent.findFirst({ where: { OR: [{ id: idOrSlug }, { slug: idOrSlug }] } }) : null;
  if (!agent) throw new HttpError(404, "agent not found");

  if (agent.ownerWallet !== null) {
    const wallet = readSession(req);
    if (!wallet) throw new HttpError(401, "sign in with the wallet that owns this agent");
    if (wallet !== agent.ownerWallet) throw new HttpError(403, "this agent belongs to another wallet");
    return agent;
  }

  // Legacy owner-key agent.
  const key = req.headers.get("x-owner-key")?.trim() ?? "";
  if (!key) throw new HttpError(401, "missing owner key (x-owner-key header)");
  if (!legacyKeyMatches(req, agent)) throw new HttpError(401, "invalid owner key");
  return agent;
}
