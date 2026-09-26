// Shared UI primitives (mockup v2). Keep this file small and generic: page-specific pieces belong in
// src/components/landing or src/components/app. No hooks here, so everything renders in server and client
// components alike. More primitives: ./Input (fields, search), ./ChipGroup (chips, segmented), ./SortMenu,
// ./Tooltip, ./HeroBanner, ./icons, and the robots in @/components/bots.

import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "./cn";
import { Icon, type IconName } from "./icons";

export { cn };

// ── buttons ─────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * ink    primary action: black pill (the default)
 * white  secondary action on tinted backgrounds (hero banner)
 * mint   brand-coloured action (mint-700, white text)
 * soft   selected / low-emphasis mint (mint-50 fill, mint-800 text)
 * outline white with a border (secondary on white cards, the mockup's "View")
 * ghost  text-only, tinted on hover
 * danger / danger-soft  destructive
 */
export type ButtonVariant = "ink" | "white" | "mint" | "soft" | "outline" | "ghost" | "danger" | "danger-soft";
export type ButtonSize = "xs" | "sm" | "md" | "lg";
export type ButtonShape = "pill" | "rect";

const LIFT = "hover:-translate-y-px active:translate-y-0";

const VARIANTS: Record<ButtonVariant, string> = {
  ink: `bg-ink text-on-ink shadow-ink hover:bg-ink-hover ${LIFT}`,
  white: `bg-card text-text shadow-white hover:shadow-float ${LIFT}`,
  mint: `bg-mint-700 text-on-ink shadow-[inset_0_1px_0_rgb(255_255_255/0.16),0_10px_20px_-12px_rgb(8_80_72/0.7)] hover:bg-mint-800 ${LIFT}`,
  soft: "border border-mint-200 bg-mint-50 text-mint-800 hover:bg-mint-100",
  outline: "border border-border-strong bg-card text-text shadow-mini hover:bg-card-2",
  ghost: "bg-transparent text-text-2 hover:bg-card-2 hover:text-text",
  danger: `bg-down text-on-ink shadow-[0_10px_20px_-12px_rgb(160_20_30/0.6)] hover:bg-down-ink ${LIFT}`,
  "danger-soft": "border border-down/35 bg-card text-down hover:bg-down-bg",
};

const SIZES: Record<ButtonSize, string> = {
  xs: "h-[30px] gap-1.5 px-2.5 text-[12px] [&_svg]:size-[13px]",
  sm: "h-8 gap-1.5 px-3.5 text-[12.5px] [&_svg]:size-[14px]",
  // 44 px touch target on phones, the mockup's 36 px from the tablet frame up
  md: "h-11 gap-2 px-4 text-[13px] app:h-9 [&_svg]:size-[14px]",
  lg: "h-12 gap-2 px-5 text-[14px] [&_svg]:size-4",
};

/** Class string of a button (for <a>, <Link>, <label> or <summary> that should look like one). */
export function buttonClass(
  variant: ButtonVariant = "ink",
  size: ButtonSize = "md",
  extra?: string,
  shape: ButtonShape = "pill",
): string {
  return cn(
    "inline-flex select-none items-center justify-center whitespace-nowrap font-sans font-bold no-underline",
    "transition-[transform,box-shadow,background-color,border-color,color] duration-150 ease-out-soft",
    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus",
    "disabled:pointer-events-none disabled:opacity-45 aria-disabled:pointer-events-none aria-disabled:opacity-45",
    "[&_svg]:shrink-0",
    shape === "pill" ? "rounded-full" : "rounded-btn",
    VARIANTS[variant],
    SIZES[size],
    extra,
  );
}

type ButtonOwnProps = {
  variant?: ButtonVariant;
  size?: ButtonSize;
  shape?: ButtonShape;
  /** Icon before the label. */
  icon?: IconName;
  /** Icon after the label (e.g. "arrow": it nudges right on hover). */
  iconEnd?: IconName;
};

function ButtonContent({ icon, iconEnd, children }: { icon?: IconName; iconEnd?: IconName; children?: ReactNode }) {
  return (
    <>
      {icon ? <Icon name={icon} strokeWidth={2} /> : null}
      {children}
      {iconEnd ? (
        <Icon name={iconEnd} strokeWidth={2} className="transition-transform duration-150 group-hover/btn:translate-x-0.5" />
      ) : null}
    </>
  );
}

export function Button({
  variant = "ink",
  size = "md",
  shape = "pill",
  icon,
  iconEnd,
  className,
  children,
  type = "button",
  ...rest
}: ComponentProps<"button"> & ButtonOwnProps) {
  return (
    <button type={type} className={buttonClass(variant, size, cn("group/btn", className), shape)} {...rest}>
      <ButtonContent icon={icon} iconEnd={iconEnd}>
        {children}
      </ButtonContent>
    </button>
  );
}

export function ButtonLink({
  variant = "ink",
  size = "md",
  shape = "pill",
  icon,
  iconEnd,
  className,
  children,
  ...rest
}: ComponentProps<typeof Link> & ButtonOwnProps) {
  return (
    <Link className={buttonClass(variant, size, cn("group/btn", className), shape)} {...rest}>
      <ButtonContent icon={icon} iconEnd={iconEnd}>
        {children}
      </ButtonContent>
    </Link>
  );
}

/** Round icon-only button (close, search go, menu). Always pass an aria-label. */
export function IconButton({
  icon,
  label,
  variant = "outline",
  size = 36,
  className,
  type = "button",
  ...rest
}: Omit<ComponentProps<"button">, "children"> & { icon: IconName; label: string; variant?: "ink" | "outline" | "ghost"; size?: 28 | 32 | 36 | 44 }) {
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      className={cn(
        "inline-grid shrink-0 place-items-center rounded-full transition-[background-color,transform] duration-150",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:pointer-events-none disabled:opacity-45",
        variant === "ink" && "bg-ink text-on-ink hover:scale-105 hover:bg-ink-hover",
        variant === "outline" && "border border-border bg-card text-text-2 shadow-pill hover:bg-card-2 hover:text-text",
        variant === "ghost" && "text-muted hover:bg-card-2 hover:text-text",
        className,
      )}
      style={{ width: size, height: size }}
      {...rest}
    >
      <Icon name={icon} size={Math.round(size * 0.42)} strokeWidth={2} />
    </button>
  );
}

// ── surfaces ────────────────────────────────────────────────────────────────────────────────────────────────────

/** White card: radius 16, hairline edge, soft shadow. The default container for page content. */
export function Card({ className, children, ...rest }: ComponentProps<"div">) {
  return (
    <div className={cn("rounded-card border border-hairline bg-card text-text shadow-card", className)} {...rest}>
      {children}
    </div>
  );
}

/** The Card look as a <section> (label it with aria-labelledby): a titled block of a page. */
export function Panel({ className, children, ...rest }: ComponentProps<"section">) {
  return (
    <section className={cn("relative overflow-hidden rounded-card border border-hairline bg-card text-text shadow-card", className)} {...rest}>
      {children}
    </section>
  );
}

/** Inset block inside a card (stats, previews, form groups): grey fill, no shadow. */
export function Inset({ className, children, ...rest }: ComponentProps<"div">) {
  return (
    <div className={cn("rounded-card-sm border border-border bg-card-2", className)} {...rest}>
      {children}
    </div>
  );
}

// ── labels ──────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Status / info chip. Colour is never the only signal: always pass text.
 * Tones: neutral, mint, up, down, warn, info, paper, live, ink.
 * Sizes: md (22 px, default) and sm (18 px, inside dense rows).
 */
export type PillTone =
  | "neutral"
  | "mint"
  | "up"
  | "down"
  | "warn"
  | "info"
  | "paper"
  | "live"
  | "ink";

const PILL: Record<PillTone, string> = {
  neutral: "border-border bg-card-2 text-text-2",
  mint: "border-mint-200 bg-mint-50 text-mint-800",
  up: "border-up/20 bg-up-bg text-up",
  // text on the red tint: --down-ink (5.7:1), --down alone is under AA on it
  down: "border-down/20 bg-down-bg text-down-ink",
  warn: "border-paper-border bg-paper-bg text-paper-ink",
  paper: "border-paper-border bg-paper-bg text-paper-ink",
  info: "border-info/20 bg-info-bg text-info",
  live: "border-live-border bg-live-bg text-live-ink",
  ink: "border-ink bg-ink text-on-ink",
};

export function Pill({
  tone = "neutral",
  size = "md",
  dot,
  icon,
  children,
  className,
  title,
}: {
  tone?: PillTone;
  size?: "sm" | "md";
  /** A pulsing status dot before the text. */
  dot?: boolean;
  icon?: IconName;
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex shrink-0 items-center whitespace-nowrap rounded-full border font-semibold leading-none",
        size === "sm" ? "h-[18px] gap-1 px-1.5 text-[10.5px]" : "h-[22px] gap-1.5 px-2 text-[11.5px]",
        PILL[tone],
        className,
      )}
    >
      {dot ? <span aria-hidden className="size-1.5 rounded-full bg-current animate-blink" /> : null}
      {icon ? <Icon name={icon} size={size === "sm" ? 10 : 12} strokeWidth={2.2} /> : null}
      {children}
    </span>
  );
}

/**
 * The mockup's small outlined tag ("FOMO"): neutral, square-ish. tone "muted" is the secondary look (a lighter
 * border and muted text: "other app", "Wallet"). Pass the tone, not colour classes: cn() does not merge them.
 */
export function Tag({
  children,
  className,
  title,
  tone = "default",
}: {
  children: ReactNode;
  className?: string;
  title?: string;
  tone?: "default" | "muted";
}) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex shrink-0 items-center rounded-tag border bg-card px-1.5 text-[11px] font-semibold leading-4",
        tone === "muted" ? "border-border text-muted" : "border-border-strong text-text-2",
        className,
      )}
    >
      {children}
    </span>
  );
}

/**
 * Short phrases joined by "·" (footnotes, the legal line, a header's facts). A wrapped line never starts with a
 * separator: centred lists stack on phones (one phrase per line, no separators) and let the dot trail its phrase
 * elsewhere; start-aligned lists stay inline and clip the separator that would open a line.
 */
export function DotList({ items, align = "center", className }: { items: ReactNode[]; align?: "center" | "start"; className?: string }) {
  const shown = items.filter((i) => i !== null && i !== undefined && i !== false && i !== "");
  if (align === "start") {
    return (
      // every item draws its "·" before it (empty alt text: screen readers skip it); the first item of each line
      // has it in the negative margin, clipped
      <div className={cn("overflow-hidden", className)}>
        <ul className="-ml-[1em] flex flex-wrap items-center gap-y-0.5">
          {shown.map((item, i) => (
            <li key={i} className="whitespace-nowrap before:inline-block before:w-[1em] before:text-center before:content-['·'_/_'']">
              {item}
            </li>
          ))}
        </ul>
      </div>
    );
  }
  return (
    <ul className={cn("flex flex-wrap items-center justify-center gap-x-1.5 gap-y-0.5 max-app:flex-col max-app:gap-y-1", className)}>
      {shown.map((item, i) => (
        <li key={i} className="app:whitespace-nowrap">
          {item}
          {i < shown.length - 1 ? (
            <span aria-hidden className="ml-1.5 max-app:hidden">
              ·
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/** Small uppercase section label ("ORIGINAL VS COPY"). */
export function Kicker({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn("text-[11.5px] font-bold uppercase tracking-[0.08em] text-muted", className)}>{children}</p>;
}

// ── headings + numbers ──────────────────────────────────────────────────────────────────────────────────────────

export type HeadingSize = "hero" | "xl" | "lg" | "md" | "sm";

const HEADING: Record<HeadingSize, string> = {
  // the mockup's banner headline: italic 800 uppercase
  hero: "text-[30px] font-extrabold uppercase italic leading-[1.02] tracking-[-0.02em] app:text-[33px]",
  xl: "text-[28px] font-extrabold leading-[1.08] tracking-[-0.03em] app:text-[34px]",
  lg: "text-[22px] font-extrabold leading-tight tracking-[-0.025em] app:text-[24px]",
  md: "text-[17px] font-bold leading-snug tracking-[-0.015em]",
  sm: "text-[14px] font-bold leading-snug tracking-[-0.01em]",
};

/** Section / page heading in the body font. `size` only sets type; pass className for colour or spacing. */
export function Heading({
  as: Tag = "h2",
  size = "lg",
  id,
  className,
  children,
}: {
  as?: "h1" | "h2" | "h3" | "h4" | "p";
  size?: HeadingSize;
  id?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Tag id={id} className={cn("text-text", HEADING[size], className)}>
      {children}
    </Tag>
  );
}

/** Inline stat: optional icon, value, label (the mockup's card stats row). Colour + icon, never colour alone. */
export function Stat({
  label,
  value,
  tone,
  icon,
  className,
}: {
  label: string;
  value: ReactNode;
  /** up / down / mint colour the value. */
  tone?: "up" | "down" | "mint";
  icon?: IconName;
  className?: string;
}) {
  const toneClass = tone === "up" ? "text-up" : tone === "down" ? "text-down" : tone === "mint" ? "text-mint-700" : "text-text";
  return (
    <span className={cn("inline-flex items-baseline gap-1.5 whitespace-nowrap", className)}>
      <span className={cn("inline-flex items-center gap-1 text-[15px] font-bold tabular-nums leading-none", toneClass)}>
        {icon ? <Icon name={icon} size={13} strokeWidth={2.2} className={tone ? undefined : "text-icon"} /> : null}
        {value}
      </span>
      <span className="text-[12px] font-medium text-muted">{label}</span>
    </span>
  );
}

/** A signed number ("+1.2", "−0.4"): renders the sign with a true minus (U+2212). Kept for existing callers. */
export function PixelSigned({ text }: { text: string }) {
  const m = /^([+−-])(.*)$/.exec(text);
  if (!m) return <>{text}</>;
  return (
    <>
      <span className="mr-px">{m[1] === "-" ? "−" : m[1]}</span>
      {m[2]}
    </>
  );
}

/** Empty / loading / error state block with an optional robot or icon on top. */
export function EmptyState({
  title,
  children,
  art,
  action,
  tone = "neutral",
  className,
}: {
  title: string;
  children?: ReactNode;
  /** e.g. <PixelRobot name="tofu" size={64} /> */
  art?: ReactNode;
  action?: ReactNode;
  tone?: "neutral" | "down";
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-2 rounded-card-sm border border-dashed bg-card px-5 py-8 text-center",
        tone === "down" ? "border-down/35" : "border-border-strong",
        className,
      )}
    >
      {art}
      <p className={cn("text-[14px] font-bold", tone === "down" ? "text-down" : "text-text")}>{title}</p>
      {children ? <div className="max-w-sm text-[12.5px] leading-relaxed text-muted">{children}</div> : null}
      {action ? <div className="mt-1.5">{action}</div> : null}
    </div>
  );
}
