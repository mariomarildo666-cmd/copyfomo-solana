"use client";

// /traders: copyfomo's FOMO leaderboard as a picker. Filter chips, ranking window, sort and a text filter above the
// same trader cards as Explore, in pick mode: each card's checkbox (the whole card is its label) toggles a pick, and
// the sticky bar builds one agent from the picks (kept in sessionStorage, shared with /create and the trader
// profiles). "Paste any wallet" adds traders who aren't on the list. Twelve cards at a time.

import { useMemo, useState } from "react";
import type { AppConfigDTO, LeaderboardDTO, LeaderboardWindow, RankingRulesDTO, TraderDTO } from "@/lib/types";
import { fmtUsd, timeAgo } from "@/lib/format";
import { PixelRobot } from "@/components/bots/PixelRobot";
import { Icon } from "@/components/ui/icons";
import { HeroBanner } from "@/components/ui/HeroBanner";
import { Button, ButtonLink, Card, EmptyState, Kicker, cn } from "@/components/ui/primitives";
import { useNow } from "@/components/landing/hooks";
import { errorMessage } from "../api";
import { CopyDesk } from "../CopyDesk";
import { Notice } from "../Field";
import { useAppConfig, usePolled } from "../hooks";
import { createHref, isCopyable, setPicks, usePicks, type CopyableTrader } from "../picks";
import { SourceTag } from "../Tags";
import { TraderAvatar, traderSeed } from "../TraderAvatar";
import { traderName } from "../TraderIdentity";
import { TraderLookup, type AddResult } from "../TraderLookup";
import { WINDOWS, applyFilter, matchesQuery, sortTraders, windowLong, type TraderFilter, type TraderSort } from "./explore";
import { IndexerStatus } from "./IndexerStatus";
import { TRADER_GRID, TraderCard, TraderCardSkeleton } from "./TraderCard";
import { TraderToolbar } from "./TraderToolbar";

export { WINDOWS };

const PAGE = 12;

export function LeaderboardPicker({ initialWindow }: { initialWindow: LeaderboardWindow }) {
  const [win, setWin] = useState<LeaderboardWindow>(initialWindow);
  const [filter, setFilter] = useState("");
  const [chip, setChip] = useState<TraderFilter>("all");
  const [sort, setSort] = useState<TraderSort>("pnl");
  const [shown, setShown] = useState(PAGE);
  const [notice, setNotice] = useState<string | null>(null);
  const { config: cfg } = useAppConfig();
  const max = cfg.maxTradersPerAgent;
  const picks = usePicks();
  const board = usePolled<LeaderboardDTO>(`/api/traders?window=${win}&limit=100`, 60_000);
  const now = useNow(15_000);
  const clock = Math.max(now, board.fetchedAt ?? 0);

  const pickedWallets = useMemo(() => new Set(picks.map((p) => p.wallet)), [picks]);
  const rows = useMemo(
    () => sortTraders(applyFilter(board.data?.traders ?? [], chip).filter((t) => matchesQuery(t, filter)), sort),
    [board.data, chip, filter, sort],
  );
  const data = board.data;
  const winLong = windowLong(win);
  const narrowed = chip !== "all" || filter.trim() !== "";

  function add(t: CopyableTrader): AddResult {
    if (pickedWallets.has(t.wallet)) return "duplicate";
    if (picks.length >= max) return "full";
    setPicks([...picks, t]);
    return "added";
  }

  function toggle(t: TraderDTO) {
    if (!isCopyable(t)) return;
    if (pickedWallets.has(t.wallet)) {
      setPicks(picks.filter((p) => p.wallet !== t.wallet));
      setNotice(null);
    } else if (add(t) === "full") {
      setNotice(`Max ${max} traders per agent. Unpick one to add ${traderName(t)}.`);
    } else {
      setNotice(null);
    }
  }

  function chooseWindow(w: LeaderboardWindow) {
    setWin(w);
    setShown(PAGE);
    try {
      window.history.replaceState(null, "", `?window=${w}`);
    } catch {
      // cosmetic only
    }
  }

  function clearFilters() {
    setChip("all");
    setFilter("");
    setShown(PAGE);
  }

  const topThree = (data?.traders ?? []).slice(0, 3).map((t) => ({ seed: traderSeed(t), label: traderName(t) }));
  // Before the worker's first seed sync the count is 0; say "the wallets we track" rather than "0 wallets".
  const tracked = data && data.universe.tracked > 0 ? data.universe.tracked.toLocaleString("en-US") : null;

  return (
    <div className="page gap-5">
      <HeroBanner
        id="lb-title"
        title={["FOMO", "leaderboard"]}
        robots={["coco", "rex", "juno"]}
        stackActions
        actions={
          <>
            <ButtonLink href="/" variant="white" iconEnd="arrow">
              Explore traders
            </ButtonLink>
            <ButtonLink href={createHref(picks)} variant="ink" iconEnd="arrow">
              Build an agent
            </ButtonLink>
          </>
        }
      >
        Rankings computed on-chain from the FOMO trades of {tracked ?? "the"} wallets we track: realized profit in USDC,
        first-in-first-out, after FOMO&apos;s fees. Not affiliated with FOMO.
      </HeroBanner>

      {/* freshness + indexer status + how picking works, and "paste any wallet" on the right */}
      <Card className="grid gap-5 p-4 sm:p-5 lg:grid-cols-[minmax(0,1fr)_minmax(300px,400px)] lg:items-center">
        <div className="flex min-w-0 items-center gap-5">
          <CopyDesk originals={topThree} agentSeed="leaderboard-agent" size={64} className="shrink-0 max-app:hidden" />
          <div className="min-w-0">
            <Kicker className="mb-2 max-app:hidden">FOMO traders · Solana · ranked by copyfomo</Kicker>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[12px] font-medium text-muted">
              {data ? <SourceTag source={data.source} /> : null}
              {data?.source === "onchain" ? (
                <span className={cn("inline-flex items-center gap-1", data.stale && "font-semibold text-warn")}>
                  <Icon name="clock" size={12} strokeWidth={2} className={data.stale ? undefined : "text-icon"} />
                  updated {timeAgo(data.capturedAt, clock)}
                </span>
              ) : null}
              {data?.source === "onchain" ? (
                <span className="inline-flex items-center gap-1">
                  <Icon name="podium" size={12} strokeWidth={2} className="text-icon" />
                  {data.universe.ranked.toLocaleString("en-US")} ranked
                </span>
              ) : null}
            </div>
            <IndexerStatus className="mt-1.5" />
            <p className="mt-2.5 max-w-xl text-[13.5px] leading-relaxed text-text-2">
              Pick up to {max} traders and your agent mirrors their {cfg.copyVenue === "fomo" ? "FOMO " : ""}buys and
              sells on Solana the moment they land on-chain.
            </p>
          </div>
        </div>
        <TraderLookup id="lb-lookup" onAdd={add} max={max} className="min-w-0" />
      </Card>

      <TraderToolbar
        filter={chip}
        onFilter={(v) => {
          setChip(v);
          setShown(PAGE);
        }}
        win={win}
        onWindow={chooseWindow}
        sort={sort}
        onSort={(v) => {
          setSort(v);
          setShown(PAGE);
        }}
        search={
          <FilterField
            value={filter}
            onChange={(v) => {
              setFilter(v);
              setShown(PAGE);
            }}
          />
        }
      />

      {data?.source === "seed" ? (
        <Notice tone="amber" title="Rankings are warming up.">
          We&apos;re still indexing these wallets&apos; FOMO trades. They&apos;re listed unranked from our curated list
          until each has enough history. You can still copy them.
        </Notice>
      ) : null}
      {data?.source === "onchain" && data.stale ? (
        <Notice tone="dim" title="Stale rankings">
          Rankings last updated {timeAgo(data.capturedAt, clock)} — the indexer may be offline.
        </Notice>
      ) : null}

      <section aria-labelledby="lb-list-title" className="min-w-0">
        <h2 id="lb-list-title" className="sr-only">
          Traders, {winLong} window
        </h2>
        <p role="status" className="sr-only">
          {data ? `${rows.length} ${rows.length === 1 ? "trader" : "traders"}${narrowed ? " match" : ""}` : ""}
        </p>
        {board.loading ? (
          <ul aria-busy="true" aria-label="Loading traders" className={TRADER_GRID}>
            {Array.from({ length: 8 }, (_, i) => (
              <TraderCardSkeleton key={i} index={i} />
            ))}
          </ul>
        ) : !data ? (
          <EmptyState
            tone="down"
            title="Leaderboard didn't load"
            art={<PixelRobot name="byte" mood="rekt" size={96} />}
            action={
              <Button variant="outline" size="sm" icon="refresh" onClick={board.refresh}>
                Try again
              </Button>
            }
          >
            {board.error ? errorMessage(board.error) : "Unknown error."} You can still paste a wallet above.
          </EmptyState>
        ) : rows.length === 0 ? (
          <EmptyState
            title={narrowed ? "No match" : "Nobody here yet"}
            art={narrowed ? <PixelRobot name="juno" mood="thinking" size={96} /> : <PixelRobot name="tofu" size={96} />}
            action={
              narrowed ? (
                <Button variant="outline" size="sm" icon="x" onClick={clearFilters}>
                  Clear filters
                </Button>
              ) : null
            }
          >
            {narrowed
              ? filter.trim()
                ? `No trader in this window matches “${filter.trim()}”.`
                : "No trader in this window passes this filter."
              : `No FOMO trades from the wallets we track in the last ${winLong}. Try a longer window, or paste a wallet above.`}
          </EmptyState>
        ) : (
          <>
            <ul aria-label={`Traders, ${winLong} window`} className={TRADER_GRID}>
              {rows.slice(0, shown).map((t) => (
                <TraderCard
                  key={t.wallet}
                  trader={t}
                  window={win}
                  third={sort === "copiers" ? "copiers" : "trades"}
                  pick={{ picked: pickedWallets.has(t.wallet), onToggle: toggle, now: clock }}
                />
              ))}
            </ul>
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
              <p className="text-[12.5px] font-medium text-muted">
                Showing {Math.min(shown, rows.length)} of {rows.length}
                {narrowed ? " matching" : ""} {rows.length === 1 ? "trader" : "traders"}
              </p>
              {rows.length > shown ? (
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" size="sm" icon="plus" onClick={() => setShown((n) => n + PAGE)}>
                    Show {Math.min(PAGE, rows.length - shown)} more
                  </Button>
                  {rows.length - shown > PAGE ? (
                    <Button variant="ghost" size="sm" onClick={() => setShown(rows.length)}>
                      Show all {rows.length}
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </div>
          </>
        )}
      </section>

      <HowWeRank windowLabel={winLong} rules={data?.rules ?? null} tracked={tracked} copyVenue={cfg.copyVenue} />

      <p className="px-1 text-[12.5px] leading-relaxed text-muted">
        Computed by copyfomo from public Solana data; not affiliated with FOMO, and numbers will differ from FOMO&apos;s
        app. Copy-trading memecoins is risky. A hot PnL is not a promise; traders dump, rug and go quiet. Start small.
      </p>

      <ActionBar picks={picks} max={max} notice={notice} />
    </div>
  );
}

// ── toolbar bits ────────────────────────────────────────────────────────────────────────────────────────────────

/** Live text filter over the loaded list (no submit: results update as you type). */
function FilterField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <label
      className={cn(
        "flex h-11 w-full min-w-0 items-center gap-2 rounded-full border border-border bg-card pl-3.5 pr-1.5 shadow-pill app:h-9",
        "transition-[border-color,box-shadow] duration-150 focus-within:border-mint-400 focus-within:shadow-[0_0_0_4px_rgb(47_191_174/0.16),var(--shadow-pill)]",
      )}
    >
      <Icon name="search" size={15} strokeWidth={2} className="shrink-0 text-icon" />
      <span className="sr-only">Filter this list by name, handle, wallet or $token</span>
      <input
        id="lb-filter"
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Name, @handle, wallet or $token"
        autoComplete="off"
        spellCheck={false}
        className="h-full min-w-0 flex-1 border-0 bg-transparent text-[13px] font-medium text-text outline-none placeholder:font-normal placeholder:text-muted max-app:text-base [&::-webkit-search-cancel-button]:hidden"
      />
      {value ? (
        <button
          type="button"
          onClick={() => onChange("")}
          aria-label="Clear the filter"
          className="grid size-9 shrink-0 place-items-center rounded-full text-icon transition-colors duration-150 hover:bg-card-2 hover:text-text focus-visible:outline-2 focus-visible:outline-focus app:size-7"
        >
          <Icon name="x" size={14} strokeWidth={2.2} />
        </button>
      ) : null}
    </label>
  );
}

// ── method notes + the sticky build bar ─────────────────────────────────────────────────────────────────────────

/** Collapsible method + honesty notes (design §4.4 and §7). */
function HowWeRank({
  windowLabel,
  rules,
  tracked,
  copyVenue,
}: {
  windowLabel: string;
  rules: RankingRulesDTO | null;
  tracked: string | null;
  copyVenue: AppConfigDTO["copyVenue"];
}) {
  const lead = "font-semibold text-text";
  return (
    <details className="group rounded-card border border-hairline bg-card shadow-card">
      <summary
        className={cn(
          "flex min-h-14 cursor-pointer list-none items-center justify-between gap-4 rounded-card px-5 py-3 sm:px-6",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus [&::-webkit-details-marker]:hidden",
        )}
      >
        <span className="flex items-center gap-3">
          <span aria-hidden className="grid size-9 place-items-center rounded-icon border border-mint-200 bg-mint-50 text-mint-700">
            <Icon name="podium" size={17} strokeWidth={2} />
          </span>
          <span className="text-[15px] font-bold tracking-[-0.01em] text-text">How we rank</span>
        </span>
        <span
          aria-hidden
          className="grid size-7 shrink-0 place-items-center rounded-full border border-border bg-card text-text-2 shadow-mini transition-colors duration-150 group-open:border-ink group-open:bg-ink group-open:text-on-ink"
        >
          <Icon name="plus" size={14} strokeWidth={2.2} className="group-open:hidden" />
          <Icon name="minus" size={14} strokeWidth={2.2} className="hidden group-open:block" />
        </span>
      </summary>
      <div className="flex flex-col gap-4 border-t border-border px-5 pb-6 pt-4 text-[13.5px] leading-relaxed text-text-2 sm:px-6">
        {rules ? (
          <p>
            <span className={lead}>To be ranked over {windowLabel}</span>, a wallet needs at least {rules.minTrades} FOMO
            trades, {fmtUsd(rules.minVolumeUsd, false)} of volume, trades on {rules.minActiveDays} different day
            {rules.minActiveDays === 1 ? "" : "s"}, and our full history for the window. Ranked by realized profit, then
            volume. Unranked rows (—) are still indexing or don&apos;t meet the minimums yet.
          </p>
        ) : null}
        <ul className="flex list-disc flex-col gap-2 pl-5 marker:text-icon">
          <li>
            <span className={lead}>Not FOMO&apos;s leaderboard.</span> Computed by copyfomo from public Solana
            transactions. We&apos;re not affiliated with FOMO, and our numbers will differ from FOMO&apos;s app.
          </li>
          <li>
            <span className={lead}>A limited set of wallets.</span> &quot;Top&quot; means top among the{" "}
            {tracked ? `${tracked} ` : ""}wallets we index. Our starting list came from a third-party 30-day leaderboard that counts
            trades on every app; we rank FOMO trades only.
          </li>
          <li>
            <span className={lead}>Method.</span> Realized profit, first-in-first-out, in USDC after FOMO&apos;s fees.
            Sells of tokens with no known cost (bought before our history, received by transfer, or bought elsewhere) are
            left out, never guessed. Unrealized value uses Jupiter spot prices and never affects rank.
          </li>
          <li>
            <span className={lead}>Cross-chain trades aren&apos;t counted.</span> FOMO trades on other chains (Base, BNB,
            Robinhood Chain…) settle off Solana. They&apos;re excluded from PnL and never copied; &quot;cross-chain N%&quot;
            shows how much of a trader&apos;s buying went there.
          </li>
          <li>
            <span className={lead}>Partial history.</span> The badge means we only have this wallet&apos;s trades for part
            of the window. Our detection works from Jan 6, 2026 onward, and depends on FOMO&apos;s current on-chain
            fingerprint.
          </li>
          <li>
            <span className={lead}>Handles are labels, not proofs.</span> They come from our list or Helius identity
            labels; ✓ means a Helius label. We never label a wallet from what someone types.
          </li>
          <li>
            <span className={lead}>A copy isn&apos;t the same trade.</span> The trader swaps USDC with gas paid by FOMO;
            your agent swaps SOL through Jupiter a moment later, with slippage.{" "}
            {copyVenue === "fomo"
              ? "Agents copy FOMO buys only, and sells of tokens they hold from any app."
              : "Agents copy every Solana buy and sell these wallets make."}{" "}
            Past PnL is no promise.
          </li>
        </ul>
      </div>
    </details>
  );
}

function ActionBar({ picks, max, notice }: { picks: CopyableTrader[]; max: number; notice: string | null }) {
  const n = picks.length;
  const shown = picks.slice(0, 5);
  return (
    <div className="sticky bottom-[calc(var(--shell-bottom-inset)+12px)] z-20 mt-1">
      {notice ? (
        <p role="status" className="mb-2 rounded-field bg-down px-3.5 py-2 text-[12.5px] font-semibold text-on-ink shadow-float">
          {notice}
        </p>
      ) : (
        <span role="status" className="sr-only">
          {n} of {max} traders selected
        </span>
      )}
      <div className="flex items-center gap-3 rounded-[18px] bg-ink p-2 pl-3 text-on-ink shadow-[0_18px_40px_-16px_rgb(0_0_0/0.55),inset_0_1px_0_rgb(255_255_255/0.08)]">
        {n ? (
          <span className="flex shrink-0 -space-x-2" aria-hidden>
            {shown.map((p, i) => (
              <span key={p.wallet} className={i >= 3 ? "hidden sm:block" : "block"}>
                <TraderAvatar trader={p} size={32} ring />
              </span>
            ))}
          </span>
        ) : (
          <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-icon bg-on-ink/10">
            <PixelRobot seed="empty-pick" variant="agent" mood="sleep" size={32} />
          </span>
        )}
        <div className="min-w-0 flex-1">
          <p className="text-[13.5px] font-bold leading-none">
            {n}/{max} <span className="hidden sm:inline">selected</span>
          </p>
          <p className="mt-1 hidden truncate text-[12px] font-medium text-on-ink/65 sm:block">
            {n ? picks.map((p) => traderName(p)).join(", ") : "Pick traders above, or paste a wallet."}
          </p>
        </div>
        {n ? (
          <button
            type="button"
            onClick={() => setPicks([])}
            className="hidden h-10 rounded-full px-3 text-[12.5px] font-semibold text-on-ink/75 transition-colors duration-150 hover:bg-on-ink/10 hover:text-on-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-mint-300 sm:block"
          >
            Clear
          </button>
        ) : null}
        {n ? (
          <ButtonLink href={createHref(picks)} variant="white" iconEnd="arrow" className="shrink-0">
            <span className="sm:hidden">Build · {n}</span>
            <span className="hidden sm:inline">Build agent with {n}</span>
          </ButtonLink>
        ) : (
          // disabled on the ink bar: a faint white fill, 55 % white text (a grey pill would read muddy here)
          <button
            type="button"
            disabled
            className="inline-flex h-11 shrink-0 cursor-not-allowed items-center rounded-full bg-on-ink/10 px-4 text-[13px] font-bold text-on-ink/55 app:h-9"
          >
            Pick a trader
          </button>
        )}
      </div>
    </div>
  );
}
