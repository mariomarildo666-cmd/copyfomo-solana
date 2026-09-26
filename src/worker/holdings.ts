// Untracked holdings (finding F2, defense in depth). Every exit path (copy sells, close-all, withdraw + close) works
// from Position rows, so tokens the wallet holds without a sleeve would be stuck. The in-flight journal already
// finishes every broadcast swap from the chain; this pass catches whatever is left (a transaction that could never
// be measured, a sleeve cleared by a stale read).
//
// For each live agent: on-chain balance per mint (both token programs) vs Σ sleeves. A positive difference is
// ADOPTED into a sleeve only when it is explainable — the agent bought that mint itself (a CopyTrade with an
// on-chain signature), nothing for that mint is still in flight, and the account is a plain one (not frozen, no
// Token-2022 transfer hook). The adopted part is valued at a fresh Jupiter quote and booked as a filled "buy" at
// that value, so its later sale only counts (and is only charged a fee on) the move after adoption. Tokens someone
// else sent to the deposit address (airdrops, spam) are reported, never traded.

import type { Agent } from "@prisma/client";
import { PublicKey } from "@solana/web3.js";
import { kvSet, prisma } from "@/lib/db";
import { getQuote, JUP_PRIORITY } from "@/lib/jupiter";
import { LAMPORTS_PER_SOL, SOL_MINT } from "@/lib/solana";
import { errText, logger } from "./log";
import { enqueueForAgent, isShuttingDown } from "./queue";
import { listTokenAccounts, type TokenAccountInfo } from "./rent";
import { forEachLimit } from "./util";
import { workerHandlesMode } from "./wallet";

const log = logger("holdings");
const ZERO = BigInt(0);
const LOOP_MS = 30 * 60_000;
const FIRST_RUN_MS = 2 * 60_000;
const ADOPT_SLIPPAGE_BPS = 300;
const IN_FLIGHT_STATUSES = ["pending", "sending", "retrying"];

export interface Holding {
  mint: string;
  raw: bigint;
  decimals: number | null;
  /** Some account for this mint can't be traded automatically (frozen, transfer hook). */
  restricted: boolean;
}

/** Per-mint non-WSOL token balances from a token-account listing. */
export function holdingsFrom(accounts: readonly TokenAccountInfo[]): Holding[] {
  const byMint = new Map<string, Holding>();
  for (const a of accounts) {
    if (a.mint === SOL_MINT || a.amountRaw <= ZERO) continue;
    const h = byMint.get(a.mint) ?? { mint: a.mint, raw: ZERO, decimals: a.decimals, restricted: false };
    h.raw += a.amountRaw;
    h.decimals ??= a.decimals;
    if (a.state !== "initialized" || a.transferHook) h.restricted = true;
    byMint.set(a.mint, h);
  }
  return [...byMint.values()];
}

/** Non-WSOL token balances of a wallet (both token programs). */
export async function walletHoldings(owner: string): Promise<Holding[]> {
  return holdingsFrom(await listTokenAccounts(new PublicKey(owner)));
}

/** Kv key of an agent's untracked-holdings report ({ untracked: [{ mint, raw, why }], at }). */
export const holdingsKey = (agentId: string) => `holdings:${agentId}`;

export interface HoldingsReport {
  adopted: { mint: string; raw: string; costSol: number }[];
  untracked: { mint: string; raw: string; why: string }[];
}

type HoldingsAgent = Pick<Agent, "id" | "name" | "mode" | "depositAddress">;

/**
 * Compare the wallet with the agent's sleeves and adopt explainable differences (see the header). Live only.
 * Must run on the agent's queue. Never throws for one mint; the listing error propagates.
 */
export async function adoptUntrackedHoldings(agent: HoldingsAgent): Promise<HoldingsReport> {
  const report: HoldingsReport = { adopted: [], untracked: [] };
  if (agent.mode !== "live") return report;
  const holdings = await walletHoldings(agent.depositAddress);
  if (holdings.length === 0) return report;
  const positions = await prisma.position.findMany({ where: { agentId: agent.id }, select: { mint: true, rawAmount: true } });
  const sleeves = new Map<string, bigint>();
  for (const p of positions) sleeves.set(p.mint, (sleeves.get(p.mint) ?? ZERO) + BigInt(p.rawAmount));

  for (const h of holdings) {
    const diff = h.raw - (sleeves.get(h.mint) ?? ZERO);
    if (diff <= ZERO) continue;
    const untracked = (why: string) => report.untracked.push({ mint: h.mint, raw: diff.toString(), why });
    try {
      if (h.restricted) {
        untracked("frozen or transfer-hook token account");
        continue;
      }
      const decimals = h.decimals;
      if (decimals === null) {
        untracked("decimals unknown");
        continue;
      }
      const inFlight = await prisma.copyTrade.count({ where: { agentId: agent.id, mint: h.mint, status: { in: IN_FLIGHT_STATUSES } } });
      if (inFlight > 0) continue; // settles on its own; look again next pass
      const bought = await prisma.copyTrade.findFirst({
        where: { agentId: agent.id, mint: h.mint, side: "buy", traderId: { not: null }, signature: { not: null } },
        orderBy: { createdAt: "desc" },
        select: { traderId: true, symbol: true, signature: true },
      });
      if (!bought?.traderId || bought.signature?.startsWith("paper_")) {
        untracked("not bought by this agent");
        continue;
      }
      let costSol: number;
      try {
        const q = await getQuote({ inputMint: h.mint, outputMint: SOL_MINT, amount: diff, slippageBps: ADOPT_SLIPPAGE_BPS, priority: JUP_PRIORITY.background });
        costSol = Number(q.outAmount) / LAMPORTS_PER_SOL;
      } catch (err) {
        untracked(`no price (${errText(err, 60)})`);
        continue;
      }
      const traderId = bought.traderId;
      await prisma.$transaction(async (tx) => {
        const key = { agentId_traderId_mint: { agentId: agent.id, traderId, mint: h.mint } };
        const existing = await tx.position.findUnique({ where: key });
        if (existing) {
          await tx.position.update({
            where: key,
            data: { rawAmount: (BigInt(existing.rawAmount) + diff).toString(), costSol: existing.costSol + costSol },
          });
        } else {
          await tx.position.create({
            data: {
              agentId: agent.id,
              traderId,
              mint: h.mint,
              symbol: bought.symbol,
              decimals,
              rawAmount: diff.toString(),
              costSol,
              realizedSol: 0,
            },
          });
        }
        await tx.copyTrade.create({
          data: {
            agentId: agent.id,
            traderId,
            side: "buy",
            mint: h.mint,
            symbol: bought.symbol,
            solAmount: costSol,
            tokenRaw: diff.toString(),
            decimals,
            status: "filled",
            reason: "adopted: tokens in the wallet without a sleeve (valued at market)",
          },
        });
      });
      report.adopted.push({ mint: h.mint, raw: diff.toString(), costSol });
      log.warn("adopted untracked tokens into a sleeve", { agent: agent.name, mint: h.mint, raw: diff.toString(), valueSol: costSol.toFixed(6) });
    } catch (err) {
      untracked(`error: ${errText(err, 80)}`);
    }
  }
  if (report.untracked.length) log.info("untracked tokens left alone", { agent: agent.name, n: report.untracked.length });
  // For the dashboard: tokens the wallet holds that no sleeve accounts for (Kv "holdings:<agentId>").
  if (report.untracked.length) await kvSet(holdingsKey(agent.id), { untracked: report.untracked, at: new Date().toISOString() }).catch(() => undefined);
  else await prisma.kv.deleteMany({ where: { key: holdingsKey(agent.id) } }).catch(() => undefined);
  return report;
}

/** Periodic pass over live agents (first run a couple of minutes after start). Returns a stop function. */
export function startHoldingsLoop(): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const tick = async () => {
    if (stopped || isShuttingDown()) return;
    try {
      const agents = await prisma.agent.findMany({
        where: { mode: "live", status: { in: ["active", "paused"] } },
        select: { id: true, name: true, mode: true, depositAddress: true },
      });
      await forEachLimit(
        agents.filter((a) => workerHandlesMode(a.mode)),
        2,
        (a) =>
          enqueueForAgent(a.id, () => adoptUntrackedHoldings(a)).then(
            () => undefined,
            (err: unknown) => log.warn("holdings check failed", { agent: a.name, err: errText(err) }),
          ),
      );
    } catch (err) {
      log.warn("holdings pass failed", { err: errText(err) });
    }
    if (!stopped) timer = setTimeout(() => void tick(), LOOP_MS);
  };
  timer = setTimeout(() => void tick(), FIRST_RUN_MS);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
