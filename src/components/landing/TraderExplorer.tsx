"use client";

// The Explore grid on the landing page (mockup v2): filter chips, ranking window, sort and search above a grid of
// trader cards from copyfomo's own FOMO leaderboard (GET /api/traders). The search doubles as the old "who do you
// want to copy?" box: submitting a wallet (or a pasted Solscan / FOMO profile link, or a handle nobody on the list
// matches) opens the create wizard for it.

import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";
import type { LeaderboardWindow } from "@/lib/types";
import { timeAgo } from "@/lib/format";
import { PixelRobot } from "@/components/bots/PixelRobot";
import { SearchField } from "@/components/ui/Input";
import { Button, ButtonLink, DotList, EmptyState } from "@/components/ui/primitives";
import { feeLine } from "@/components/app/fees";
import { Notice } from "@/components/app/Field";
import { SourceTag } from "@/components/app/Tags";
import {
  applyFilter,
  isWalletLike,
  matchesQuery,
  sortTraders,
  windowLong,
  type TraderFilter,
  type TraderSort,
} from "@/components/app/traders/explore";
import { TRADER_GRID as GRID, TraderCard, TraderCardSkeleton } from "@/components/app/traders/TraderCard";
import { TraderToolbar } from "@/components/app/traders/TraderToolbar";
import { useClientConfig } from "@/components/providers/AppConfig";
import { useNow } from "./hooks";
import { createHref } from "./model";
import { isLeaderboard, useApi } from "./useApi";

const PAGE = 12;
const TARGET_RE = /^[A-Za-z0-9_.-]{1,64}$/;

/**
 * Accepts @handle, a raw wallet, or a pasted profile / Solscan link (we only read the last path segment of the
 * URL the visitor pasted; nothing is fetched). Handles resolve only for wallets on our own list.
 */
export function normalizeTarget(raw: string): string {
  let v = raw.trim();
  if (/^https?:\/\//i.test(v)) {
    try {
      const seg = new URL(v).pathname.split("/").filter(Boolean).pop();
      if (seg) v = decodeURIComponent(seg);
    } catch {
      // not a URL after all; validate as-is below
    }
  }
  return v.replace(/^@+/, "");
}

export function TraderExplorer({ defaultWindow = "7d" }: { defaultWindow?: LeaderboardWindow }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [win, setWin] = useState<LeaderboardWindow>(defaultWindow);
  const [filter, setFilter] = useState<TraderFilter>("all");
  const [sort, setSort] = useState<TraderSort>("pnl");
  const [q, setQ] = useState("");
  const [shown, setShown] = useState(PAGE);
  const [error, setError] = useState<string | null>(null);
  const lb = useApi(`/api/traders?window=${win}&limit=100`, isLeaderboard);
  const now = useNow(30_000);
  const { mode, platformFeeBps } = useClientConfig();

  // The hook keeps the previous window's payload until the new one lands: never show it under the new label.
  const current = lb.data?.window === win ? lb.data : null;
  const failed = !current && lb.error !== null && !lb.loading;
  const target = normalizeTarget(q);
  const rows = current ? sortTraders(applyFilter(current.traders, filter).filter((t) => matchesQuery(t, target)), sort) : [];
  const narrowed = filter !== "all" || target !== "";
  const winLong = windowLong(win);

  function reset(next: () => void) {
    next();
    setShown(PAGE);
  }

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!target) {
      inputRef.current?.focus();
      return;
    }
    // A search that matches cards is just a filter; a wallet (or a miss) is someone to copy.
    if (rows.length > 0 && !isWalletLike(target)) {
      setError(null);
      return;
    }
    if (!TARGET_RE.test(target)) {
      setError("That doesn't look like a Solana wallet or a handle.");
      inputRef.current?.focus();
      return;
    }
    setError(null);
    router.push(createHref(target));
  }

  function clearAll() {
    reset(() => {
      setFilter("all");
      setQ("");
      setError(null);
    });
    inputRef.current?.focus();
  }

  return (
    <section id="traders" aria-labelledby="traders-title" className="flex min-w-0 scroll-mt-4 flex-col">
      <h2 id="traders-title" className="sr-only">
        FOMO traders, ranked by copyfomo
      </h2>

      <TraderToolbar
        className="mb-4 mt-5 max-app:mb-3.5 max-app:mt-4"
        filter={filter}
        onFilter={(v) => reset(() => setFilter(v))}
        win={win}
        onWindow={(v) => reset(() => setWin(v))}
        sort={sort}
        onSort={(v) => reset(() => setSort(v))}
        search={
          <form role="search" action="/create" method="get" onSubmit={onSubmit} noValidate>
            <SearchField
              ref={inputRef}
              label="Search traders, or paste any Solana wallet to copy"
              buttonLabel="Search"
              name="t"
              value={q}
              onChange={(e) => {
                const v = e.target.value;
                reset(() => setQ(v));
                if (error) setError(null);
              }}
              placeholder="Search trader or wallet"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? "traders-search-error" : undefined}
              // 16px on phones so iOS doesn't zoom the page on focus
              className="[&_input]:max-app:text-base"
            />
          </form>
        }
      />
      {error ? (
        <p id="traders-search-error" role="alert" className="-mt-1.5 mb-3 text-right text-[12px] font-medium text-down max-app:text-left">
          {error}
        </p>
      ) : null}

      {current?.source === "seed" ? (
        <Notice tone="amber" title="Rankings are warming up." className="mb-4">
          We&apos;re still indexing these wallets&apos; FOMO trades. They&apos;re listed unranked from our curated list
          until each has enough history. You can still copy them.
        </Notice>
      ) : null}

      <p role="status" className="sr-only">
        {current ? `${rows.length} ${rows.length === 1 ? "trader" : "traders"}${narrowed ? " match" : ""}, ${winLong} window` : ""}
      </p>

      {!current && !failed ? (
        <ul aria-busy="true" aria-label="Loading traders" className={GRID}>
          {Array.from({ length: 8 }, (_, i) => (
            <TraderCardSkeleton key={i} index={i} />
          ))}
        </ul>
      ) : failed ? (
        <EmptyState
          tone="down"
          title="Leaderboard unavailable"
          art={<PixelRobot name="byte" mood="rekt" size={96} />}
          action={
            <Button variant="outline" size="sm" icon="refresh" onClick={lb.reload}>
              Try again
            </Button>
          }
        >
          {lb.error ?? "Couldn't load the leaderboard."} You can still paste any wallet above to copy it.
        </EmptyState>
      ) : current && current.traders.length === 0 ? (
        <EmptyState title="No FOMO trades yet" art={<PixelRobot name="tofu" size={96} />}>
          None of the wallets we track traded on FOMO in the last {winLong}. Try a longer window, or paste any wallet
          above.
        </EmptyState>
      ) : rows.length === 0 ? (
        <EmptyState
          title="No traders match"
          art={<PixelRobot name="juno" mood="thinking" size={96} />}
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <Button variant="outline" size="sm" icon="x" onClick={clearAll}>
                Clear filters
              </Button>
              {target && TARGET_RE.test(target) ? (
                <ButtonLink href={createHref(target)} size="sm" icon="copy">
                  Copy {isWalletLike(target) ? "this wallet" : `@${target}`}
                </ButtonLink>
              ) : null}
            </div>
          }
        >
          Try another filter, or paste any Solana wallet to copy it.
        </EmptyState>
      ) : (
        <ul aria-label={`Traders, ${winLong} window`} className={GRID}>
          {rows.slice(0, shown).map((t) => (
            <TraderCard key={t.wallet} trader={t} window={win} third={sort === "copiers" ? "copiers" : "trades"} />
          ))}
        </ul>
      )}

      {current && rows.length > 0 ? (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <p className="text-[12.5px] font-medium text-muted">
            Showing {Math.min(shown, rows.length)} of {rows.length}
            {narrowed ? " matching" : ""} {rows.length === 1 ? "trader" : "traders"}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {rows.length > shown ? (
              <Button variant="outline" size="sm" icon="plus" onClick={() => setShown((n) => n + PAGE)}>
                Show more
              </Button>
            ) : null}
            <ButtonLink href={`/traders?window=${win}`} variant="ghost" size="sm" iconEnd="arrow">
              Full leaderboard
            </ButtonLink>
          </div>
        </div>
      ) : null}

      {/* phrases, not a sentence: on phones they stack, elsewhere a wrapped line never starts with a "·" */}
      <div className="mt-5 flex flex-col items-center gap-2 text-center text-[12px] leading-relaxed text-muted">
        {current ? <SourceTag source={current.source} /> : null}
        <DotList
          items={[
            "Rankings computed on-chain by copyfomo",
            "realized profit in USDC, after FOMO's fees",
            current?.source === "onchain" ? (
              <span className={current.stale ? "font-semibold text-warn" : undefined}>
                updated {timeAgo(current.capturedAt, Math.max(now, Date.parse(current.capturedAt)))}
                {current.stale ? " (the indexer may be offline)" : ""}
              </span>
            ) : null,
            "not affiliated with FOMO",
          ]}
        />
        <DotList
          items={[
            mode === "live" ? "Live: agents trade real SOL" : "Paper mode: simulated SOL, nothing real moves",
            "fund from your wallet in one click",
            feeLine(platformFeeBps).toLowerCase(),
            "copy-trading memecoins is risky",
          ]}
        />
      </div>
    </section>
  );
}
