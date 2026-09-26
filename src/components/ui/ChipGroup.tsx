// Single-choice button groups (mockup v2). Buttons carry aria-pressed inside a labelled role="group", the same
// semantics the old ToggleGroup used. No hooks: the parent owns the value. Use from client components.
//
//   ChipGroup  the filter chips above the trader grid ("All · Top PnL · High win rate …"); scrolls sideways on phones
//   Segmented  a compact pill switch ("24h · 7d · 30d")

import type { ReactNode } from "react";
import { cn } from "./cn";

export interface ChoiceOption<T extends string> {
  value: T;
  label: ReactNode;
  /** Optional count shown after the label. */
  count?: number;
  disabled?: boolean;
  /** Accessible label when `label` is not plain text. */
  ariaLabel?: string;
}

interface ChoiceProps<T extends string> {
  /** Accessible name of the group. */
  label: string;
  options: readonly ChoiceOption<T>[];
  value: T;
  onChange: (v: T) => void;
  className?: string;
}

export function ChipGroup<T extends string>({
  label,
  options,
  value,
  onChange,
  className,
  bleed = true,
}: ChoiceProps<T> & {
  /**
   * Phones: the scrolling row bleeds to the screen edge (fading out on the right). Default on, for chips placed
   * on the page; pass false inside a padded card.
   */
  bleed?: boolean;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn(
        "flex min-w-0 gap-1",
        // phones: one scrolling row
        "max-app:overflow-x-auto max-app:py-0.5 max-app:[scrollbar-width:none] max-app:[&::-webkit-scrollbar]:hidden",
        bleed && "max-app:-mx-4 max-app:px-4 max-app:[mask-image:linear-gradient(90deg,#000_88%,transparent)]",
        className,
      )}
    >
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={on}
            aria-label={o.ariaLabel}
            disabled={o.disabled}
            onClick={() => onChange(o.value)}
            className={cn(
              "relative inline-flex h-[38px] shrink-0 items-center gap-1.5 rounded-[10px] border px-3.5 text-[13px] transition-[background-color,color,border-color] duration-150 app:h-8 app:px-[13px]",
              "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:pointer-events-none disabled:opacity-45",
              // 44 px tap target on phones
              "max-app:after:absolute max-app:after:inset-x-0 max-app:after:-inset-y-[3px] max-app:after:content-['']",
              on
                ? "border-mint-200 bg-card font-bold text-mint-700 shadow-pill"
                : "border-transparent font-medium text-muted hover:bg-card/85 hover:text-text",
            )}
          >
            {o.label}
            {/* solid colours: counts are small text and need full AA contrast */}
            {o.count !== undefined ? <span className={cn("text-[11px] tabular-nums", on ? "text-mint-700" : "text-muted")}>{o.count}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
  className,
  size = "md",
}: ChoiceProps<T> & { size?: "sm" | "md" }) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn(
        "inline-flex shrink-0 items-center gap-0.5 rounded-full border border-border bg-card p-[3px] shadow-pill",
        className,
      )}
    >
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={on}
            aria-label={o.ariaLabel}
            disabled={o.disabled}
            onClick={() => onChange(o.value)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full font-bold transition-[background-color,color] duration-150",
              "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus disabled:pointer-events-none disabled:opacity-45",
              // md: 40 px touch targets on phones, the mockup's 30 px from the tablet frame up
              size === "sm" ? "h-[26px] px-3 text-[12px]" : "h-10 px-4 text-[12.5px] app:h-[30px] app:px-3.5",
              on ? "bg-ink text-on-ink" : "text-text-2 hover:bg-card hover:text-text",
            )}
          >
            {o.label}
            {o.count !== undefined ? <span className={cn("text-[11px] font-semibold tabular-nums", on ? "text-on-ink/70" : "text-muted")}>{o.count}</span> : null}
          </button>
        );
      })}
    </div>
  );
}
