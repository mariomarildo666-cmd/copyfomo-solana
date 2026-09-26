// Form bits (light cards): consistent inputs, labels, hints, inline errors and notices.

import type { ReactNode } from "react";
import { cn } from "@/components/ui/cn";
import { Icon, type IconName } from "@/components/ui/icons";
import { inputClass as baseInputClass } from "@/components/ui/Input";

/** Text input look (same as the ui Input). Addresses and amounts: add "font-mono". */
export const inputClass = baseInputClass;

export function FieldError({ id, children }: { id?: string; children: ReactNode }) {
  if (!children) return null;
  return (
    <p id={id} className="mt-1.5 flex items-start gap-1.5 text-[12px] font-medium leading-snug text-down" role="alert">
      <Icon name="x" size={13} strokeWidth={2.6} className="mt-px shrink-0" />
      <span>{children}</span>
    </p>
  );
}

export function Field({
  id,
  label,
  hint,
  error,
  children,
  className,
}: {
  id: string;
  label: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      <label htmlFor={id} className="mb-1.5 block text-[12.5px] font-semibold text-text-2">
        {label}
      </label>
      {children}
      {hint && !error ? (
        <p id={`${id}-hint`} className="mt-1.5 text-[12px] leading-snug text-muted">
          {hint}
        </p>
      ) : null}
      <FieldError id={`${id}-error`}>{error}</FieldError>
    </div>
  );
}

/** Notice block: tinted box with an icon; `title` in bold. Tones: dim (neutral), down, amber (warning), lime (mint). */
export function Notice({
  tone = "dim",
  title,
  children,
  className,
}: {
  tone?: "dim" | "down" | "amber" | "lime";
  title?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  const tones = {
    dim: { box: "border-border bg-card-2", title: "text-text", icon: "info" as IconName, iconClass: "text-icon" },
    // --down-ink: the red that stays AA on the red tint
    down: { box: "border-down/25 bg-down-bg", title: "text-down-ink", icon: "alert" as IconName, iconClass: "text-down-ink" },
    amber: { box: "border-paper-border bg-paper-bg", title: "text-paper-ink", icon: "alert" as IconName, iconClass: "text-paper-ink" },
    lime: { box: "border-mint-200 bg-mint-50", title: "text-mint-800", icon: "check" as IconName, iconClass: "text-mint-700" },
  } as const;
  const t = tones[tone];
  return (
    <div className={cn("flex gap-2.5 rounded-card-sm border px-3.5 py-3 text-[13px] leading-snug", t.box, className)}>
      <Icon name={t.icon} size={16} strokeWidth={2} className={cn("mt-px shrink-0", t.iconClass)} />
      <div className="min-w-0">
        {title ? <p className={cn("text-[13px] font-bold", t.title)}>{title}</p> : null}
        {children ? <div className={cn(title ? "mt-0.5" : null, "text-text-2")}>{children}</div> : null}
      </div>
    </div>
  );
}
