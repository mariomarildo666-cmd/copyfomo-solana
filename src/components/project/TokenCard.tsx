"use client";

// The project token card (clonesagent-style): "$SYMBOL" + "on pump.fun", the contract address as a copy field and
// Buy / Chart / X links. Before TOKEN_CA is set it reads "$SYMBOL · launching soon" with only the X link. Renders
// nothing when no project link is configured (ProjectDTO.token is null).
//   side   the 180 px desktop sidebar (dense: desktop pointers only)
//   menu   the icon rail's popover (248 px)
//   strip  phones: full-width card at the end of a page, 44 px touch targets

import type { ProjectDTO } from "@/lib/types";
import { cn } from "@/components/ui/cn";
import { Icon } from "@/components/ui/icons";
import { buttonClass } from "@/components/ui/primitives";
import { CaCopy } from "./CaCopy";

export type TokenCardLayout = "side" | "menu" | "strip";

const L = {
  side: {
    card: "gap-2 rounded-[14px] p-2.5 shadow-pill",
    coin: "size-7 text-[13px]",
    symbol: "text-[13px]",
    sub: "text-[11px]",
    field: "sm",
    chars: 4,
    button: "2xs",
    icon: "size-7",
    iconSize: 12,
  },
  menu: {
    card: "gap-2.5 rounded-[16px] p-3.5 shadow-float",
    coin: "size-8 text-[14px]",
    symbol: "text-[14px]",
    sub: "text-[11.5px]",
    field: "md",
    chars: 6,
    button: "xs",
    icon: "size-[30px]",
    iconSize: 13,
  },
  strip: {
    card: "gap-3 rounded-card p-4 shadow-card",
    coin: "size-10 text-[16px]",
    symbol: "text-[15px]",
    sub: "text-[12px]",
    field: "lg",
    chars: 8,
    button: "md",
    icon: "size-11",
    iconSize: 16,
  },
} as const;

const NEW_TAB = <span className="sr-only"> (opens in a new tab)</span>;

/** The "$" coin: the hero bubble's teal, italic 800 like its "gm". Decorative. */
function Coin({ className }: { className: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "grid shrink-0 place-items-center rounded-full bg-[linear-gradient(150deg,var(--bubble-1),var(--bubble-2))] font-extrabold italic text-on-ink",
        "shadow-[inset_0_1px_0_rgb(255_255_255/0.3),0_4px_10px_-4px_rgb(8_80_74/0.55)]",
        className,
      )}
    >
      $
    </span>
  );
}

/** Round icon-only outline link (the X button), the outline button's look. */
export function xIconLinkClass(size: string): string {
  return cn(
    "inline-grid shrink-0 place-items-center rounded-full border border-border-strong bg-card text-text shadow-mini transition-colors duration-150 hover:bg-card-2",
    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus",
    size,
  );
}

export function TokenCard({ project, layout, className }: { project: ProjectDTO; layout: TokenCardLayout; className?: string }) {
  const token = project.token;
  if (!token) return null;
  const l = L[layout];
  const name = `$${token.symbol}`;
  const ca = token.ca;
  const xLabel = project.xHandle ? `@${project.xHandle} on X` : "X";

  return (
    <div role="group" aria-label={`${name} token`} className={cn("flex min-w-0 flex-col border border-hairline bg-card text-text", l.card, className)}>
      <div className="flex min-w-0 items-center gap-2.5">
        <Coin className={l.coin} />
        <div className="min-w-0 leading-tight">
          <p className={cn("truncate font-extrabold tracking-[-0.02em]", l.symbol)}>{name}</p>
          <p className={cn("flex items-center gap-1.5 truncate font-medium text-muted", l.sub)}>
            {ca ? (
              token.name ? `${token.name} · ${token.venue}` : `on ${token.venue}`
            ) : (
              <>
                <i aria-hidden className="size-1.5 shrink-0 rounded-full bg-mint-500 animate-blink" />
                {/* the sidebar is narrow: just the name there (the blinking dot says "not live yet"); the full phrase elsewhere */}
                {token.name ? (layout === "side" ? token.name : `${token.name} · launching soon`) : "launching soon"}
              </>
            )}
          </p>
        </div>
      </div>

      {ca ? <CaCopy ca={ca} symbol={token.symbol} variant="field" size={l.field} chars={l.chars} /> : null}

      {ca || project.xUrl ? (
        <div className={cn("grid items-center", layout === "side" ? "gap-1" : "gap-2", ca ? "grid-cols-[1fr_1fr_auto]" : "grid-cols-1")}>
          {ca && token.buyUrl ? (
            <a href={token.buyUrl} target="_blank" rel="noopener noreferrer" className={buttonClass("ink", l.button, "min-w-0")}>
              Buy
              <span className="sr-only">
                {" "}
                {name} on {token.venue}
              </span>
              {NEW_TAB}
            </a>
          ) : null}
          {ca && token.chartUrl ? (
            <a href={token.chartUrl} target="_blank" rel="noopener noreferrer" className={buttonClass("outline", l.button, "min-w-0")}>
              Chart
              <span className="sr-only"> of {name}</span>
              {NEW_TAB}
            </a>
          ) : null}
          {project.xUrl ? (
            ca ? (
              <a
                href={project.xUrl}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={`${xLabel} (opens in a new tab)`}
                title={xLabel}
                className={xIconLinkClass(l.icon)}
              >
                <Icon name="x-logo" size={l.iconSize} />
              </a>
            ) : (
              <a href={project.xUrl} target="_blank" rel="noopener noreferrer" className={buttonClass("outline", l.button, "min-w-0")}>
                <Icon name="x-logo" />
                <span className="truncate">{project.xHandle && layout !== "side" ? `@${project.xHandle}` : "Follow on X"}</span>
                <span className="sr-only"> on X</span>
                {NEW_TAB}
              </a>
            )
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
