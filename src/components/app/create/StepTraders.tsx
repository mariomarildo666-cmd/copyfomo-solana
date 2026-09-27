"use client";

import Link from "next/link";
import { useMemo } from "react";
import type { AppConfigDTO } from "@/lib/types";
import { fmtSignedUsd, shortAddr } from "@/lib/format";
import { PixelRobot } from "@/components/bots/PixelRobot";
import { RobotTile } from "@/components/bots/RobotTile";
import { Icon } from "@/components/ui/icons";
import { Tag, buttonClass, cn } from "@/components/ui/primitives";
import { FieldError } from "../Field";
import type { CopyableTrader } from "../picks";
import { VerifiedMark } from "../Tags";
import { traderSeed } from "../TraderAvatar";
import { traderName } from "../TraderIdentity";
import { lookupNoteText, TraderLookup, type AddResult, type LookupNote } from "../TraderLookup";
import { TraderPickList } from "./TraderPickList";

export type Entry =
  | { key: string; state: "loading"; query: string }
  | { key: string; state: "ok"; trader: CopyableTrader; note: LookupNote }
  | { key: string; state: "error"; query: string; error: string };

const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";

export function StepTraders({
  entries,
  max,
  error,
  copyVenue,
  onAdd,
  onRemove,
  onRetry,
}: {
  entries: Entry[];
  max: number;
  error?: string | null;
  copyVenue: AppConfigDTO["copyVenue"];
  onAdd: (t: CopyableTrader, note: LookupNote) => AddResult;
  onRemove: (key: string) => void;
  onRetry: (key: string) => void;
}) {
  const okCount = entries.filter((e) => e.state === "ok").length;
  // Wallet → entry key, so the list can show what's picked and remove it (entries added from ?t= are keyed by query).
  const keyByWallet = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of entries) {
      if (e.state === "ok") m.set(e.trader.wallet, e.key);
      else m.set(e.query, e.key);
    }
    return m;
  }, [entries]);
  const selectedWallets = useMemo(() => new Set(keyByWallet.keys()), [keyByWallet]);
  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-start justify-between gap-3">
        <p className="text-[14px] leading-relaxed text-text-2">
          {copyVenue === "fomo"
            ? "The originals. Their FOMO buys, and their sells of tokens your agent holds, get mirrored by your agent."
            : "The originals. Every buy and sell they make on Solana gets mirrored by your agent."}
        </p>
        <span
          className="inline-flex h-[26px] shrink-0 items-center gap-1 rounded-full border border-border bg-card-2 px-2.5 text-[12px] font-bold tabular-nums text-text-2"
          aria-label={`${okCount} of ${max} traders`}
        >
          <Icon name="users" size={13} strokeWidth={2} className="text-icon" />
          {okCount}/{max}
        </span>
      </div>

      {entries.length ? (
        <div className="flex flex-col gap-2">
          <h3 className="text-[13px] font-bold text-text-2">Your originals</h3>
          <ul className="flex flex-col gap-2" aria-label="Selected traders">
            {entries.map((e) => (
              <li key={e.key}>
                <EntryRow entry={e} copyVenue={copyVenue} onRemove={onRemove} onRetry={onRetry} />
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="flex items-center gap-3 rounded-card-sm border border-dashed border-border-strong bg-card px-3.5 py-3 text-[13px] font-medium text-muted">
          <PixelRobot name="the-original" mood="thinking" size={32} />
          No originals yet. Pick traders from the list below, or add anyone by wallet or @handle.
        </p>
      )}
      <FieldError>{error}</FieldError>

      <TraderPickList
        selected={selectedWallets}
        full={entries.length >= max}
        max={max}
        onAdd={(t) => onAdd(t, null)}
        onRemove={(wallet) => {
          const key = keyByWallet.get(wallet);
          if (key) onRemove(key);
        }}
      />

      <div className="rounded-card-sm border border-border bg-card-2/60 p-3.5 app:p-4">
        <TraderLookup id="wizard-lookup" onAdd={onAdd} max={max} label="Not on the list? Add any wallet or @handle" />
      </div>

      <Link href="/traders" className={cn("inline-flex w-fit items-center gap-1.5 text-[13px] font-semibold text-mint-700 hover:text-mint-800", FOCUS)}>
        <Icon name="podium" size={14} strokeWidth={2} />
        Open the full FOMO leaderboard
        <Icon name="arrow" size={13} strokeWidth={2} />
      </Link>
    </div>
  );
}

/** Square remove button: 44 px on phones, 36 px from the tablet frame up. */
function RemoveButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={cn(
        "grid size-11 shrink-0 place-items-center rounded-full text-muted transition-colors duration-150 hover:bg-down-bg hover:text-down app:size-9",
        FOCUS,
      )}
    >
      <Icon name="x" size={16} strokeWidth={2.2} />
    </button>
  );
}

function EntryRow({
  entry,
  copyVenue,
  onRemove,
  onRetry,
}: {
  entry: Entry;
  copyVenue: AppConfigDTO["copyVenue"];
  onRemove: (key: string) => void;
  onRetry: (key: string) => void;
}) {
  const removeBtn = (name: string) => <RemoveButton label={`Remove ${name}`} onClick={() => onRemove(entry.key)} />;

  if (entry.state === "loading") {
    return (
      <div className="flex items-center gap-3 rounded-card-sm border border-border bg-card p-2.5 shadow-mini" aria-busy="true">
        <span className="size-10 shrink-0 rounded-icon bg-card-3 animate-blink" />
        <span className="min-w-0 flex-1 text-[12.5px] font-medium text-muted">
          Resolving <span className="addr text-text">{shortAddr(entry.query, 6, 4)}</span>…
        </span>
        {removeBtn(shortAddr(entry.query))}
      </div>
    );
  }

  if (entry.state === "error") {
    return (
      <div className="flex items-center gap-3 rounded-card-sm border border-down/30 bg-down-bg/60 p-2.5">
        <span className="grid size-10 shrink-0 place-items-center rounded-icon bg-card text-down shadow-mini" aria-hidden>
          <Icon name="alert" size={18} strokeWidth={2.2} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="addr block truncate text-[12.5px] text-text">{shortAddr(entry.query, 6, 4)}</span>
          <span className="block text-[12px] font-medium leading-snug text-down-ink">{entry.error}</span>
        </span>
        <button type="button" onClick={() => onRetry(entry.key)} className={buttonClass("outline", "sm", "shrink-0 max-app:h-11")}>
          <Icon name="refresh" size={13} strokeWidth={2.2} />
          Retry
        </button>
        {removeBtn(shortAddr(entry.query))}
      </div>
    );
  }

  const t = entry.trader;
  const name = traderName(t);
  const caveat = lookupNoteText(entry.note, copyVenue);
  const handleShown = !t.displayName && Boolean(t.handle);
  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-card-sm border p-2.5 shadow-mini",
        caveat ? "border-paper-border bg-paper-bg/50" : "border-border bg-card",
      )}
    >
      <RobotTile seed={traderSeed(t)} variant="trader" size="sm" />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-[14px] font-bold tracking-[-0.01em] text-text">{name}</span>
          {handleShown && t.verified ? <VerifiedMark /> : null}
          {t.source === "fomo" ? (
            <Tag>FOMO</Tag>
          ) : (
            <span className="inline-flex shrink-0 items-center rounded-tag border border-dashed border-border-strong bg-card px-1.5 text-[11px] font-semibold leading-4 text-muted">
              Wallet
            </span>
          )}
        </span>
        {/* Wraps on phones instead of squeezing the handle to nothing. */}
        <span className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[12px] font-medium text-muted">
          {t.displayName && t.handle ? (
            <span className="flex min-w-0 max-w-full items-center gap-1 text-text-2">
              <span className="truncate">@{t.handle}</span>
              {t.verified ? <VerifiedMark small /> : null}
              <span aria-hidden>·</span>
            </span>
          ) : null}
          <span className="addr shrink-0 text-[11.5px]">{shortAddr(t.wallet, 6, 6)}</span>
          {t.pnlUsd !== null ? (
            <span className={cn("inline-flex shrink-0 items-center gap-0.5 font-bold", t.pnlUsd >= 0 ? "text-up" : "text-down")}>
              <Icon name={t.pnlUsd >= 0 ? "trend" : "trend-down"} size={12} strokeWidth={2.4} />
              PnL {fmtSignedUsd(t.pnlUsd)}
            </span>
          ) : null}
        </span>
        {caveat ? (
          <span className="mt-1 flex items-start gap-1 text-[12px] font-medium leading-snug text-paper-ink">
            <Icon name="alert" size={12} strokeWidth={2.4} className="mt-0.5 shrink-0" />
            {caveat}
          </span>
        ) : null}
      </span>
      {removeBtn(name)}
    </div>
  );
}
