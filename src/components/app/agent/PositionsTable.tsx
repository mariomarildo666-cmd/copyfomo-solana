"use client";

import type { ReactNode } from "react";
import type { PositionDTO } from "@/lib/types";
import { fmtSignedSol, fmtSol, solscanAccount, tokenLabel, traderLabel } from "@/lib/format";
import { RobotTile } from "@/components/bots/RobotTile";
import { Icon } from "@/components/ui/icons";
import { Panel, Pill, cn } from "@/components/ui/primitives";
import { traderSeed } from "../TraderAvatar";
import { CardTitle } from "./bits";

export function fmtTokenAmount(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n >= 1_000_000) return n.toLocaleString("en-US", { notation: "compact", maximumFractionDigits: 2 });
  if (n >= 1) return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  return n.toLocaleString("en-US", { maximumSignificantDigits: 4 });
}

function Signed({ n }: { n: number | null }) {
  const tone = n === null || n === 0 ? "text-muted" : n > 0 ? "text-up" : "text-down";
  return (
    <span className={cn("inline-flex items-center justify-end gap-1 font-mono font-semibold tabular-nums", tone)}>
      {n !== null && n > 0 ? <Icon name="trend" size={12} strokeWidth={2.4} /> : null}
      {n !== null && n < 0 ? <Icon name="trend-down" size={12} strokeWidth={2.4} /> : null}
      {fmtSignedSol(n)}
    </span>
  );
}

function TokenCell({ p }: { p: PositionDTO }) {
  return (
    <a
      href={solscanAccount(p.mint)}
      target="_blank"
      rel="noopener noreferrer"
      className="relative inline-flex min-w-0 items-center gap-1 rounded-sm text-[13.5px] font-bold text-text after:absolute after:-inset-y-2.5 after:inset-x-0 hover:text-mint-700"
      title={p.mint}
    >
      <span className="truncate">{tokenLabel(p.symbol, p.mint)}</span>
      <Icon name="external" size={11} strokeWidth={2.2} className="shrink-0 text-icon" />
      <span className="sr-only"> (Solscan, opens in a new tab)</span>
    </a>
  );
}

function FromCell({ p }: { p: PositionDTO }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <RobotTile seed={traderSeed(p.trader)} variant="trader" size="2xs" shape="circle" />
      <span className="truncate text-[12.5px] font-semibold text-text-2">{traderLabel(p.trader)}</span>
    </span>
  );
}

export function PositionsTable({ positions }: { positions: PositionDTO[] }) {
  return (
    <Panel className="@container" aria-labelledby="positions-title">
      <CardTitle
        id="positions-title"
        className="px-4 pt-4 app:px-5 app:pt-5"
        meta={
          <Pill tone={positions.length ? "mint" : "neutral"}>
            {positions.length} open
          </Pill>
        }
      >
        Positions
      </CardTitle>

      {positions.length === 0 ? (
        <p className="px-4 pb-5 pt-2.5 text-[13px] leading-snug text-muted app:px-5">
          No open positions. The agent buys when a trader it copies buys.
        </p>
      ) : (
        <>
          <div className="mt-3 hidden overflow-x-auto @min-[640px]:block">
            <table className="w-full min-w-[620px] text-left text-[13px]">
              <thead>
                <tr className="border-y border-border bg-card-2 text-[12px] font-semibold text-muted">
                  <th scope="col" className="py-2.5 pl-5 font-bold">Token</th>
                  <th scope="col" className="py-2.5 font-bold">From</th>
                  <th scope="col" className="py-2.5 text-right font-bold">Amount</th>
                  <th scope="col" className="py-2.5 text-right font-bold">Cost</th>
                  <th scope="col" className="py-2.5 text-right font-bold">Value</th>
                  <th scope="col" className="py-2.5 text-right font-bold">Unrealized</th>
                  <th scope="col" className="py-2.5 pr-5 text-right font-bold">Realized</th>
                </tr>
              </thead>
              <tbody>
                {positions.map((p) => (
                  <tr key={`${p.mint}:${p.trader.wallet ?? ""}`} className="border-b border-border last:border-0 hover:bg-card-2/60">
                    <td className="max-w-[180px] py-3 pl-5 pr-3">
                      <TokenCell p={p} />
                    </td>
                    <td className="max-w-[200px] py-3 pr-3">
                      <FromCell p={p} />
                    </td>
                    <td className="py-3 pl-2 text-right font-mono tabular-nums text-text-2">{fmtTokenAmount(p.amount)}</td>
                    <td className="py-3 pl-2 text-right font-mono tabular-nums text-text-2">{fmtSol(p.costSol)}</td>
                    <td className="py-3 pl-2 text-right font-mono tabular-nums text-text-2">
                      {p.valueSol === null ? (
                        <span className="text-muted" title="No price available">
                          —
                        </span>
                      ) : (
                        fmtSol(p.valueSol)
                      )}
                    </td>
                    <td className="py-3 pl-2 text-right">
                      <Signed n={p.unrealizedSol} />
                    </td>
                    <td className="py-3 pl-2 pr-5 text-right">
                      <Signed n={p.realizedSol} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <ul className="mt-3 flex flex-col gap-2 px-3 pb-3 @min-[640px]:hidden">
            {positions.map((p) => (
              <li key={`${p.mint}:${p.trader.wallet ?? ""}`} className="rounded-card-sm border border-border bg-card-2 p-3">
                <div className="flex items-center justify-between gap-3">
                  <TokenCell p={p} />
                  <span className="flex min-w-0 items-center gap-1.5 text-[12px] text-muted">
                    via
                    <FromCell p={p} />
                  </span>
                </div>
                <dl className="mt-3 grid grid-cols-3 gap-x-3 gap-y-2.5">
                  <Cell label="Amount">{fmtTokenAmount(p.amount)}</Cell>
                  <Cell label="Cost">{fmtSol(p.costSol)}</Cell>
                  <Cell label="Value">{p.valueSol === null ? "—" : fmtSol(p.valueSol)}</Cell>
                  <Cell label="Unrealized">
                    <Signed n={p.unrealizedSol} />
                  </Cell>
                  <Cell label="Realized">
                    <Signed n={p.realizedSol} />
                  </Cell>
                </dl>
              </li>
            ))}
          </ul>
        </>
      )}
    </Panel>
  );
}

function Cell({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-semibold text-muted">{label}</dt>
      <dd className="mt-0.5 truncate font-mono text-[12px] font-medium tabular-nums text-text">{children}</dd>
    </div>
  );
}
