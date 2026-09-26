// Wallet step-up for risk-raising rule changes on LIVE agents (finding F18).
//
// Whoever holds a live agent's session can change who it copies and how much it spends. Doing that is how funds
// could be extracted through trades (point the agent at a wallet you control, raise the size, trade a thin token
// into it) — no withdrawal needed. A session cookie alone therefore can't raise risk on a live agent: the owner's
// wallet must sign a message that spells out the change (signMessage; no transaction, no cost).
//
//   PATCH without `confirm` → 428 { error, stepUp: { message, nonce, expiresAt } }
//   the wallet signs stepUp.message → PATCH again with the same body + confirm: { nonce, signature }
//
// The server rebuilds the message from the stored nonce and the CURRENT request, so a signature only ever
// authorizes exactly the change it describes, once, within 5 minutes, for this agent, wallet and site.
// Lowering risk, pausing / resuming, and anything on paper agents never needs a signature.

import { createHash, randomBytes } from "node:crypto";
import type { Agent } from "@prisma/client";
import bs58 from "bs58";
import { verifyEd25519 } from "@/lib/crypto";
import { prisma } from "@/lib/db";
import { HttpError, json } from "@/lib/http";
import type { SizingMode, StepUpChallengeDTO, StepUpRequiredDTO } from "@/lib/types";

export const STEP_UP_TTL_MS = 5 * 60_000;
const KV_PREFIX = "stepup:";
const CLOCK_SKEW_MS = 60_000;

/** The 428 contract lives in lib/types (StepUpChallengeDTO / StepUpRequiredDTO); re-exported for callers here. */
export type { StepUpChallengeDTO, StepUpRequiredDTO };

export interface RuleState {
  sizingMode: string;
  fixedSol: number;
  maxPerTradeSol: number;
  slippageBps: number;
  /** Wallets followed now. */
  traders: readonly string[];
}

export interface RuleChange {
  sizingMode?: SizingMode;
  fixedSol?: number;
  maxPerTradeSol?: number;
  slippageBps?: number;
  /** The full new follow list (PATCH replaces it). */
  traders?: readonly string[];
}

const EPS = 1e-12;

function sol(n: number): string {
  return `${Number(n.toFixed(6))} SOL`;
}
function pct(bps: number): string {
  return `${Number((bps / 100).toFixed(2))}%`;
}

/**
 * One line per change that can make a live agent spend more per copy or copy a new wallet. Empty when the
 * request only lowers risk (or changes nothing risky): no signature needed.
 */
export function riskRaisingChanges(current: RuleState, next: RuleChange): string[] {
  const lines: string[] = [];
  if (next.traders) {
    const now = new Set(current.traders);
    for (const w of next.traders) if (!now.has(w)) lines.push(`start copying wallet ${w}`);
  }
  if (next.sizingMode !== undefined && next.sizingMode !== current.sizingMode) {
    lines.push(`sizing: ${current.sizingMode} → ${next.sizingMode}`);
  }
  if (next.fixedSol !== undefined && next.fixedSol > current.fixedSol + EPS) {
    lines.push(`fixed size per copy: ${sol(current.fixedSol)} → ${sol(next.fixedSol)}`);
  }
  if (next.maxPerTradeSol !== undefined && next.maxPerTradeSol > current.maxPerTradeSol + EPS) {
    lines.push(`max per copy: ${sol(current.maxPerTradeSol)} → ${sol(next.maxPerTradeSol)}`);
  }
  if (next.slippageBps !== undefined && next.slippageBps > current.slippageBps) {
    lines.push(`max slippage: ${pct(current.slippageBps)} → ${pct(next.slippageBps)}`);
  }
  return lines;
}

interface StepUpFields {
  domain: string;
  wallet: string;
  agent: Pick<Agent, "id" | "name" | "slug">;
  lines: readonly string[];
  nonce: string;
  issuedAt: Date;
  expiresAt: Date;
}

/** The exact text the owner's wallet signs. */
export function buildStepUpMessage(f: StepUpFields): string {
  return [
    `${f.domain} asks you to confirm new copy rules for a LIVE agent.`,
    `Agent: ${f.agent.name} (${f.agent.slug})`,
    `Wallet: ${f.wallet}`,
    "",
    ...f.lines.map((l) => `- ${l}`),
    "",
    "Only sign this if you made these changes yourself. It sends no transaction and costs nothing.",
    "",
    `Nonce: ${f.nonce}`,
    `Issued At: ${f.issuedAt.toISOString()}`,
    `Expiration Time: ${f.expiresAt.toISOString()}`,
  ].join("\n");
}

interface StoredStepUp {
  wallet: string;
  domain: string;
  agentId: string;
  /** sha256 hex of the change lines (the request must describe the same change at confirmation). */
  digest: string;
  issuedAt: string;
  expiresAt: string;
}

function digestOf(lines: readonly string[]): string {
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

let lastPrune = 0;
async function prune(now: number): Promise<void> {
  if (now - lastPrune < 60_000) return;
  lastPrune = now;
  await prisma.kv
    .deleteMany({ where: { key: { startsWith: KV_PREFIX }, updatedAt: { lt: new Date(now - STEP_UP_TTL_MS - CLOCK_SKEW_MS) } } })
    .catch(() => undefined);
}

/** Store a single-use nonce for this exact change and return what to sign. */
export async function createStepUp(p: {
  domain: string;
  wallet: string;
  agent: Pick<Agent, "id" | "name" | "slug">;
  lines: readonly string[];
  now?: Date;
}): Promise<StepUpChallengeDTO> {
  const nowMs = (p.now ?? new Date()).getTime();
  const nonce = bs58.encode(randomBytes(16));
  const issuedAt = new Date(Math.floor(nowMs / 1000) * 1000);
  const expiresAt = new Date(issuedAt.getTime() + STEP_UP_TTL_MS);
  const stored: StoredStepUp = {
    wallet: p.wallet,
    domain: p.domain,
    agentId: p.agent.id,
    digest: digestOf(p.lines),
    issuedAt: issuedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };
  await prisma.kv.create({ data: { key: `${KV_PREFIX}${nonce}`, value: JSON.stringify(stored) } });
  void prune(nowMs);
  const message = buildStepUpMessage({ domain: p.domain, wallet: p.wallet, agent: p.agent, lines: p.lines, nonce, issuedAt, expiresAt });
  return { message, nonce, expiresAt: expiresAt.toISOString() };
}

/** 428 Precondition Required: the client must have the wallet sign `stepUp.message` and retry with `confirm`. */
export function stepUpRequired(challenge: StepUpChallengeDTO): Response {
  return json<StepUpRequiredDTO>(
    { error: "confirm this change in your wallet — it raises how much this live agent can spend or adds a wallet to copy", stepUp: challenge },
    { status: 428, headers: { "cache-control": "no-store" } },
  );
}

const denied = (why: string) => new HttpError(401, why);

/**
 * Verify and consume a step-up confirmation for exactly this change. Throws HttpError(401) when the nonce is
 * unknown / used / expired, was issued for another wallet, site or agent, describes a different change, or the
 * signature does not match the owner's wallet.
 */
export async function verifyStepUp(p: {
  domain: string;
  wallet: string;
  agent: Pick<Agent, "id" | "name" | "slug">;
  lines: readonly string[];
  confirm: { nonce: string; signature: string };
  now?: Date;
}): Promise<void> {
  const now = (p.now ?? new Date()).getTime();
  const key = `${KV_PREFIX}${p.confirm.nonce}`;
  const row = await prisma.kv.findUnique({ where: { key } });
  if (!row) throw denied("this confirmation expired or was already used — confirm the change again");
  let stored: StoredStepUp;
  try {
    stored = JSON.parse(row.value) as StoredStepUp;
  } catch {
    throw denied("this confirmation expired or was already used — confirm the change again");
  }
  const issuedAt = new Date(stored.issuedAt);
  const expiresAt = new Date(stored.expiresAt);
  if (!(expiresAt.getTime() > now)) throw denied("this confirmation expired — confirm the change again");
  if (issuedAt.getTime() > now + CLOCK_SKEW_MS) throw denied("this confirmation is not valid yet");
  if (stored.wallet !== p.wallet || stored.domain !== p.domain || stored.agentId !== p.agent.id) {
    throw denied("this confirmation was made for another wallet, site or agent");
  }
  if (stored.digest !== digestOf(p.lines)) {
    throw denied("the change you confirmed doesn't match this request (the agent changed meanwhile?) — confirm again");
  }

  let sig: Uint8Array;
  let pub: Uint8Array;
  try {
    sig = bs58.decode(p.confirm.signature);
    pub = bs58.decode(p.wallet);
  } catch {
    throw denied("invalid signature");
  }
  if (sig.length !== 64 || pub.length !== 32) throw denied("invalid signature");
  const message = buildStepUpMessage({ domain: p.domain, wallet: p.wallet, agent: p.agent, lines: p.lines, nonce: p.confirm.nonce, issuedAt, expiresAt });
  if (!verifyEd25519(Buffer.from(message, "utf8"), sig, pub)) throw denied("the signature doesn't match the agent's wallet");

  // Single use: exactly one request can delete the row.
  const consumed = await prisma.kv.deleteMany({ where: { key } });
  if (consumed.count !== 1) throw denied("this confirmation was already used — confirm the change again");
}
