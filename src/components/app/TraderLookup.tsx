"use client";

import { useState, type FormEvent } from "react";
import type { AppConfigDTO, TraderLookupDTO } from "@/lib/types";
import { cn } from "@/components/ui/cn";
import { Button } from "@/components/ui/primitives";
import { api, errorMessage } from "./api";
import { inputClass } from "./Field";
import { useAppConfig } from "./hooks";
import { isCopyable, type CopyableTrader } from "./picks";
import { traderName } from "./TraderIdentity";

export type AddResult = "added" | "duplicate" | "full";
export type LookupNote = TraderLookupDTO["note"];

/** Looks like a FOMO handle (same shape the server accepts), with or without "@". */
const HANDLE_RE = /^@?[A-Za-z0-9_.]{1,40}$/;

type Msg = { tone: "ok" | "warn" | "err"; text: string };

/** The honest caveat for a wallet we could add but couldn't confirm as a FOMO trader. */
export function lookupNoteText(note: LookupNote, copyVenue: AppConfigDTO["copyVenue"]): string | null {
  if (note === "no_fomo_activity") {
    return copyVenue === "fomo"
      ? "No FOMO trades in this wallet's recent history. Agents copy FOMO buys only, so it may never trigger a copy."
      : "No FOMO trades in this wallet's recent history.";
  }
  if (note === "check_unavailable") return "Couldn't check this wallet right now — you can still add it.";
  return null;
}

/** Why a lookup found nobody. Handles only resolve for wallets on our own list. */
export function lookupMissText(query: string): string {
  const q = query.trim();
  if (HANDLE_RE.test(q)) {
    const h = q.replace(/^@+/, "");
    return `We don't have a wallet for @${h}. We only resolve handles for wallets on our list — paste their Solana wallet instead.`;
  }
  return `“${q}” isn't a Solana wallet or a handle we know.`;
}

/**
 * "Paste any wallet or a known @handle" → GET /api/traders/lookup → onAdd.
 * Handles every miss inline so the caller only deals with copyable traders; lookup notes (no FOMO activity,
 * check unavailable) are passed along and shown as a warning.
 */
export function TraderLookup({
  id,
  onAdd,
  max,
  label = "Paste a wallet or a known @handle",
  className,
}: {
  id: string;
  onAdd: (t: CopyableTrader, note: LookupNote) => AddResult;
  max: number;
  label?: string;
  className?: string;
}) {
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg | null>(null);
  const { config } = useAppConfig();
  const copyVenue = config.copyVenue;

  async function submit(e: FormEvent) {
    e.preventDefault();
    const query = q.trim();
    if (!query) {
      setMsg({ tone: "err", text: "Paste a Solana wallet or a known @handle." });
      return;
    }
    if (query.length > 64) {
      setMsg({ tone: "err", text: "That's too long for a wallet or handle." });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const { trader, note } = await api<TraderLookupDTO>(`/api/traders/lookup?q=${encodeURIComponent(query)}`);
      if (!trader || !isCopyable(trader)) {
        setMsg({ tone: "err", text: lookupMissText(query) });
        return;
      }
      const result = onAdd(trader, note);
      const name = traderName(trader);
      const caveat = lookupNoteText(note, copyVenue);
      if (result === "added") {
        setMsg(caveat ? { tone: "warn", text: `Added ${name}. ${caveat}` } : { tone: "ok", text: `Added ${name}.` });
        setQ("");
      } else if (result === "duplicate") {
        setMsg({ tone: "ok", text: `${name} is already in.` });
      } else {
        setMsg({ tone: "err", text: `Max ${max} traders per agent. Remove one first.` });
      }
    } catch (err) {
      setMsg({ tone: "err", text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className={className} noValidate>
      <label htmlFor={id} className="mb-1.5 block text-[12.5px] font-semibold text-text-2">
        {label}
      </label>
      <div className="flex gap-2">
        <input
          id={id}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          // short enough for a phone field next to the Add button; the label above says the rest
          placeholder="Wallet or @handle"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          className={cn(inputClass, "font-mono placeholder:font-sans")}
          aria-invalid={msg?.tone === "err" || undefined}
          aria-describedby={msg ? `${id}-msg` : undefined}
        />
        <Button type="submit" variant="ink" icon={busy ? undefined : "plus"} disabled={busy} aria-busy={busy} className="shrink-0">
          {busy ? "…" : "Add"}
        </Button>
      </div>
      <p
        id={`${id}-msg`}
        className={cn(
          "mt-1.5 min-h-4 text-[12px] font-medium leading-snug",
          msg?.tone === "err" ? "text-down" : msg?.tone === "warn" ? "text-warn" : "text-up",
        )}
        aria-live="polite"
      >
        {msg ? (msg.tone === "err" ? "✕ " : msg.tone === "warn" ? "! " : "✓ ") + msg.text : ""}
      </p>
    </form>
  );
}
