"use client";

// Step 1 of the wizard: the top FOMO traders as a pickable list, so nobody has to leave the wizard (or know a
// wallet) to choose who to copy. Anyone not on the list is still added through the wallet / @handle box below it.

import { useMemo, useState } from "react";
import type { LeaderboardDTO, LeaderboardWindow, TraderDTO } from "@/lib/types";
import { fmtSignedUsd, shortAddr } from "@/lib/format";
import { RobotTile } from "@/components/bots/RobotTile";
import { Segmented } from "@/components/ui/ChipGroup";
import { SearchField } from "@/components/ui/Input";
import { Icon } from "@/components/ui/icons";
import { buttonClass, cn } from "@/components/ui/primitives";
import { isLeaderboard, useApi } from "@/components/landing/useApi";
import { isCopyable, type CopyableTrader } from "../picks";
import { VerifiedMark } from "../Tags";
import { traderSeed } from "../TraderAvatar";
import { traderName } from "../TraderIdentity";
import { WINDOWS, fmtCount, fmtWinRate, matchesQuery } from "../traders/explore";

const PAGE = 8;
const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";

export function TraderPickList({
  selected,
  full,
  max,
  onAdd,
  onRemove,
}: {
  /** Wallets already in the agent's list. */
  selected: ReadonlySet<string>;
  full: boolean;
  max: number;
  onAdd: (t: CopyableTrader) => void;
  onRemove: (wallet: string) => void;
}) {
  const [win, setWin] = useState<LeaderboardWindow>("7d");
  const [query, setQuery] = useState("");
  const [shown, setShown] = useState(PAGE);
  const { data, error, loading, reload } = useApi<LeaderboardDTO>(`/api/traders?window=${win}&limit=60`, isLeaderboard);

  const rows = useMemo(
    () => (data?.traders ?? []).filter(isCopyable).filter((t) => matchesQuery(t, query)),
    [data, query],
  );
  const visible = rows.slice(0, shown);

  return (
    <section aria-labelledby="pick-list-title" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="pick-list-title" className="text-[15px] font-bold tracking-[-0.01em] text-text">
          Top FOMO traders
        </h3>
        <Segmented
          label="Ranking window"
          size="sm"
          options={WINDOWS.map((w) => ({ value: w.value, label: w.label, ariaLabel: `Ranked by ${w.long}` }))}
          value={win}
          onChange={(v) => {
            setWin(v);
            setShown(PAGE);
          }}
        />
      </div>

      <form onSubmit={(e) => e.preventDefault()} role="search">
        <SearchField
          label="Search traders"
          placeholder="Search name, @handle, wallet or $token"
          value={query}
          goType="button"
          onChange={(e) => {
            setQuery(e.target.value);
            setShown(PAGE);
          }}
        />
      </form>

      {loading && !data ? (
        <ul className="flex flex-col gap-2" aria-busy="true" aria-label="Loading traders">
          {Array.from({ length: 4 }, (_, i) => (
            <li key={i} className="h-[62px] rounded-card-sm border border-border bg-card-2/60 animate-blink" />
          ))}
        </ul>
      ) : error && !data ? (
        <div className="flex items-center justify-between gap-3 rounded-card-sm border border-down/30 bg-down-bg/60 p-3 text-[13px] font-medium text-down-ink">
          Couldn&apos;t load the leaderboard.
          <button type="button" onClick={reload} className={buttonClass("outline", "sm")}>
            <Icon name="refresh" size={13} strokeWidth={2.2} />
            Retry
          </button>
        </div>
      ) : rows.length === 0 ? (
        <p className="rounded-card-sm border border-dashed border-border-strong bg-card p-4 text-center text-[13px] font-medium text-muted">
          {query ? "No trader on the list matches that. Paste their wallet or @handle below." : "No ranked traders yet. Add a wallet below."}
        </p>
      ) : (
        <>
          <ul className="flex flex-col gap-2" aria-label="Top FOMO traders">
            {visible.map((t) => (
              <li key={t.wallet}>
                <PickRow
                  t={t}
                  picked={selected.has(t.wallet)}
                  disabled={full && !selected.has(t.wallet)}
                  max={max}
                  onToggle={() => (selected.has(t.wallet) ? onRemove(t.wallet) : onAdd(t))}
                />
              </li>
            ))}
          </ul>
          {rows.length > shown ? (
            <button type="button" onClick={() => setShown((n) => n + PAGE)} className={buttonClass("outline", "sm", "self-center")}>
              Show more
              <span className="tabular-nums text-muted">{rows.length - shown}</span>
            </button>
          ) : null}
        </>
      )}
    </section>
  );
}

function PickRow({
  t,
  picked,
  disabled,
  max,
  onToggle,
}: {
  t: TraderDTO & { wallet: string };
  picked: boolean;
  disabled: boolean;
  max: number;
  onToggle: () => void;
}) {
  const name = traderName(t);
  const sub = t.displayName && t.handle ? `@${t.handle}` : shortAddr(t.wallet, 4, 4);
  const pnl = t.pnlUsd;
  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-card-sm border p-2.5 transition-[border-color,background-color,box-shadow] duration-150",
        picked ? "border-mint-400 bg-mint-50 shadow-[0_0_0_3px_rgb(47_191_174/0.12)]" : "border-border bg-card shadow-mini hover:border-border-strong",
      )}
    >
      <RobotTile seed={traderSeed(t)} variant="trader" size="sm" ring={picked} />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1.5">
          {t.rank !== null ? (
            <span className="shrink-0 text-[12px] font-bold tabular-nums text-muted">#{t.rank}</span>
          ) : null}
          <span className="truncate text-[14px] font-bold tracking-[-0.01em] text-text">{name}</span>
          {t.verified && t.handle ? <VerifiedMark small /> : null}
        </span>
        <span className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px] font-medium text-muted">
          <span className={cn("truncate", sub.startsWith("@") ? "text-text-2" : "addr text-[11.5px]")}>{sub}</span>
          {pnl !== null ? (
            <span className={cn("num inline-flex shrink-0 items-center gap-0.5 font-bold", pnl >= 0 ? "text-up" : "text-down")}>
              <Icon name={pnl >= 0 ? "trend" : "trend-down"} size={12} strokeWidth={2.4} />
              {fmtSignedUsd(pnl)}
            </span>
          ) : null}
          <span className="shrink-0 tabular-nums" title="Win rate">
            {fmtWinRate(t.winRate)} win
          </span>
          <span className="shrink-0 tabular-nums max-[22rem]:hidden" title="Trades">
            {fmtCount(t.trades)} trades
          </span>
        </span>
      </span>
      <button
        type="button"
        onClick={onToggle}
        disabled={disabled}
        aria-pressed={picked}
        aria-label={picked ? `Remove ${name}` : `Copy ${name}`}
        title={disabled ? `You can copy up to ${max} traders` : undefined}
        className={cn(
          buttonClass(picked ? "mint" : "ink", "sm", "shrink-0 max-app:h-11 max-app:px-3.5"),
          FOCUS,
        )}
      >
        <Icon name={picked ? "check" : "plus"} size={13} strokeWidth={2.4} />
        {picked ? "Added" : "Add"}
      </button>
    </div>
  );
}
