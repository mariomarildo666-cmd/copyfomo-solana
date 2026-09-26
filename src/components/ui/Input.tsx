// Form controls (mockup v2): white fields with a hairline border and a mint focus ring. No hooks.
// Labels / hints / errors for a field: `Field` in @/components/app/Field (it wraps these).

import type { ComponentProps, ReactNode } from "react";
import { cn } from "./cn";
import { Icon } from "./icons";

/** Text input look: 44 px on phones, 40 px from the tablet frame up. Mono for addresses: add "font-mono". */
export const inputClass = cn(
  "h-11 w-full min-w-0 rounded-field border border-border bg-card px-3.5 text-[13.5px] font-medium text-text shadow-[0_1px_2px_rgb(20_38_48/0.04)] app:h-10",
  "placeholder:font-normal placeholder:text-muted",
  "transition-[border-color,box-shadow] duration-150",
  "hover:border-border-strong focus:border-mint-400 focus:shadow-[0_0_0_4px_rgb(47_191_174/0.16)] focus:outline-none",
  "focus-visible:outline-none aria-[invalid=true]:border-down aria-[invalid=true]:focus:shadow-[0_0_0_4px_rgb(207_47_61/0.14)]",
  "disabled:cursor-not-allowed disabled:bg-card-2 disabled:opacity-60",
);

export function Input({ className, ...rest }: ComponentProps<"input">) {
  return <input className={cn(inputClass, className)} {...rest} />;
}

export function Textarea({ className, ...rest }: ComponentProps<"textarea">) {
  return <textarea className={cn(inputClass, "h-auto min-h-24 py-2.5 leading-relaxed app:h-auto", className)} {...rest} />;
}

/** Native <select> with the field look and a chevron. */
export function Select({ className, children, ...rest }: ComponentProps<"select">) {
  return (
    <span className={cn("relative inline-flex w-full min-w-0", className)}>
      <select className={cn(inputClass, "cursor-pointer appearance-none pr-9")} {...rest}>
        {children}
      </select>
      <Icon name="chev" size={15} strokeWidth={2} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-icon" />
    </span>
  );
}

/** A field with a trailing unit or note inside it ("SOL", "bps = 3%"). */
export function InputWithSuffix({ suffix, className, inputClassName, ...rest }: ComponentProps<"input"> & { suffix: ReactNode; inputClassName?: string }) {
  return (
    <span className={cn("relative block", className)}>
      <input className={cn(inputClass, "pr-14", inputClassName)} {...rest} />
      <span className="pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 text-[12px] font-semibold text-muted">{suffix}</span>
    </span>
  );
}

/**
 * The mockup's search pill: a rounded field with a round ink "go" button. Put it in a <form> (the button submits)
 * or pass onGo. `label` is the input's accessible name (visually hidden). The button sits outside the <label>, so
 * the input's name never picks up the button's text.
 */
export function SearchField({
  label,
  className,
  buttonLabel = "Search",
  onGo,
  goType = "submit",
  ...rest
}: Omit<ComponentProps<"input">, "type"> & {
  label: string;
  buttonLabel?: string;
  onGo?: () => void;
  goType?: "submit" | "button";
}) {
  return (
    <div
      className={cn(
        "flex h-11 min-w-0 items-center gap-1 rounded-full border border-border bg-card pr-px shadow-pill app:h-9 app:pr-[3px]",
        "transition-[border-color,box-shadow] duration-150 focus-within:border-mint-400 focus-within:shadow-[0_0_0_4px_rgb(47_191_174/0.16),var(--shadow-pill)]",
        className,
      )}
    >
      <label className="flex h-full min-w-0 flex-1 cursor-text items-center pl-4">
        <span className="sr-only">{label}</span>
        <input
          type="search"
          autoComplete="off"
          className="h-full min-w-0 flex-1 border-0 bg-transparent text-[13px] font-medium text-text outline-none placeholder:font-normal placeholder:text-muted focus-visible:outline-none"
          {...rest}
        />
      </label>
      {/* 40 px on phones, the mockup's 28 px inside the 36 px pill from the tablet frame up */}
      <button
        type={goType}
        onClick={onGo}
        aria-label={buttonLabel}
        className="grid size-10 shrink-0 place-items-center rounded-full bg-ink text-on-ink transition-[background-color,transform] duration-150 hover:scale-105 hover:bg-ink-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus app:size-7"
      >
        <Icon name="search" size={14} strokeWidth={2.2} />
      </button>
    </div>
  );
}

/** Checkbox styled as a switch (role="switch"). Put the visible label text next to it inside the same <label>. */
export function SwitchBox({ className, checked, ...rest }: Omit<ComponentProps<"input">, "type" | "role">) {
  return (
    <span className={cn("relative inline-flex shrink-0", className)}>
      <input type="checkbox" role="switch" checked={checked} className="peer sr-only" {...rest} />
      <span
        aria-hidden
        className={cn(
          "relative inline-block h-6 w-11 rounded-full border transition-colors duration-150",
          "peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-focus peer-disabled:opacity-50",
          checked ? "border-mint-700 bg-mint-700" : "border-border-strong bg-card-3",
        )}
      >
        <span
          className={cn(
            "absolute top-0.5 size-[18px] rounded-full bg-card shadow-[0_1px_3px_rgb(20_38_48/0.3)] transition-transform duration-150 ease-out-soft",
            checked ? "translate-x-[21px]" : "translate-x-0.5",
          )}
        />
      </span>
    </span>
  );
}
