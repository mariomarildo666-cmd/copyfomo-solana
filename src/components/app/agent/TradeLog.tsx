"use client";

// The agent's trade log: every copy it made (or skipped), newest first, as original → copy pairs. Same row as the
// public feed (TradePairRow). Ten rows at a time.

import { useMemo, useState } from "react";
import type { AgentDTO, CopyTradeDTO } from "@/lib/types";
import { fmtSol, timeAgo, tokenLabel } from "@/lib/format";
import { RobotTile } from "@/components/bots/RobotTile";
import { Button, EmptyState, Panel, Pill } from "@/components/ui/primitives";
import { TradePairRow, TxLink } from "../trades/TradePair";
import { CardTitle } from "./bits";

const PAGE = 10;

function isRealSignature(sig: string | null, mode: AgentDTO["mode"]): sig is string {
  return typeof sig === "string" && sig.length > 0 && mode === "live" && !sig.startsWith("paper_");
}

function TradeRow({ trade, agent, now }: { trade: CopyTradeDTO; agent: AgentDTO; now: number }) {
  const o = trade.original;
  const token = tokenLabel(trade.symbol ?? o?.symbol ?? null, trade.mint);
  return (
    <TradePairRow
      now={now}
      original={
        o
          ? {
              trader: o.trader,
              side: o.side,
              token: tokenLabel(o.symbol, o.mint),
              solAmount: o.solAmount,
              blockTime: o.blockTime,
              signature: o.signature || null,
              venue: o.venue,
            }
          : null
      }
      manualToken={token}
      copy={{
        agentId: agent.id,
        agentName: agent.name,
        href: null,
        status: trade.status,
        statusLabel: !o && trade.status === "filled" ? "Filled" : undefined,
        side: trade.side,
        solAmount: trade.solAmount,
        paper: agent.mode === "paper",
        reason: trade.reason,
        latencyMs: trade.latencyMs,
      }}
      footerExtra={
        <>
          {trade.feeSol > 0 ? (
            <Pill tone="warn" size="sm" title="Platform fee on this sell's profit">
              fee <span className="num">{fmtSol(trade.feeSol, 4)}</span>
            </Pill>
          ) : null}
          <time dateTime={trade.createdAt}>{timeAgo(trade.createdAt, now)}</time>
          {isRealSignature(trade.signature, agent.mode) ? (
            <TxLink sig={trade.signature} label="copy tx" className="-my-1.5 -ml-1" />
          ) : null}
        </>
      }
    />
  );
}

export function TradeLog({ trades, agent, now }: { trades: CopyTradeDTO[]; agent: AgentDTO; now: number }) {
  const [limit, setLimit] = useState(PAGE);
  const sorted = useMemo(
    () => [...trades].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)),
    [trades],
  );
  const shown = sorted.slice(0, limit);
  const rest = sorted.length - shown.length;

  return (
    <Panel className="@container" aria-labelledby="tradelog-title">
      <CardTitle
        id="tradelog-title"
        className="px-4 pb-3.5 pt-4 app:px-5 app:pt-5"
        meta={
          <span className="text-[12px] font-medium text-muted">
            {sorted.length ? `${sorted.length} ${sorted.length === 1 ? "copy" : "copies"} · ` : ""}original → copy · newest first
          </span>
        }
      >
        Trade log
      </CardTitle>

      {sorted.length === 0 ? (
        <div className="px-3 pb-3 app:px-4 app:pb-4">
          <EmptyState
            title={agent.status === "awaiting_deposit" ? "Nothing yet" : "No copies yet"}
            art={<RobotTile seed={agent.id} variant="agent" mood="sleep" size="md" />}
          >
            {agent.status === "awaiting_deposit"
              ? "Fund the agent and it starts copying the next trade."
              : "When a trader it follows buys or sells, the pair shows up here."}
          </EmptyState>
        </div>
      ) : (
        <>
          <ol aria-label="Copies, newest first" className="border-t border-border">
            {shown.map((t) => (
              <TradeRow key={t.id} trade={t} agent={agent} now={now} />
            ))}
          </ol>
          {rest > 0 ? (
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-3 app:px-5">
              <p className="text-[12.5px] font-medium text-muted">
                Showing {shown.length} of {sorted.length}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" icon="chev" onClick={() => setLimit((l) => l + PAGE)}>
                  Show {Math.min(PAGE, rest)} more
                </Button>
                {rest > PAGE ? (
                  <Button variant="ghost" size="sm" onClick={() => setLimit(sorted.length)}>
                    Show all {sorted.length}
                  </Button>
                ) : null}
              </div>
            </div>
          ) : null}
        </>
      )}
    </Panel>
  );
}
