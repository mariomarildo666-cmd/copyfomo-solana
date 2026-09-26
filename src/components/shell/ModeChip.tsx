"use client";

// PAPER / LIVE mode chip of the shell (sidebar and phone top bar). The mode comes from the server render (root
// layout), so it never shows "paper" for a live server. The chip opens a small panel with the full, honest
// explanation and the copy engine's heartbeat; the sidebar also shows the heartbeat line under the chip.

import { useEffect, useId, useRef, useState } from "react";
import { useClientConfig, type ClientConfig } from "@/components/providers/AppConfig";
import { cn } from "@/components/ui/cn";

function engineText(cfg: ClientConfig): string {
  return `copy engine ${cfg.workerOnline === null ? "…" : cfg.workerOnline ? "online" : "offline"}`;
}

/** The copy engine's heartbeat as a dot + text line. */
export function EngineStatus({ className }: { className?: string }) {
  const cfg = useClientConfig();
  return (
    <p className={cn("flex items-center gap-1.5 text-[11px] font-medium text-muted", className)}>
      <span
        aria-hidden
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          cfg.workerOnline === null ? "bg-icon" : cfg.workerOnline ? "bg-mint-500 animate-blink" : "bg-down",
        )}
      />
      {engineText(cfg)}
    </p>
  );
}

export function ModeChip({ placement }: { placement: "sidebar" | "topbar" }) {
  const cfg = useClientConfig();
  const live = cfg.mode === "live";
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // One wording everywhere a mode is shown (the ModePill tag says "Paper" / "Live · real SOL" the same way).
  const title = live ? "Live mode" : "Paper mode";
  const short = live ? "Real SOL on mainnet" : "Trades are simulated";
  const explain = live
    ? "Agents trade real SOL on Solana mainnet through Jupiter."
    : "Fills are simulated against live Jupiter quotes. No real SOL moves.";
  const tone = live ? "border-live-border bg-live-bg text-live-ink" : "border-paper-border bg-paper-bg text-paper-ink";
  const dot = (
    <i
      aria-hidden
      className={cn(
        "size-[7px] shrink-0 rounded-full",
        live ? "bg-live-dot shadow-[0_0_0_3px_rgb(229_72_77/0.18)]" : "bg-paper-dot shadow-[0_0_0_3px_rgb(229_163_18/0.18)]",
      )}
    />
  );

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={`${live ? "Live" : "Paper"} mode: ${short}. ${engineText(cfg)}. Details`}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex items-center border text-left transition-[filter] duration-150 hover:brightness-[0.98]",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus",
          tone,
          placement === "sidebar"
            ? "w-full gap-[9px] rounded-[11px] px-2.5 py-2 max-side:justify-center max-side:px-0"
            : "h-8 gap-[7px] rounded-full px-[11px] text-[12px] font-bold",
        )}
      >
        {dot}
        {placement === "sidebar" ? (
          <>
            <span className="flex min-w-0 flex-col leading-[1.3] max-side:hidden">
              <b className="text-[12px] font-bold">{title}</b>
              <small className="text-[11px] font-medium">{short}</small>
            </span>
            <span aria-hidden className="hidden text-[11px] font-extrabold max-side:inline">
              {live ? "L" : "P"}
            </span>
          </>
        ) : (
          <span>{live ? "Live" : "Paper"}</span>
        )}
      </button>

      <div
        id={panelId}
        hidden={!open}
        className={cn(
          "absolute z-50 w-[248px] rounded-[14px] bg-card p-3.5 text-left shadow-float",
          placement === "sidebar" ? "bottom-[calc(100%+8px)] left-0" : "right-0 top-[calc(100%+8px)]",
        )}
      >
        <p className={cn("inline-flex items-center gap-2 rounded-full border px-2 py-0.5 text-[11.5px] font-bold", tone)}>
          {dot}
          {title}
          <span className="font-semibold">· {live ? "real SOL" : "simulated"}</span>
        </p>
        <p className="mt-2.5 text-[12.5px] leading-relaxed text-text-2">{explain}</p>
        <EngineStatus className="mt-2.5" />
      </div>
    </div>
  );
}
