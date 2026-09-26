// Small presentational pieces shared by the agent dashboard sections. No hooks.

import type { ReactNode } from "react";
import { solscanTx } from "@/lib/format";
import { Icon } from "@/components/ui/icons";
import { Heading, cn } from "@/components/ui/primitives";

/** Title row of a dashboard card: an h2 on the left, optional meta (count, hint, chip) on the right. */
export function CardTitle({ id, children, meta, className }: { id: string; children: ReactNode; meta?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5", className)}>
      <Heading id={id} size="md">
        {children}
      </Heading>
      {meta}
    </div>
  );
}

/** One figure in a grey inset (label above, value below): a <div> pair for use inside a <dl>. */
export function MiniStat({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn("min-w-0 rounded-card-sm border border-border bg-card-2 px-3 py-2.5", className)}>
      <dt className="truncate text-[11.5px] font-semibold text-muted">{label}</dt>
      <dd className="mt-1 truncate font-mono text-[13px] font-semibold tabular-nums text-text">{children}</dd>
    </div>
  );
}

/** "tx ↗" link to a transaction on Solscan. */
export function TxLink({ sig, label = "tx", className }: { sig: string; label?: string; className?: string }) {
  return (
    <a
      href={solscanTx(sig)}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        "relative inline-flex items-center gap-0.5 text-[11.5px] font-semibold text-muted underline after:absolute after:-inset-x-2 after:-inset-y-3 decoration-border-strong underline-offset-2 hover:text-mint-700 hover:decoration-mint-300",
        className,
      )}
    >
      {label}
      <Icon name="external" size={11} strokeWidth={2.2} />
      <span className="sr-only"> (Solscan, opens in a new tab)</span>
    </a>
  );
}

/** A status line with a leading icon ("✓ Saved…", "✕ …"). role="status" by default; null for a plain hint. */
export function StatusLine({
  tone,
  children,
  role = "status",
}: {
  tone: "up" | "warn" | "down" | "info";
  children: ReactNode;
  role?: "status" | "alert" | null;
}) {
  const t = {
    up: { cls: "text-up", icon: "check" as const },
    warn: { cls: "text-warn", icon: "alert" as const },
    down: { cls: "text-down", icon: "x" as const },
    info: { cls: "text-info", icon: "info" as const },
  }[tone];
  return (
    <p role={role ?? undefined} className={cn("flex items-start gap-1.5 text-[12.5px] font-medium leading-snug", t.cls)}>
      <Icon name={t.icon} size={14} strokeWidth={2.4} className="mt-px shrink-0" />
      <span>{children}</span>
    </p>
  );
}
