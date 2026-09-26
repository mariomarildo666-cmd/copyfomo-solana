// The trader's crowned pixel robot on its accent tile. No hooks (server or client).

import { PixelRobot } from "@/components/bots/PixelRobot";
import { ACCENT_HEX, ACCENT_TILE, accentForSeed, safeSeed, snapRobotSize } from "@/components/bots/params";
import { cn } from "@/components/ui/cn";

export function traderSeed(t: { wallet?: string | null; handle?: string | null }): string {
  return t.wallet || t.handle || "unknown";
}

/**
 * The trader's crowned robot (seeded by wallet) on a rounded tile in the robot's accent colour. We never show
 * remote avatars (no hotlinking FOMO's images), so `avatarUrl` is accepted for compatibility and ignored.
 * Decorative: the name is always shown next to it. The robot is drawn at a crisp multiple of 32 px (a tile
 * smaller than 32 px only trims the sprite's empty 1 px margin).
 */
export function TraderAvatar({
  trader,
  size = 40,
  className,
  ring,
}: {
  trader: { wallet?: string | null; handle?: string | null; avatarUrl?: string | null };
  /** Tile px (40 = the mockup's card icon). */
  size?: number;
  className?: string;
  /** Draw a ring in the robot's accent colour (e.g. a picked trader). */
  ring?: boolean;
}) {
  const seed = safeSeed(traderSeed(trader));
  const accent = accentForSeed(seed);
  const [a, b] = ACCENT_TILE[accent];
  const robot = size >= 72 ? snapRobotSize(size - 8) : 32;
  return (
    <span
      aria-hidden
      className={cn("relative inline-grid shrink-0 place-items-center overflow-hidden", className)}
      style={{
        width: size,
        height: size,
        borderRadius: Math.max(8, Math.round(size / 4)),
        background: `linear-gradient(145deg, ${a}, ${b})`,
        boxShadow: ring
          ? `0 0 0 2px var(--card), 0 0 0 4px ${ACCENT_HEX[accent]}`
          : "inset 0 0 0 1px rgb(255 255 255 / 0.4), 0 4px 6px -1px rgb(20 38 48 / 0.14)",
      }}
    >
      <PixelRobot seed={seed} variant="trader" size={robot} className="max-w-none" />
    </span>
  );
}
