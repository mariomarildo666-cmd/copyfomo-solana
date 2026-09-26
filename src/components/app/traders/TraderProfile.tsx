// A trader's copyfomo profile (/traders/[wallet]): who they are as far as we honestly know, their FOMO
// performance per window, per-token PnL, open positions and latest FOMO trades — all computed by copyfomo from
// public Solana data. No hooks: rendered on the server; the page re-renders it every 5 minutes (AutoRefresh).
// Never import src/lib runtime code here (types/format only): anything the page needs is passed in.
//
// Layout (mockup v2): the shared ProfileHeader (teal band, the trader's crowned pixel robot on its accent tile,
// identity, rank pills, the big "Copy this trader" CTA; the agent dashboard uses the same header), one Performance
// card with a 24h / 7d / 30d tab switch, then light table cards of ten rows with "Show all". Widths are container
// queries on the page (`@container`), so the layout follows the space the shell leaves, not the viewport.
// Type rule: amounts (USD, SOL, token quantities) and mints are mono; counts, percentages, words and times are not.

import Link from "next/link";
import type { ReactNode } from "react";
import type {
  AppConfigDTO,
  FomoTradeDTO,
  LeaderboardWindow,
  RankingRulesDTO,
  TraderDetailDTO,
  TraderWindowStatsDTO,
} from "@/lib/types";
import { fmtSignedSol, fmtSignedUsd, fmtUsd, shortAddr, solscanAccount, solscanTx, timeAgo, tokenLabel } from "@/lib/format";
import { Icon, type IconName } from "@/components/ui/icons";
import { ButtonLink, Card, Pill, PixelSigned, Tag, cn } from "@/components/ui/primitives";
import { createHref } from "@/components/landing/model";
import { ProfileHeader } from "../ProfileHeader";
import { CoverageTag, SideTag, VerifiedMark, XchainTag } from "../Tags";
import { fomoProfileUrl, traderName, xProfileUrl } from "../TraderIdentity";
import { AutoRefresh, MoreRows, PickButton, WindowTabs } from "./ProfileClient";

const WINDOW_LABEL: Record<LeaderboardWindow, string> = { "24h": "24 hours", "7d": "7 days", "30d": "30 days" };
const WINDOW_ORDER: readonly LeaderboardWindow[] = ["24h", "7d", "30d"];
const XCHAIN_BADGE_MIN = 0.05;

const ROUTERS: Record<string, string> = {
  dflow: "DFlow",
  jupiter: "Jupiter",
  okx: "OKX",
  fomo_legacy: "FOMO legacy",
  unknown: "unknown",
};

const EXT = { target: "_blank", rel: "noopener noreferrer" } as const;

/** Long tables show ten rows; MoreRows reveals the rest. */
const SHOWN = 10;
/** Rows past the first SHOWN: hidden until MoreRows flips data-more to "all". */
const MORE_ROW = "group-data-[more=some]/more:hidden";
const moreRow = (i: number) => (i >= SHOWN ? MORE_ROW : undefined);

const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";
/** A Tag that reads as secondary information ("Wallet", "handle unverified"). */
const MUTED_TAG =
  "inline-flex shrink-0 items-center rounded-tag border border-dashed border-border-strong bg-card px-1.5 text-[11px] font-semibold leading-4 text-muted";

// ── formatting ──────────────────────────────────────────────────────────────────────────────────────

function fmtAmount(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n >= 1_000_000) return n.toLocaleString("en-US", { notation: "compact", maximumFractionDigits: 2 });
  if (n >= 1) return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  return n.toLocaleString("en-US", { maximumSignificantDigits: 4 });
}

/** Exact-ish dollars for small amounts (a $12.40 trade shouldn't read "$12"). */
function fmtDollars(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  if (Math.abs(n) >= 1000) return fmtUsd(n);
  const sign = n < 0 ? "−" : "";
  return `${sign}$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtSignedDollars(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return `${n > 0 ? "+" : ""}${fmtDollars(n)}`;
}

function pct(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return `${Math.round(n * 100)}%`;
}

function toneOf(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n) || n === 0) return "text-muted";
  return n > 0 ? "text-up" : "text-down";
}

// ── small pieces ────────────────────────────────────────────────────────────────────────────────────

/** Outbound link chip (outline pill; 40 px tall on phones). */
function ExtLink({ href, children, title, icon }: { href: string; children: ReactNode; title?: string; icon?: IconName }) {
  return (
    <a
      href={href}
      {...EXT}
      title={title}
      className={cn(
        "inline-flex h-10 items-center gap-1.5 rounded-full border border-border-strong bg-card px-3 text-[12.5px] font-semibold text-text-2 shadow-mini app:h-8",
        "transition-colors duration-150 hover:bg-card-2 hover:text-text",
        FOCUS,
      )}
    >
      {icon ? <Icon name={icon} size={13} strokeWidth={2} className="text-icon" /> : null}
      {children}
      <Icon name="external" size={12} strokeWidth={2.2} className="text-icon" />
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}

/** Card header: title + a muted note (what the numbers are). */
function CardHead({ id, title, note, icon }: { id: string; title: string; note?: ReactNode; icon: IconName }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-4 pb-3 pt-4 app:px-5">
      <h2 id={id} className="flex items-center gap-2 text-[16px] font-extrabold tracking-[-0.015em] text-text">
        <span className="grid size-7 place-items-center rounded-[9px] bg-mint-50 text-mint-700 ring-1 ring-mint-200 ring-inset">
          <Icon name={icon} size={15} strokeWidth={2} />
        </span>
        {title}
      </h2>
      {note ? <span className="text-[12px] font-medium text-muted">{note}</span> : null}
    </div>
  );
}

function TokenLink({ mint, symbol }: { mint: string; symbol: string | null }) {
  return (
    <a
      href={solscanAccount(mint)}
      {...EXT}
      title={mint}
      className={cn(
        "inline-flex min-h-10 min-w-10 items-center text-[13px] font-semibold text-text underline-offset-2 hover:text-mint-700 hover:underline app:min-h-0 app:min-w-0",
        !symbol && "addr",
        FOCUS,
      )}
    >
      {tokenLabel(symbol, mint)}
      <span className="sr-only"> (token on Solscan, opens in a new tab)</span>
    </a>
  );
}

/** A labelled figure. `amount`: USD / SOL / token quantity, in mono; counts and percentages stay in the body font. */
function Cell({ label, children, amount, className }: { label: string; children: ReactNode; amount?: boolean; className?: string }) {
  return (
    <div className={cn("min-w-0", className)}>
      <dt className="text-[12px] font-medium text-muted">{label}</dt>
      <dd className={cn("mt-0.5 truncate text-[13px] font-semibold tabular-nums text-text", amount && "num")}>{children}</dd>
    </div>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="px-4 pb-4 app:px-5 app:pb-5">
      <p className="rounded-card-sm border border-dashed border-border-strong bg-card-2/60 px-4 py-5 text-center text-[13px] text-muted">
        {children}
      </p>
    </div>
  );
}

/** Light table chrome shared by the three tables. */
const TH = "px-3 py-2.5 text-[12px] font-semibold text-muted first:pl-5 last:pr-5";
const TD = "px-3 py-2.5 first:pl-5 last:pr-5";
const TR = "border-t border-border transition-colors duration-100 hover:bg-card-2/60";
/** Right-aligned figures; add `num` for amounts. */
const NUM = "text-right text-[12.5px] tabular-nums";

// ── header ──────────────────────────────────────────────────────────────────────────────────────────

function Hero({ detail, copyVenue }: { detail: TraderDetailDTO; copyVenue: AppConfigDTO["copyVenue"] }) {
  const t = detail.trader;
  const name = traderName(t);
  const stats30 = detail.stats.find((s) => s.window === "30d") ?? null;
  const ranks = detail.stats.filter((s) => s.rank !== null);
  const xchain = stats30?.xchainShare ?? t.xchainShare;

  return (
    <ProfileHeader
      robot={{ seed: t.wallet, variant: "trader", label: `${name}, a trader` }}
      kicker={t.source === "fomo" ? "FOMO trader" : "Solana wallet"}
      kickerTone={t.source === "fomo" ? "mint" : "muted"}
      title={
        <>
          {name}
          {!t.displayName && t.handle && t.verified ? <VerifiedMark className="ml-2 align-middle" /> : null}
        </>
      }
      subline={
        <>
          {t.handle && t.displayName ? (
            <span className="flex items-center gap-1 font-semibold text-text-2">
              @{t.handle}
              {t.verified ? <VerifiedMark /> : null}
            </span>
          ) : null}
          {t.handle && !t.verified ? (
            <span
              className={MUTED_TAG}
              title="This handle comes from our curated list and isn't confirmed on-chain; it may not be their FOMO handle."
            >
              handle unverified
            </span>
          ) : null}
          <span className="addr break-all text-[12.5px] text-text-2" title={t.wallet}>
            {shortAddr(t.wallet, 6, 6)}
          </span>
        </>
      }
      chips={
        <>
          {t.source === "fomo" ? <Tag>FOMO</Tag> : <span className={MUTED_TAG}>Wallet</span>}
          {ranks.map((s) => (
            <Pill key={s.window} tone="mint" icon="podium">
              #{s.rank} · {s.window}
            </Pill>
          ))}
          {stats30?.coverage === "partial" ? <CoverageTag coveredFrom={stats30.coveredFrom} /> : null}
          {xchain !== null && xchain >= XCHAIN_BADGE_MIN ? <XchainTag share={xchain} /> : null}
          <span className="ml-0.5 inline-flex items-center gap-1 text-[12px] font-medium text-muted">
            <Icon name="users" size={13} strokeWidth={2} className="text-icon" />
            {t.copiers.toLocaleString("en-US")} agent{t.copiers === 1 ? "" : "s"} copying
          </span>
        </>
      }
      links={
        <>
          <ExtLink href={solscanAccount(t.wallet)} title="Wallet on Solscan" icon="sol">
            Solscan
          </ExtLink>
          {/* Only for confirmed handles: an unverified one (often their X handle) could be someone else's FOMO profile. */}
          {t.handle && t.verified ? (
            <ExtLink href={fomoProfileUrl(t.handle)} title={`@${t.handle} on fomo.family`}>
              View on FOMO
            </ExtLink>
          ) : null}
          {t.xHandle ? (
            <ExtLink href={xProfileUrl(t.xHandle)} title={`@${t.xHandle} on X`} icon="x-logo">
              X @{t.xHandle}
            </ExtLink>
          ) : null}
          {detail.evidenceSig ? (
            <ExtLink href={solscanTx(detail.evidenceSig)} title="A FOMO trade by this wallet we detected on-chain" icon="shield">
              FOMO trade evidence
            </ExtLink>
          ) : null}
        </>
      }
      aside={
        <>
          <div className="grid grid-cols-1 gap-2.5 @md:grid-cols-2 @5xl:grid-cols-1">
            <ButtonLink href={createHref(t.wallet)} variant="ink" size="lg" icon="copy" iconEnd="arrow" className="w-full">
              Copy this trader
            </ButtonLink>
            <PickButton trader={t} />
          </div>
          <p className="flex gap-1.5 text-[12px] leading-snug text-muted">
            <Icon name="info" size={14} strokeWidth={2} className="mt-px shrink-0 text-icon" />
            <span>
              {copyVenue === "fomo"
                ? "Your agent copies their FOMO buys on Solana, and their sells of tokens it holds."
                : "Your agent copies their Solana buys and sells."}{" "}
              Cross-chain FOMO trades are not copied.
            </span>
          </p>
        </>
      }
    />
  );
}

// ── window stats ────────────────────────────────────────────────────────────────────────────────────

function rankLine(s: TraderWindowStatsDTO, rules: RankingRulesDTO): string {
  if (s.rank !== null) return `ranked #${s.rank}`;
  if (s.coverage === "partial") return "unranked · partial history";
  if (s.trades === 0) return "unranked · no FOMO trades";
  return `unranked · needs ${rules.minTrades} trades, ${fmtUsd(rules.minVolumeUsd, false)}, ${rules.minActiveDays} days`;
}

function WindowPanel({
  win,
  s,
  rules,
  now,
}: {
  win: LeaderboardWindow;
  s: TraderWindowStatsDTO | null;
  rules: RankingRulesDTO;
  now: number;
}) {
  const label = WINDOW_LABEL[win];
  if (!s) {
    return (
      <div className="flex items-start gap-2 rounded-card border border-dashed border-border-strong bg-card/70 p-5 text-[13px] leading-snug text-muted">
        <Icon name="clock" size={15} strokeWidth={2} className="mt-px shrink-0 text-icon" />
        No {label} stats yet — we&apos;re still indexing this wallet&apos;s FOMO trades.
      </div>
    );
  }
  const pnl = s.realizedPnlUsd;
  return (
    <Card className="@container flex min-w-0 flex-col gap-4 p-4 app:p-5">
      <div className="grid gap-4 @2xl:grid-cols-[minmax(200px,0.8fr)_minmax(0,2fr)] @2xl:gap-6">
        <div className="flex flex-col gap-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-[13px] font-bold text-text-2">Last {label}</p>
            {s.coverage === "partial" ? <CoverageTag coveredFrom={s.coveredFrom} /> : <Pill tone="neutral">full history</Pill>}
          </div>
          <div>
            <p className="text-[12px] font-semibold text-muted">Realized PnL</p>
            <p className={cn("num mt-1 flex items-center gap-1.5 text-[28px] font-semibold leading-none tracking-[-0.04em]", toneOf(pnl))}>
              {Number.isFinite(pnl) && pnl !== 0 ? <Icon name={pnl > 0 ? "trend" : "trend-down"} size={20} strokeWidth={2.4} /> : null}
              <span>
                <PixelSigned text={fmtSignedDollars(pnl)} />
              </span>
            </p>
            <p className={cn("mt-1.5 text-[12.5px]", s.realizedPnlSol === null ? "text-muted" : cn("num", toneOf(s.realizedPnlSol)))}>
              {s.realizedPnlSol === null ? "no SOL price for this window" : fmtSignedSol(s.realizedPnlSol)}
            </p>
          </div>
        </div>

        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 border-t border-border pt-3.5 @md:grid-cols-4 @2xl:border-l @2xl:border-t-0 @2xl:pl-6 @2xl:pt-0">
          <Cell label="Volume" amount>
            {fmtUsd(s.volumeUsd)}
          </Cell>
          <Cell label="Trades">
            {s.trades.toLocaleString("en-US")}{" "}
            <span className="font-medium text-muted">
              ({s.buys} buys, {s.sells} sells)
            </span>
          </Cell>
          <Cell label="Win rate">{pct(s.winRate)}</Cell>
          <Cell label="Active days">{s.activeDays}</Cell>
          <Cell label="Tokens traded">{s.mintsTraded}</Cell>
          <Cell label="Unrealized" amount>
            <span className={toneOf(s.unrealizedPnlUsd)}>{fmtSignedUsd(s.unrealizedPnlUsd)}</span>
          </Cell>
          <Cell label="Cross-chain">
            {s.xchainShare === null ? (
              "—"
            ) : (
              <>
                {pct(s.xchainShare)} · <span className="num">{fmtUsd(s.xchainUsd)}</span>
              </>
            )}
          </Cell>
          <Cell label="Open positions">{s.openPositions}</Cell>
        </dl>
      </div>

      {s.unmatchedSellUsd >= 0.01 ? (
        <p
          className="flex items-start gap-1.5 rounded-[10px] border border-paper-border bg-paper-bg px-2.5 py-2 text-[12px] font-medium leading-snug text-paper-ink"
          title="Sells of tokens bought before our history, received by transfer, or bought elsewhere. Left out of PnL."
        >
          <Icon name="alert" size={13} strokeWidth={2.2} className="mt-px shrink-0" />
          cost basis incomplete: {fmtDollars(s.unmatchedSellUsd)} of sells left out
        </p>
      ) : null}

      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border pt-3 text-[12px] font-medium text-muted">
        {s.rank !== null ? (
          <Pill tone="mint" icon="podium">
            {rankLine(s, rules)}
          </Pill>
        ) : (
          <span>{rankLine(s, rules)}</span>
        )}
        <span className="inline-flex items-center gap-1">
          <Icon name="clock" size={12} strokeWidth={2} className="text-icon" />
          last trade {s.lastTradeAt ? timeAgo(s.lastTradeAt, now) : "—"}
        </span>
      </p>
    </Card>
  );
}

// ── per-mint PnL ────────────────────────────────────────────────────────────────────────────────────

function PerMint({ rows }: { rows: TraderDetailDTO["perMint"] }) {
  const sorted = [...rows].sort((a, b) => Math.abs(b.realizedPnlUsd) - Math.abs(a.realizedPnlUsd)).slice(0, 50);
  return (
    <Card className="@container overflow-hidden" role="region" aria-labelledby="permint-title">
      <CardHead id="permint-title" title="PnL by token" icon="trend" note="30 days · realized, FIFO, after FOMO's fees" />
      {sorted.length === 0 ? (
        <Empty>No FOMO trades in the last 30 days.</Empty>
      ) : (
        <MoreRows total={sorted.length} initial={SHOWN} noun="tokens">
          <div className="hidden overflow-x-auto @lg:block">
            <table className="w-full text-left text-[13px]">
              <thead>
                <tr>
                  <th scope="col" className={TH}>Token</th>
                  <th scope="col" className={cn(TH, "text-right")}>Trades</th>
                  <th scope="col" className={cn(TH, "text-right")}>Realized (USD)</th>
                  <th scope="col" className={cn(TH, "text-right")}>Realized (SOL)</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((m, i) => (
                  <tr key={m.mint} className={cn(TR, moreRow(i))}>
                    <td className={TD}>
                      <TokenLink mint={m.mint} symbol={m.symbol} />
                    </td>
                    <td className={cn(TD, NUM, "text-text-2")}>{m.trades}</td>
                    <td className={cn(TD, NUM, "num font-semibold", toneOf(m.realizedPnlUsd))}>{fmtSignedDollars(m.realizedPnlUsd)}</td>
                    <td className={cn(TD, NUM, "num", toneOf(m.realizedPnlSol))}>{fmtSignedSol(m.realizedPnlSol)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="divide-y divide-border border-t border-border @lg:hidden">
            {sorted.map((m, i) => (
              <li key={m.mint} className={cn("flex items-center justify-between gap-3 px-4 py-2", moreRow(i))}>
                <span className="flex min-w-0 flex-col">
                  <TokenLink mint={m.mint} symbol={m.symbol} />
                  <span className="-mt-1.5 text-[12px] font-medium text-muted">{m.trades} trades</span>
                </span>
                <span className="flex shrink-0 flex-col items-end">
                  <span className={cn("num text-[13px] font-semibold", toneOf(m.realizedPnlUsd))}>{fmtSignedDollars(m.realizedPnlUsd)}</span>
                  <span className={cn("num text-[11.5px]", toneOf(m.realizedPnlSol))}>{fmtSignedSol(m.realizedPnlSol)}</span>
                </span>
              </li>
            ))}
          </ul>
          {rows.length > sorted.length ? (
            <p className="border-t border-border px-5 py-3 text-[12.5px] text-muted">The 50 biggest of {rows.length} tokens.</p>
          ) : null}
        </MoreRows>
      )}
    </Card>
  );
}

// ── open positions ──────────────────────────────────────────────────────────────────────────────────

function Positions({ rows, now }: { rows: TraderDetailDTO["positions"]; now: number }) {
  // Value and unrealized PnL need a Jupiter spot price. When no position has one, the two columns would be all
  // "—": leave them out and say so once; when only some lack one, the dash stays and the note explains it.
  const priced = rows.filter((p) => p.valueUsd !== null).length;
  const showValue = priced > 0;
  const note =
    rows.length === 0 ? null : priced === 0 ? (
      <>No spot price for {rows.length === 1 ? "this token" : "these tokens"} right now, so value and unrealized PnL aren&apos;t shown.</>
    ) : priced < rows.length ? (
      <>— = no spot price right now for that token.</>
    ) : null;
  return (
    <Card className="@container overflow-hidden" role="region" aria-labelledby="tp-positions-title">
      <CardHead id="tp-positions-title" title="Open positions" icon="target" note="from FOMO buys not yet sold · Jupiter spot prices" />
      {rows.length === 0 ? (
        <Empty>No open positions from FOMO buys.</Empty>
      ) : (
        <MoreRows total={rows.length} initial={SHOWN} noun="positions">
          {note ? (
            <p className="flex items-start gap-1.5 border-t border-border bg-card-2/60 px-4 py-2.5 text-[12px] font-medium leading-snug text-muted app:px-5">
              <Icon name="info" size={13} strokeWidth={2} className="mt-px shrink-0 text-icon" />
              <span>{note}</span>
            </p>
          ) : null}
          <div className="hidden overflow-x-auto @lg:block">
            <table className="w-full text-left text-[13px]">
              <thead>
                <tr>
                  <th scope="col" className={TH}>Token</th>
                  <th scope="col" className={cn(TH, "text-right")}>Amount</th>
                  <th scope="col" className={cn(TH, "text-right")}>Cost</th>
                  {showValue ? (
                    <>
                      <th scope="col" className={cn(TH, "text-right")}>Value</th>
                      <th scope="col" className={cn(TH, "text-right")}>Unrealized</th>
                    </>
                  ) : null}
                  <th scope="col" className={cn(TH, "text-right")}>Opened</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p, i) => {
                  const unrealized = p.valueUsd === null ? null : p.valueUsd - p.costUsd;
                  return (
                    <tr key={p.mint} className={cn(TR, moreRow(i))}>
                      <td className={TD}>
                        <TokenLink mint={p.mint} symbol={p.symbol} />
                      </td>
                      <td className={cn(TD, NUM, "num text-text-2")}>{fmtAmount(p.amount)}</td>
                      <td className={cn(TD, NUM, "num text-text-2")}>{fmtDollars(p.costUsd)}</td>
                      {showValue ? (
                        <>
                          <td className={cn(TD, NUM, "num text-text-2")}>
                            {p.valueUsd === null ? (
                              <span className="text-muted" title="No price available">
                                —
                              </span>
                            ) : (
                              fmtDollars(p.valueUsd)
                            )}
                          </td>
                          <td className={cn(TD, NUM, "num font-semibold", toneOf(unrealized))}>{fmtSignedDollars(unrealized)}</td>
                        </>
                      ) : null}
                      <td className={cn(TD, NUM, "whitespace-nowrap text-[12px] text-muted")}>{timeAgo(p.openedAt, now)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <ul className="divide-y divide-border border-t border-border @lg:hidden">
            {rows.map((p, i) => {
              const unrealized = p.valueUsd === null ? null : p.valueUsd - p.costUsd;
              return (
                <li key={p.mint} className={cn("px-4 py-2.5", moreRow(i))}>
                  <div className="flex items-center justify-between gap-3">
                    <TokenLink mint={p.mint} symbol={p.symbol} />
                    <span className="text-[12px] font-medium text-muted">opened {timeAgo(p.openedAt, now)}</span>
                  </div>
                  <dl className={cn("mt-1 grid grid-cols-2 gap-x-3 gap-y-2", showValue && "@xs:grid-cols-4")}>
                    <Cell label="Amount" amount>
                      {fmtAmount(p.amount)}
                    </Cell>
                    <Cell label="Cost" amount>
                      {fmtDollars(p.costUsd)}
                    </Cell>
                    {showValue ? (
                      <>
                        <Cell label="Value" amount>
                          {p.valueUsd === null ? "—" : fmtDollars(p.valueUsd)}
                        </Cell>
                        <Cell label="Unrealized" amount>
                          <span className={toneOf(unrealized)}>{fmtSignedDollars(unrealized)}</span>
                        </Cell>
                      </>
                    ) : null}
                  </dl>
                </li>
              );
            })}
          </ul>
        </MoreRows>
      )}
    </Card>
  );
}

// ── recent trades ───────────────────────────────────────────────────────────────────────────────────

function TxLink({ sig }: { sig: string }) {
  return (
    <a
      href={solscanTx(sig)}
      {...EXT}
      className={cn(
        "inline-flex h-10 min-w-10 items-center justify-center gap-1 rounded-full px-2 text-[12px] font-semibold text-muted hover:bg-card-2 hover:text-mint-700 app:h-7",
        FOCUS,
      )}
    >
      tx
      <Icon name="external" size={12} strokeWidth={2.2} />
      <span className="sr-only"> (Solscan, opens in a new tab)</span>
    </a>
  );
}

function Recent({ rows, now }: { rows: FomoTradeDTO[]; now: number }) {
  return (
    <Card className="@container overflow-hidden" role="region" aria-labelledby="tp-recent-title">
      <CardHead
        id="tp-recent-title"
        title="Recent FOMO trades"
        icon="swap"
        note={rows.length ? `newest ${rows.length} · amounts in USDC` : undefined}
      />
      {rows.length === 0 ? (
        <Empty>No FOMO trades indexed for this wallet yet.</Empty>
      ) : (
        <MoreRows total={rows.length} initial={SHOWN} noun="trades">
          <div className="hidden overflow-x-auto @3xl:block">
            <table className="w-full text-left text-[13px]">
              <thead>
                <tr>
                  <th scope="col" className={TH}>When</th>
                  <th scope="col" className={TH}>Side</th>
                  <th scope="col" className={TH}>Token</th>
                  <th scope="col" className={cn(TH, "text-right")}>Amount</th>
                  <th scope="col" className={cn(TH, "text-right")}>USDC</th>
                  <th scope="col" className={cn(TH, "text-right")}>Realized</th>
                  <th scope="col" className={cn(TH, "hidden pl-4 @4xl:table-cell")}>Route</th>
                  <th scope="col" className={cn(TH, "text-right")}>
                    <span className="sr-only">Transaction</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={r.signature} className={cn(TR, moreRow(i))}>
                    <td className={cn(TD, "whitespace-nowrap text-[12.5px] font-medium text-muted")}>
                      <time dateTime={r.blockTime}>{timeAgo(r.blockTime, now)}</time>
                    </td>
                    <td className={TD}>
                      <span className="flex items-center">
                        <SideTag side={r.side} past />
                      </span>
                    </td>
                    <td className={TD}>
                      <TokenLink mint={r.mint} symbol={r.symbol} />
                    </td>
                    <td className={cn(TD, NUM, "num text-text-2")}>{fmtAmount(r.amount)}</td>
                    <td className={cn(TD, NUM, "num text-text")}>{fmtDollars(r.usd)}</td>
                    <td className={cn(TD, NUM, "num font-semibold", toneOf(r.realizedPnlUsd))}>
                      {r.side === "sell" ? fmtSignedDollars(r.realizedPnlUsd) : <span className="font-normal text-muted">—</span>}
                    </td>
                    <td className={cn(TD, "hidden pl-4 text-[12px] font-medium text-muted @4xl:table-cell")}>{ROUTERS[r.router] ?? r.router}</td>
                    <td className={cn(TD, "py-1.5 text-right")}>
                      <TxLink sig={r.signature} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="divide-y divide-border border-t border-border @3xl:hidden">
            {rows.map((r, i) => (
              <li key={r.signature} className={cn("px-4 py-2", moreRow(i))}>
                <div className="flex items-center justify-between gap-3">
                  <span className="flex min-w-0 items-center gap-2.5">
                    <SideTag side={r.side} past />
                    <TokenLink mint={r.mint} symbol={r.symbol} />
                  </span>
                  <span className="num shrink-0 text-[13px] font-semibold text-text">{fmtDollars(r.usd)}</span>
                </div>
                <div className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[12px] font-medium text-muted">
                  <time dateTime={r.blockTime}>{timeAgo(r.blockTime, now)}</time>
                  <span>
                    <span className="num text-[11.5px]">{fmtAmount(r.amount)}</span> tokens
                  </span>
                  {r.side === "sell" && r.realizedPnlUsd !== null ? (
                    <span className={cn("num text-[11.5px] font-semibold", toneOf(r.realizedPnlUsd))}>
                      {fmtSignedDollars(r.realizedPnlUsd)}
                    </span>
                  ) : null}
                  <span className="-mr-2 ml-auto">
                    <TxLink sig={r.signature} />
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </MoreRows>
      )}
    </Card>
  );
}

// ── page body ───────────────────────────────────────────────────────────────────────────────────────

export function TraderProfile({
  detail,
  now,
  rules,
  copyVenue,
}: {
  detail: TraderDetailDTO;
  /** Render time (ms) for "x ago" labels; passed in so this component stays pure. */
  now: number;
  rules: Readonly<Record<LeaderboardWindow, RankingRulesDTO>>;
  copyVenue: AppConfigDTO["copyVenue"];
}) {
  const byWindow = new Map(detail.stats.map((s) => [s.window, s]));
  return (
    <div className="page @container gap-4 app:gap-5">
      <AutoRefresh />
      <nav aria-label="Breadcrumb" className="-mb-1 mt-1 app:mt-0">
        <Link
          href="/traders"
          className={cn(
            "-ml-2.5 inline-flex h-10 items-center gap-1.5 rounded-full px-2.5 text-[13px] font-semibold text-muted transition-colors hover:bg-card hover:text-text app:h-8",
            FOCUS,
          )}
        >
          <Icon name="arrow-left" size={15} strokeWidth={2.2} />
          FOMO leaderboard
        </Link>
      </nav>

      <Hero detail={detail} copyVenue={copyVenue} />

      <section aria-labelledby="tp-stats-title" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 px-0.5">
          <h2 id="tp-stats-title" className="text-[17px] font-extrabold tracking-[-0.015em] text-text">
            Performance
          </h2>
          <span className="text-[12px] font-medium text-muted">realized profit · FIFO in USDC · after FOMO&apos;s fees</span>
        </div>
        {/* one window at a time, switched like the leaderboard's window (7d first, as on Explore) */}
        <WindowTabs
          label="Performance window"
          defaultId="7d"
          tabs={WINDOW_ORDER.map((w) => ({
            id: w,
            label: w,
            panel: <WindowPanel win={w} s={byWindow.get(w) ?? null} rules={rules[w]} now={now} />,
          }))}
        />
      </section>

      <div className="grid grid-cols-1 gap-4 app:gap-5 @5xl:grid-cols-2 @5xl:items-start">
        <PerMint rows={detail.perMint} />
        <Positions rows={detail.positions} now={now} />
      </div>

      <Recent rows={detail.recent} now={now} />

      <p className="flex items-start gap-2 px-0.5 text-[12.5px] leading-relaxed text-muted">
        <Icon name="info" size={15} strokeWidth={2} className="mt-0.5 shrink-0 text-icon" />
        <span>
          Computed by copyfomo from public Solana data; not affiliated with FOMO, and numbers will differ from FOMO&apos;s
          app. Only trades made in the FOMO app on Solana count. Cross-chain FOMO trades aren&apos;t counted in PnL and
          are never copied. Handles are labels from our list or Helius, not proofs. Past PnL is no promise.
        </span>
      </p>
    </div>
  );
}
