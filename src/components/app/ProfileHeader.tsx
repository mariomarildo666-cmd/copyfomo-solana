// The header card of a detail page, one layout for a trader's profile and an agent's dashboard: the hero banner's
// teal band, the robot on its accent tile standing over the band's edge (96 px robot on phones, 128 px from the
// tablet frame up), then who it is (kicker, h1, sub line, chips, links) and an aside on the right (actions, or who
// the agent copies). Anything passed as children (stat tiles) sits below. The card is a size container: three
// columns from 64 rem of card width, two from 48 rem, stacked below. No hooks.

import type { ReactNode } from "react";
import { PixelRobot } from "@/components/bots/PixelRobot";
import { ACCENT_TILE, accentForSeed, safeSeed, type RobotMood } from "@/components/bots/params";
import { cn } from "@/components/ui/cn";
import { Card, Heading } from "@/components/ui/primitives";

/** Same teal as the hero banner (HeroBanner.module.css). */
const COVER_BG =
  "radial-gradient(560px 240px at 96% -10%, rgb(255 255 255 / 0.28), rgb(255 255 255 / 0) 70%), linear-gradient(100deg, var(--hero-1) 0%, var(--hero-2) 38%, #72dad1 68%, var(--hero-3) 100%)";

/** The robot on its accent tile. `label` names it for screen readers (e.g. "integ.fomo, asleep"). */
function HeaderAvatar({ seed, variant, mood, label }: { seed: string; variant: "trader" | "agent"; mood?: RobotMood; label: string }) {
  const [a, b] = ACCENT_TILE[accentForSeed(safeSeed(seed))];
  return (
    <span
      role="img"
      aria-label={label}
      className="relative grid size-[112px] shrink-0 place-items-center overflow-hidden rounded-[24px] app:size-[144px] app:rounded-[30px]"
      style={{
        background: `linear-gradient(145deg, ${a}, ${b})`,
        boxShadow: "0 0 0 4px var(--card), inset 0 0 0 1px rgb(255 255 255 / 0.4), 0 20px 34px -16px rgb(12 70 66 / 0.45)",
      }}
    >
      <span className="animate-bob app:hidden">
        <PixelRobot seed={seed} variant={variant} mood={mood} size={96} loading="eager" />
      </span>
      <span className="hidden animate-bob app:block">
        <PixelRobot seed={seed} variant={variant} mood={mood} size={128} loading="eager" />
      </span>
    </span>
  );
}

export function ProfileHeader({
  robot,
  kicker,
  kickerTone = "mint",
  title,
  subline,
  chips,
  links,
  aside,
  children,
  className,
}: {
  robot: { seed: string; variant: "trader" | "agent"; mood?: RobotMood; label: string };
  kicker: ReactNode;
  kickerTone?: "mint" | "muted";
  /** The h1's content. */
  title: ReactNode;
  subline?: ReactNode;
  /** Status / rank / mode chips. */
  chips?: ReactNode;
  /** Outbound links (Solscan, X…). */
  links?: ReactNode;
  /** Right column: the page's main actions, or what the agent copies. */
  aside?: ReactNode;
  /** Below the identity: stat tiles, notes. */
  children?: ReactNode;
  className?: string;
}) {
  return (
    <Card className={cn("@container relative overflow-hidden", className)}>
      {/* the band: the hero banner's teal and its faint curves (decorative) */}
      <div aria-hidden className="relative h-[84px] overflow-hidden app:h-[108px]" style={{ background: COVER_BG }}>
        <svg viewBox="0 0 1000 170" preserveAspectRatio="xMaxYMid slice" className="absolute inset-0 size-full">
          <g fill="none" stroke="#fff" strokeLinecap="round">
            <path d="M560 176 C 700 60, 820 200, 1010 24" strokeOpacity=".24" strokeWidth="1.4" />
            <path d="M600 176 C 730 80, 840 190, 1010 46" strokeOpacity=".17" strokeWidth="1.3" />
            <path d="M640 176 C 760 100, 860 180, 1010 68" strokeOpacity=".12" strokeWidth="1.2" />
            <path d="M680 176 C 790 120, 880 170, 1010 90" strokeOpacity=".08" strokeWidth="1.1" />
          </g>
        </svg>
        <span className="absolute -left-6 -top-10 size-40 rounded-full bg-[rgb(255_255_255/0.15)]" />
      </div>

      <div className="grid grid-cols-1 gap-x-6 gap-y-4 px-4 pb-5 app:px-6 app:pb-6 @3xl:grid-cols-[auto_minmax(0,1fr)] @5xl:grid-cols-[auto_minmax(0,1fr)_minmax(248px,300px)]">
        <div className="-mt-[60px] app:-mt-[80px]">
          <HeaderAvatar {...robot} />
        </div>

        <div className="min-w-0 @3xl:pt-4">
          <p
            className={cn(
              "text-[11.5px] font-bold uppercase tracking-[0.08em]",
              kickerTone === "mint" ? "text-mint-700" : "text-muted",
            )}
          >
            {kicker}
          </p>
          <Heading as="h1" size="xl" className="mt-1 break-words">
            {title}
          </Heading>
          {subline ? (
            <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] font-medium text-muted">{subline}</div>
          ) : null}
          {chips ? <div className="mt-3 flex flex-wrap items-center gap-1.5">{chips}</div> : null}
          {links ? <div className="mt-4 flex flex-wrap gap-2">{links}</div> : null}
        </div>

        {aside ? (
          <div className="flex min-w-0 flex-col gap-2.5 @3xl:col-span-2 @3xl:max-w-[560px] @5xl:col-span-1 @5xl:max-w-none @5xl:pt-4">
            {aside}
          </div>
        ) : null}
      </div>

      {children}
    </Card>
  );
}
