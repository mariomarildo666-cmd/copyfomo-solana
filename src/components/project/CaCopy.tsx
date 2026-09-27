"use client";

// The project token's contract address as ONE copy button: an optional label, the address shortened in mono and a
// copy icon. A click copies the FULL address and shows "Copied" in its place (same width, nothing jumps),
// announced politely; the full address is also the button's tooltip.
//   field  inset box filling its card (the token card): sm 30 px, md 36 px, lg 44 px (phones)
//   hero   frosted chip on the mint hero banner
//   chip   outlined pill (the footer)
// hero and chip are 40 px tall on phones, 32 px from the tablet frame up.

import { useEffect, useState } from "react";
import { writeClipboard } from "@/components/app/CopyButton";
import { cn } from "@/components/ui/cn";
import { Icon } from "@/components/ui/icons";
import { shortAddr } from "@/lib/format";

const BASE =
  "inline-flex min-w-0 select-none items-center transition-[background-color,border-color,color] duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";

const FIELD_SIZES = {
  sm: "h-[30px] gap-2 rounded-[9px] px-2.5 text-[11.5px] [&_svg]:size-[13px]",
  md: "h-9 gap-2 rounded-[10px] px-3 text-[12.5px] [&_svg]:size-[14px]",
  lg: "h-11 gap-2.5 rounded-[12px] px-3.5 text-[13px] [&_svg]:size-4",
} as const;

const VARIANTS = {
  field: "w-full border border-border bg-card-2 text-text-2 hover:border-border-strong hover:text-text",
  hero: "h-10 gap-2 rounded-full border border-card/70 bg-card/55 px-3.5 text-[12.5px] text-hero-ink shadow-[0_8px_18px_-12px_rgb(8_80_72/0.55)] hover:bg-card/80 app:h-8 [&_svg]:size-[14px]",
  chip: "h-10 gap-2 rounded-full border border-border-strong bg-card px-3.5 text-[12.5px] text-text shadow-mini hover:bg-card-2 app:h-8 [&_svg]:size-[14px]",
} as const;

export function CaCopy({
  ca,
  symbol,
  variant,
  size = "sm",
  label,
  chars = 4,
  className,
}: {
  ca: string;
  /** Ticker without "$", for the accessible name ("Copy $COPYFOMO contract address"). */
  symbol: string;
  variant: keyof typeof VARIANTS;
  /** field only. */
  size?: keyof typeof FIELD_SIZES;
  /** Short text before the address ("CA", "$COPYFOMO"). */
  label?: string;
  /** Characters kept at each end of the address. */
  chars?: number;
  className?: string;
}) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  useEffect(() => {
    if (state === "idle") return;
    const t = setTimeout(() => setState("idle"), 1600);
    return () => clearTimeout(t);
  }, [state]);

  return (
    <button
      type="button"
      title={ca}
      aria-label={`Copy $${symbol} contract address`}
      onClick={async () => setState((await writeClipboard(ca)) ? "copied" : "failed")}
      className={cn(BASE, VARIANTS[variant], variant === "field" && FIELD_SIZES[size], className)}
    >
      {label ? <span className="shrink-0 font-bold">{label}</span> : null}
      {/* the address and the feedback share one cell, so the button keeps its width */}
      <span className="grid min-w-0 flex-1 text-left">
        <span className={cn("addr col-start-1 row-start-1 truncate", state !== "idle" && "invisible")}>{shortAddr(ca, chars, chars)}</span>
        <span className={cn("col-start-1 row-start-1 truncate font-bold", state === "idle" && "invisible")}>
          {state === "failed" ? "Copy failed" : "Copied"}
        </span>
      </span>
      <Icon
        name={state === "copied" ? "check" : state === "failed" ? "alert" : "copy"}
        strokeWidth={2}
        className={cn("shrink-0", state === "copied" ? (variant === "hero" ? "text-hero-ink" : "text-mint-700") : variant === "hero" ? undefined : "text-icon")}
      />
      <span className="sr-only" aria-live="polite">
        {state === "copied" ? "Contract address copied" : state === "failed" ? "Copy failed. The full address is in the tooltip" : ""}
      </span>
    </button>
  );
}
