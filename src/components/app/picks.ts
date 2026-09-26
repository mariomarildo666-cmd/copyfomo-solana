"use client";

// The trader selection shared by /traders and /create, kept in sessionStorage so
// hopping between the picker and the wizard never loses it.

import { useSyncExternalStore } from "react";
import type { TraderDTO } from "@/lib/types";

/** A trader that can actually be copied (has a wallet). Every TraderDTO has one now; kept as a type guard. */
export type CopyableTrader = TraderDTO & { wallet: string };

const STORAGE_KEY = "copyfomo:picks";
const CHANGE_EVENT = "copyfomo:picks";
const EMPTY: CopyableTrader[] = [];

let memoryRaw: string | null = null;
let cache: { raw: string | null; value: CopyableTrader[] } = { raw: null, value: EMPTY };

export function isCopyable(t: TraderDTO): t is CopyableTrader {
  return typeof t.wallet === "string" && t.wallet.length > 0;
}

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const numOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * Storage is user-writable, so rebuild each entry field by field. Labels shown from here are display-only:
 * the server ignores them when an agent is created (it copies labels from its own data).
 */
function normalize(v: unknown): CopyableTrader | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  const wallet = str(o.wallet);
  if (!wallet) return null;
  return {
    wallet,
    handle: str(o.handle),
    displayName: str(o.displayName),
    xHandle: str(o.xHandle),
    avatarUrl: null,
    source: o.source === "fomo" ? "fomo" : "custom",
    verified: o.verified === true,
    rank: numOrNull(o.rank),
    pnlUsd: numOrNull(o.pnlUsd),
    pnlSol: numOrNull(o.pnlSol),
    unrealizedUsd: numOrNull(o.unrealizedUsd),
    volumeUsd: numOrNull(o.volumeUsd),
    trades: numOrNull(o.trades),
    winRate: numOrNull(o.winRate),
    lastTradeAt: str(o.lastTradeAt),
    coverage: o.coverage === "full" || o.coverage === "partial" ? o.coverage : null,
    xchainShare: numOrNull(o.xchainShare),
    topTokens: Array.isArray(o.topTokens) ? o.topTokens.filter((x): x is string => typeof x === "string").slice(0, 5) : [],
    copiers: numOrNull(o.copiers) ?? 0,
  };
}

function parse(raw: string | null): CopyableTrader[] {
  if (!raw) return EMPTY;
  try {
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v)) return EMPTY;
    return v.map(normalize).filter((t): t is CopyableTrader => t !== null);
  } catch {
    return EMPTY;
  }
}

function readRaw(): string | null {
  try {
    return window.sessionStorage.getItem(STORAGE_KEY);
  } catch {
    return memoryRaw;
  }
}

function snapshot(): CopyableTrader[] {
  const raw = readRaw();
  if (raw !== cache.raw) cache = { raw, value: parse(raw) };
  return cache.value;
}

export function setPicks(list: CopyableTrader[]): void {
  const seen = new Set<string>();
  const unique = list.filter((t) => (seen.has(t.wallet) ? false : (seen.add(t.wallet), true)));
  const raw = JSON.stringify(unique);
  memoryRaw = raw;
  try {
    window.sessionStorage.setItem(STORAGE_KEY, raw);
  } catch {
    // memoryRaw keeps it for this page
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, onChange);
  return () => window.removeEventListener(CHANGE_EVENT, onChange);
}

export function usePicks(): CopyableTrader[] {
  return useSyncExternalStore(subscribe, snapshot, () => EMPTY);
}

export function createHref(list: { wallet: string }[]): string {
  return list.length ? `/create?t=${list.map((t) => encodeURIComponent(t.wallet)).join(",")}` : "/create";
}
