// The trader card (mockup v2), one layout for Explore (/) and the leaderboard (/traders): crowned robot tile,
// name + "#rank · @handle", top tokens, then a stats row. No hooks.
//
//  - Explore (default): the name link is stretched over the card (a tap opens the profile); the stats row turns
//    into View / Copy on hover or keyboard focus, and touch screens get a Copy pill instead.
//  - Pick mode (`pick`, the leaderboard): a checkbox is the selection control. The whole card is its label (a click
//    anywhere toggles the pick), the name still links to the profile, and the stats stay put.

import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";
import type { LeaderboardWindow, TraderDTO } from "@/lib/types";
import { fmtSignedUsd, fmtUsd, shortAddr, timeAgo } from "@/lib/format";
import { cn } from "@/components/ui/cn";
import { Icon, type IconName } from "@/components/ui/icons";
import { ButtonLink, Tag } from "@/components/ui/primitives";
import { createHref } from "@/components/landing/model";
import { CoverageTag, VerifiedMark, XchainTag } from "../Tags";
import { TraderAvatar } from "../TraderAvatar";
import { traderHref, traderName } from "../TraderIdentity";
import { XCHAIN_BADGE_MIN, fmtCount, fmtWinRate, namedTokens } from "./explore";

/** The card grid (Explore and the leaderboard): auto-fill columns of at least 250 px, one column on phones. */
export const TRADER_GRID =
  "grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-5 max-[73.75rem]:gap-4 max-app:grid-cols-1 max-app:gap-3";

/** Stats-row item: icon + value, with the label for screen readers and as a tooltip. */
function CardStat({
  icon,
  label,
  tone,
  amount,
  children,
}: {
  icon: IconName;
  label: string;
  tone?: "up" | "down";
  /** A dollar amount: mono (the type rule for amounts). */
  amount?: boolean;
  children: ReactNode;
}) {
  return (
    <span
      title={label}
      className={cn(
        "inline-flex items-center gap-[3px] whitespace-nowrap text-[12px] tabular-nums",
        amount && "num",
        tone === "up" ? "font-semibold text-up" : tone === "down" ? "font-semibold text-down" : "font-medium text-muted",
      )}
    >
      <Icon name={icon} size={11} strokeWidth={2.2} className={tone ? undefined : "text-icon"} />
      <span className="sr-only">{label}: </span>
      {children}
    </span>
  );
}

/** Second line: "#1 · @handle", "#2 · DMTg…UAig", or "#7 · X @handle" when the name already is the wallet. */
function SubLine({ t }: { t: TraderDTO }) {
  const nameIsWallet = !t.displayName && !t.handle;
  let who: ReactNode;
  if (t.displayName && t.handle) {
    who = (
      <span className="flex min-w-0 items-center gap-1">
        <span className="truncate">@{t.handle}</span>
        {t.verified ? <VerifiedMark small /> : null}
      </span>
    );
  } else if (!nameIsWallet) {
    who = <span className="addr truncate text-[11.5px]">{shortAddr(t.wallet)}</span>;
  } else if (t.xHandle) {
    who = (
      <span className="flex min-w-0 items-center gap-1">
        <Icon name="x-logo" size={11} className="shrink-0 text-text-2" />
        <span className="sr-only">X </span>
        <span className="truncate">@{t.xHandle}</span>
      </span>
    );
  } else {
    who = <span className="truncate">no FOMO handle</span>;
  }
  return (
    <p className="mt-0.5 flex min-w-0 items-center gap-[5px] whitespace-nowrap text-[12px] font-medium text-muted">
      <span className="shrink-0 font-bold tabular-nums">
        {t.rank !== null ? (
          <>
            <span className="sr-only">Rank </span>#{t.rank}
          </>
        ) : (
          <span title="Unranked: still indexing, or below the minimums">unranked</span>
        )}
      </span>
      <span aria-hidden>·</span>
      {who}
    </p>
  );
}

export interface TraderPick {
  picked: boolean;
  onToggle: (t: TraderDTO) => void;
  /** Clock for "last trade 3h ago". */
  now: number;
}

export function TraderCard({
  trader: t,
  window: win,
  third = "trades",
  pick,
  className,
}: {
  trader: TraderDTO;
  /** The stats' window, for their labels ("7d realized PnL"). */
  window: LeaderboardWindow;
  /** Third stat: trade count (default) or how many agents copy this trader. */
  third?: "trades" | "copiers";
  /** Leaderboard: the card is a pick toggle (checkbox) instead of View / Copy. */
  pick?: TraderPick;
  className?: string;
}) {
  const name = traderName(t);
  const nameIsWallet = !t.displayName && !t.handle;
  const nameIsHandle = !t.displayName && Boolean(t.handle);
  const tokens = namedTokens(t.topTokens);
  const pnl = t.pnlUsd;
  const copyHref = createHref(t.wallet);
  const copiersLabel = t.copiers > 0 ? `, ${t.copiers} agent${t.copiers === 1 ? "" : "s"} copying` : "";
  const partial = t.coverage === "partial";
  const xchain = t.xchainShare !== null && t.xchainShare >= XCHAIN_BADGE_MIN;
  const cbId = `pick-${t.wallet}`;

  const stats = (
    <>
      <Tag
        tone={t.source === "fomo" ? "default" : "muted"}
        className="mr-auto @max-[200px]:hidden"
        title={t.source === "fomo" ? "Trades on FOMO" : "A wallet added by a copyfomo user"}
      >
        {t.source === "fomo" ? "FOMO" : "Wallet"}
      </Tag>
      <CardStat
        icon={pnl !== null && pnl < 0 ? "trend-down" : "trend"}
        label={`${win} realized PnL`}
        tone={pnl === null || pnl === 0 ? undefined : pnl > 0 ? "up" : "down"}
        amount
      >
        {fmtSignedUsd(pnl)}
      </CardStat>
      <CardStat icon="target" label={`Win rate, ${win}`}>
        {fmtWinRate(t.winRate)}
      </CardStat>
      {third === "copiers" ? (
        <CardStat icon="users" label="Agents copying">
          {fmtCount(t.copiers)}
        </CardStat>
      ) : (
        <CardStat icon="swap" label={`Trades, ${win}`}>
          {fmtCount(t.trades)}
        </CardStat>
      )}
    </>
  );

  return (
    <li
      className={cn(
        "hover-card @container flex min-w-0 flex-col gap-2.5 px-[13px] pb-3 pt-3.5",
        pick && "has-[input:focus-visible]:outline-2 has-[input:focus-visible]:outline-offset-2 has-[input:focus-visible]:outline-focus",
        pick?.picked && "is-picked",
        className,
      )}
      // pick mode: no page curl, it would fold over the checkbox in the top-right corner
      style={pick ? ({ "--curl": "0px" } as CSSProperties) : undefined}
    >
      {pick ? (
        // the whole card is the checkbox's label: a click anywhere toggles the pick (the name link sits above it)
        <label htmlFor={cbId} className="absolute inset-0 z-[1] cursor-pointer rounded-card-sm" aria-hidden />
      ) : null}

      <div className="grid grid-cols-[40px_minmax(0,1fr)_auto] items-center gap-3">
        <TraderAvatar trader={t} size={40} ring={pick?.picked} />
        <div className="min-w-0">
          <h3 className="flex min-w-0 items-center gap-1.5 text-[14px] font-bold leading-[1.3] tracking-[-0.01em]" title={name}>
            <Link
              href={traderHref(t.wallet)}
              className={cn(
                "min-w-0 text-text",
                nameIsWallet ? "overflow-hidden whitespace-nowrap" : "truncate",
                pick
                  ? // above the card-wide label, so the name still opens the profile
                    "relative z-[2] rounded-sm underline-offset-2 hover:text-mint-700 hover:underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus"
                  : // stretched over the whole card: tap / click anywhere opens the profile
                    "focus-visible:outline-none after:absolute after:inset-0 after:z-[1] after:rounded-card-sm after:content-[''] focus-visible:after:outline-2 focus-visible:after:outline-offset-2 focus-visible:after:outline-focus",
              )}
            >
              {nameIsWallet ? (
                <>
                  {/* "Wallet 6nkR…2U7Mb" is already shortened: next to the touch Copy pill, drop the word
                      rather than add a second ellipsis */}
                  <span className="[@media(hover:none)]:@max-[290px]:hidden">Wallet </span>
                  <span className="addr text-[13px]">{shortAddr(t.wallet, 4, 5)}</span>
                </>
              ) : (
                name
              )}
            </Link>
            {nameIsHandle && t.verified ? <VerifiedMark /> : null}
          </h3>
          <SubLine t={t} />
        </div>
        {pick ? (
          <span className="relative grid size-6 place-items-center">
            <input
              id={cbId}
              type="checkbox"
              checked={pick.picked}
              onChange={() => pick.onToggle(t)}
              aria-label={`Pick ${name} for your agent`}
              className="peer absolute inset-0 m-0 size-full cursor-pointer opacity-0"
            />
            <span
              aria-hidden
              className={cn(
                "pointer-events-none grid size-6 place-items-center rounded-[7px] border transition-colors duration-150",
                pick.picked ? "border-mint-700 bg-mint-700 text-on-ink" : "border-border-strong bg-card text-transparent",
              )}
            >
              <Icon name="check" size={14} strokeWidth={3} />
            </span>
          </span>
        ) : (
          <ButtonLink
            href={copyHref}
            size="sm"
            icon="copy"
            aria-label={`Copy ${name}${copiersLabel}`}
            // touch only; the ::after grows the tap target to 44 px
            className="hover-card__touch relative z-[3] pl-3 pr-3.5 after:absolute after:-inset-x-1 after:-inset-y-1.5 after:content-['']"
          >
            Copy
          </ButtonLink>
        )}
      </div>

      <p className="line-clamp-2 min-h-[3em] text-[12.5px] leading-normal text-muted max-app:min-h-0">
        {tokens.length ? (
          <>
            Top:&nbsp;{tokens.join(", ")}
            {t.volumeUsd !== null ? (
              <>
                {/* the dot stays at the end of the line when the volume wraps */}
                &nbsp;·{" "}
                <span className="whitespace-nowrap">
                  <span className="num">{fmtUsd(t.volumeUsd)}</span> volume
                </span>
              </>
            ) : null}
          </>
        ) : t.trades ? (
          <span className="whitespace-nowrap">
            <span className="num">{fmtUsd(t.volumeUsd)}</span> volume
          </span>
        ) : (
          `No FOMO trades in the last ${win}`
        )}
      </p>

      {/* the leaderboard adds what matters when picking: coverage, cross-chain share, recency, copiers */}
      {pick ? (
        <p className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 text-[12px] font-medium text-muted">
          {partial ? <CoverageTag /> : null}
          {xchain ? <XchainTag share={t.xchainShare ?? 0} /> : null}
          <span className="inline-flex items-center gap-1 whitespace-nowrap">
            <Icon name="clock" size={12} strokeWidth={2} className="text-icon" />
            {t.lastTradeAt ? `last trade ${timeAgo(t.lastTradeAt, pick.now)}` : "no recent trade"}
          </span>
          {t.copiers > 0 ? (
            <span className="inline-flex items-center gap-1 whitespace-nowrap">
              <Icon name="users" size={12} strokeWidth={2} className="text-icon" />
              {t.copiers} copying
            </span>
          ) : null}
        </p>
      ) : null}

      {pick ? (
        <div className="flex h-[30px] items-center gap-2 @max-[200px]:gap-2.5">{stats}</div>
      ) : (
        <div className="relative h-[30px]">
          <div className="hover-card__rest flex h-full items-center gap-2 @max-[200px]:gap-2.5">{stats}</div>
          <div className="hover-card__reveal absolute inset-0 z-[3] grid grid-cols-2 gap-2">
            <ButtonLink href={traderHref(t.wallet)} variant="outline" shape="rect" size="xs" icon="eye" aria-label={`View ${name}`}>
              View
            </ButtonLink>
            <ButtonLink href={copyHref} variant="ink" shape="rect" size="xs" icon="copy" aria-label={`Copy ${name}${copiersLabel}`}>
              Copy
              {t.copiers > 0 ? <span className="font-semibold opacity-75">{fmtCount(t.copiers)}</span> : null}
            </ButtonLink>
          </div>
        </div>
      )}
    </li>
  );
}

/** Placeholder card while the list loads (same footprint). */
export function TraderCardSkeleton({ index = 0 }: { index?: number }) {
  return (
    <li aria-hidden className="flex flex-col gap-2.5 rounded-card-sm border border-hairline bg-card px-[13px] pb-3 pt-3.5 shadow-card">
      <div className="flex items-center gap-3">
        <span className="size-10 shrink-0 rounded-icon bg-card-3" />
        <span className="flex flex-1 flex-col gap-2">
          <span className="h-3 w-28 max-w-full rounded-full bg-card-3 animate-blink" style={{ animationDelay: `${index * 90}ms` }} />
          <span className="h-2.5 w-20 rounded-full bg-card-2" />
        </span>
      </div>
      <span className="h-2.5 w-11/12 rounded-full bg-card-2" />
      <span className="h-2.5 w-2/3 rounded-full bg-card-2" />
      <span className="mt-1 flex h-[30px] items-center gap-2">
        <span className="mr-auto h-[18px] w-11 rounded-tag bg-card-2" />
        <span className="h-2.5 w-14 rounded-full bg-card-3" />
        <span className="h-2.5 w-8 rounded-full bg-card-2" />
        <span className="h-2.5 w-8 rounded-full bg-card-2" />
      </span>
    </li>
  );
}
