"use client";

// The project token in the desktop sidebar: the full card above the mode chip (≥ 1061 px), and in the 76 px icon
// rail a coin button that opens the same card in a popover (like the mode chip and the wallet menu: outside click
// or Escape closes it). Nothing at all when no project link is configured.

import { useEffect, useId, useRef, useState } from "react";
import { useClientConfig } from "@/components/providers/AppConfig";
import { TokenCard } from "@/components/project/TokenCard";
import { cn } from "@/components/ui/cn";
import { Icon } from "@/components/ui/icons";
import s from "./Shell.module.css";

export function SideToken() {
  const { project } = useClientConfig();
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
    // leaving the rail breakpoint hides the button: close so the popover never reopens by surprise
    const wide = window.matchMedia("(min-width: 1061px)");
    const onWide = () => wide.matches && setOpen(false);
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    wide.addEventListener("change", onWide);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
      wide.removeEventListener("change", onWide);
    };
  }, [open]);

  if (!project.token) return null;
  const name = `$${project.token.symbol}`;

  return (
    <>
      <div className="max-side:hidden">
        <TokenCard project={project} layout="side" />
      </div>
      <div ref={rootRef} className="relative hidden max-side:block">
        <button
          ref={buttonRef}
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          aria-label={`${name} token: contract address and links`}
          title={name}
          onClick={() => setOpen((v) => !v)}
          className={cn(s.item, s.coinBtn)}
        >
          <Icon name="coin" />
        </button>
        <div id={panelId} hidden={!open} className="absolute bottom-[calc(100%+8px)] left-0 z-50 w-[248px] animate-rise">
          <TokenCard project={project} layout="menu" />
        </div>
      </div>
    </>
  );
}
