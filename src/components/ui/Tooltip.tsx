"use client";

// A small dark tooltip shown on hover and on keyboard focus inside the trigger (CSS only, no timers).
// The trigger (the single child element) gets aria-describedby pointing at the tip. Touch screens get no hover,
// so never hide required information in a tooltip: it only repeats or expands what is already on screen.

import { cloneElement, isValidElement, useId, type ReactElement, type ReactNode } from "react";
import { cn } from "./cn";

export function Tooltip({
  tip,
  children,
  side = "top",
  className,
}: {
  tip: ReactNode;
  /** One focusable element (button, link, or an element with tabIndex={0}). */
  children: ReactElement<{ "aria-describedby"?: string }>;
  side?: "top" | "bottom";
  className?: string;
}) {
  const id = useId();
  const trigger = isValidElement(children) ? cloneElement(children, { "aria-describedby": id }) : children;
  return (
    <span className={cn("group/tip relative inline-flex", className)}>
      {trigger}
      <span
        id={id}
        role="tooltip"
        className={cn(
          "pointer-events-none absolute left-1/2 z-40 w-max max-w-[240px] -translate-x-1/2 rounded-[9px] bg-ink px-2.5 py-1.5 text-left text-[11.5px] font-medium leading-snug text-on-ink shadow-float",
          "invisible opacity-0 transition-opacity duration-150 group-focus-within/tip:visible group-focus-within/tip:opacity-100 group-hover/tip:visible group-hover/tip:opacity-100",
          side === "top" ? "bottom-[calc(100%+8px)]" : "top-[calc(100%+8px)]",
        )}
      >
        {tip}
      </span>
    </span>
  );
}
