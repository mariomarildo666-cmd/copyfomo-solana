// The copy ledger: CopyTrade rows, Position sleeves, paper balances and platform fees. Every write that follows a
// fill happens here, in ONE database transaction that also drops the fill's in-flight journal record, so a fill is
// either fully recorded or still in the journal for inflight.ts to finish.
//
// Platform performance fee (src/lib/fees.ts): on every FILLED sell (copied sells, close-all and withdraw
// liquidation sells) with profit = proceeds − cost basis of the part sold > 0, fee = profit × PLATFORM_FEE_BPS /
// 10000, recorded on CopyTrade.feeSol. Paper: deducted from paperSol at once and added to Agent.feesPaidSol.
// Live: added to Agent.feeOwedSol; feesweep.ts transfers it to PLATFORM_FEE_WALLET. Buys and losing sells pay
// nothing. The sleeve's realizedSol is net of the fee (PnL is shown net of fees).

import type { Agent, Prisma } from "@prisma/client";
import { config } from "@/lib/config";
import { prisma } from "@/lib/db";
import { computeSellFee } from "@/lib/fees";
import { inflightKey, journalRow, type InflightRecord } from "./inflight";
import { applyBuy, applySell } from "./sizing";
import { TradeError, type Fill, type SellFill } from "./swap";

const ZERO = BigInt(0);
/** Float slack when checking a paper balance against a fill size. */
const EPS = 1e-9;

type LedgerAgent = Pick<Agent, "id" | "mode">;
const isPaper = (a: LedgerAgent) => a.mode === "paper";

async function dropJournalIn(tx: Prisma.TransactionClient, signature: string | null | undefined): Promise<void> {
  if (signature && !signature.startsWith("paper_")) await tx.kv.deleteMany({ where: { key: inflightKey(signature) } });
}

/** Close a CopyTrade as skipped / failed (and drop its journal record when the send is settled). */
export async function finishTrade(
  id: string,
  data: { status: "skipped" | "failed"; reason: string; solAmount?: number; signature?: string | null; tokenRaw?: bigint },
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.copyTrade.update({
      where: { id },
      data: {
        status: data.status,
        reason: data.reason.slice(0, 200),
        solAmount: data.solAmount ?? 0,
        signature: data.signature ?? null,
        ...(data.tokenRaw !== undefined ? { tokenRaw: data.tokenRaw.toString() } : {}),
      },
    });
    await dropJournalIn(tx, data.signature);
  });
}

/**
 * The swap is signed and about to be broadcast: mark the row "sending" with its signature and write the journal
 * record, atomically. Called from send.ts's onSigned hook — if this fails nothing is broadcast.
 */
export async function markSending(tradeId: string, rec: InflightRecord): Promise<void> {
  const row = journalRow(rec);
  await prisma.$transaction([
    prisma.copyTrade.update({ where: { id: tradeId }, data: { status: "sending", signature: rec.signature, reason: null } }),
    prisma.kv.upsert({ where: { key: row.key }, create: row, update: { value: row.value } }),
  ]);
}

export interface BuyContext {
  traderId: string;
  mint: string;
  symbol: string | null;
  decimals: number;
  latencyMs: number | null;
}

/** Book a filled buy: sleeve += tokens / cost, CopyTrade filled, paper balance debited. */
export async function recordBuy(agent: LedgerAgent, tradeId: string, p: BuyContext, fill: Fill): Promise<void> {
  const decimals = fill.decimals ?? p.decimals;
  await prisma.$transaction(async (tx) => {
    if (isPaper(agent)) {
      const debited = await tx.agent.updateMany({
        where: { id: agent.id, paperSol: { gte: fill.solAmount - EPS } },
        data: { paperSol: { decrement: fill.solAmount } },
      });
      if (debited.count !== 1) throw new TradeError("insufficient balance");
    }
    const key = { agentId_traderId_mint: { agentId: agent.id, traderId: p.traderId, mint: p.mint } };
    const existing = await tx.position.findUnique({ where: key });
    const next = applyBuy(
      existing ? { rawAmount: BigInt(existing.rawAmount), costSol: existing.costSol, realizedSol: existing.realizedSol } : null,
      fill.tokenRaw,
      fill.solAmount,
    );
    if (existing) {
      await tx.position.update({
        where: key,
        data: { rawAmount: next.rawAmount.toString(), costSol: next.costSol, symbol: existing.symbol ?? p.symbol },
      });
    } else {
      await tx.position.create({
        data: {
          agentId: agent.id,
          traderId: p.traderId,
          mint: p.mint,
          symbol: p.symbol,
          decimals,
          rawAmount: next.rawAmount.toString(),
          costSol: next.costSol,
          realizedSol: 0,
        },
      });
    }
    await tx.copyTrade.update({
      where: { id: tradeId },
      data: {
        status: "filled",
        reason: null,
        solAmount: fill.solAmount,
        tokenRaw: fill.tokenRaw.toString(),
        decimals,
        signature: fill.signature,
        latencyMs: p.latencyMs,
        feeSol: 0,
      },
    });
    await dropJournalIn(tx, fill.signature);
  });
}

/**
 * Book a filled sell against sleeve `positionId` (null / gone: proceeds booked, no cost basis → no fee).
 * Returns the platform fee charged.
 */
export async function recordSell(
  agent: LedgerAgent,
  tradeId: string,
  positionId: string | null,
  fill: Fill | SellFill,
  latencyMs: number | null,
  fallbackDecimals: number,
): Promise<{ feeSol: number }> {
  return prisma.$transaction(async (tx) => {
    const current = positionId ? await tx.position.findUnique({ where: { id: positionId } }) : null;
    let feeSol = 0;
    if (current) {
      // Live wallet emptied of this token: nothing is left for this sleeve either.
      const sold = "exhausted" in fill && fill.exhausted ? BigInt(current.rawAmount) : fill.tokenRaw;
      const next = applySell(
        { rawAmount: BigInt(current.rawAmount), costSol: current.costSol, realizedSol: current.realizedSol },
        sold,
        fill.solAmount,
      );
      feeSol = computeSellFee({ proceedsSol: fill.solAmount, costPartSol: next.costPart, bps: config.platformFeeBps });
      if (next.rawAmount === ZERO) {
        await tx.position.delete({ where: { id: current.id } });
      } else {
        await tx.position.update({
          where: { id: current.id },
          data: { rawAmount: next.rawAmount.toString(), costSol: next.costSol, realizedSol: next.realizedSol - feeSol },
        });
      }
    }
    if (isPaper(agent)) {
      await tx.agent.update({
        where: { id: agent.id },
        data: { paperSol: { increment: fill.solAmount - feeSol }, ...(feeSol > 0 ? { feesPaidSol: { increment: feeSol } } : {}) },
      });
    } else if (feeSol > 0) {
      await tx.agent.update({ where: { id: agent.id }, data: { feeOwedSol: { increment: feeSol } } });
    }
    await tx.copyTrade.update({
      where: { id: tradeId },
      data: {
        status: "filled",
        reason: null,
        solAmount: fill.solAmount,
        tokenRaw: fill.tokenRaw.toString(),
        decimals: fill.decimals ?? current?.decimals ?? fallbackDecimals,
        signature: fill.signature,
        latencyMs,
        feeSol,
      },
    });
    await dropJournalIn(tx, fill.signature);
    return { feeSol };
  });
}
