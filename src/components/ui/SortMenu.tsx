"use client";

// The mockup's "Sort · 7d PnL ⌄" pill with a dropdown list. A button (aria-haspopup="listbox") opens a listbox of
// options (role="option", aria-selected); arrows move, Enter / Space pick, Escape / Tab / outside click close and
// focus returns to the button.

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { cn } from "./cn";
import { Icon } from "./icons";

export interface SortOption<T extends string> {
  value: T;
  label: string;
}

export function SortMenu<T extends string>({
  label = "Sort",
  options,
  value,
  onChange,
  align = "right",
  className,
}: {
  /** Visible prefix and accessible name ("Sort"). Hidden on phones, where the button shows only the choice. */
  label?: string;
  options: readonly SortOption<T>[];
  value: T;
  onChange: (v: T) => void;
  align?: "left" | "right";
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const listId = useId();
  const current = options.find((o) => o.value === value) ?? options[0];

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    listRef.current?.focus();
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  const openAt = () => {
    setActive(Math.max(0, options.findIndex((o) => o.value === value)));
    setOpen(true);
  };
  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) buttonRef.current?.focus();
  };
  const pick = (i: number) => {
    const o = options[i];
    if (o) onChange(o.value);
    close();
  };

  const onListKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(options.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === "Home") {
      e.preventDefault();
      setActive(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setActive(options.length - 1);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      pick(active);
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "Tab") {
      close(false);
    }
  };

  return (
    <div ref={rootRef} className={cn("relative shrink-0", className)}>
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={`${label}: ${current?.label ?? ""}`}
        onClick={() => (open ? close() : openAt())}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            openAt();
          }
        }}
        className={cn(
          "flex h-11 items-center gap-1.5 whitespace-nowrap rounded-full border border-border bg-card pl-3.5 pr-3 text-[13px] font-semibold text-text shadow-pill app:h-9",
          "transition-[border-color] duration-150 hover:border-border-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus",
        )}
      >
        <span className="font-medium text-muted max-app:hidden">{label}</span>
        <span>{current?.label}</span>
        <Icon name="chev" size={14} strokeWidth={2} className={cn("text-icon transition-transform duration-150", open && "rotate-180")} />
      </button>
      {open ? (
        <ul
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label={label}
          tabIndex={-1}
          aria-activedescendant={`${listId}-${active}`}
          onKeyDown={onListKey}
          className={cn(
            "absolute top-[calc(100%+6px)] z-30 m-0 min-w-[170px] list-none rounded-[14px] bg-card p-1.5 shadow-float outline-none animate-rise",
            align === "right" ? "right-0" : "left-0",
          )}
        >
          {options.map((o, i) => {
            const selected = o.value === value;
            return (
              <li
                key={o.value}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={selected}
                onClick={() => pick(i)}
                onPointerMove={() => setActive(i)}
                className={cn(
                  "flex h-9 cursor-pointer items-center justify-between gap-3 rounded-[9px] px-2.5 text-[13px]",
                  i === active ? "bg-card-2 text-text" : "text-text-2",
                  selected ? "font-bold text-mint-700" : "font-medium",
                )}
              >
                {o.label}
                {selected ? <span aria-hidden className="size-[7px] rounded-full bg-mint-500" /> : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
