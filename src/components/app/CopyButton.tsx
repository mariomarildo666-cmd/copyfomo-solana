"use client";

import { useEffect, useState } from "react";
import { cn } from "@/components/ui/cn";
import { Icon } from "@/components/ui/icons";
import { buttonClass } from "@/components/ui/primitives";

async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Older browsers / insecure origins: fall back to a hidden textarea.
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}

/**
 * Copy-to-clipboard button with its own "Copied" / "Select & copy" feedback (announced politely).
 * variant: "lime" (legacy name) = the ink primary pill; "outlineDark" (legacy name) = the white outlined button.
 */
export function CopyButton({
  text,
  label = "Copy",
  what,
  variant = "outlineDark",
  size = "sm",
  className,
  onCopied,
}: {
  text: string;
  label?: string;
  /** Accessible name suffix, e.g. "deposit address". */
  what?: string;
  variant?: "lime" | "outlineDark";
  size?: "sm" | "md";
  className?: string;
  onCopied?: () => void;
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
      className={cn(buttonClass(variant === "lime" ? "ink" : "outline", size), "shrink-0", className)}
      aria-label={what ? `${label} ${what}` : undefined}
      onClick={async () => {
        const ok = await writeClipboard(text);
        setState(ok ? "copied" : "failed");
        if (ok) onCopied?.();
      }}
    >
      <Icon
        name={state === "copied" ? "check" : state === "failed" ? "alert" : "copy"}
        strokeWidth={2}
        className={state === "copied" && variant !== "lime" ? "text-mint-700" : undefined}
      />
      {state === "copied" ? "Copied" : state === "failed" ? "Select & copy" : label}
      <span className="sr-only" aria-live="polite">
        {state === "copied" ? "Copied to clipboard" : state === "failed" ? "Copy failed, select the text manually" : ""}
      </span>
    </button>
  );
}
