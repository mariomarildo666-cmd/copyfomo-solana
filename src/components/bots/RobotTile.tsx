// A robot on a rounded, accent-tinted tile (the mockup's card icons and avatars). No hooks.
//
//   <RobotTile seed={t.wallet} variant="trader" />            40 px tile, 32 px robot (trader cards)
//   <RobotTile seed={agent.id} size="md" mood="buy" />         72 px tile, 64 px robot
//   <RobotTile seed={wallet} size="xs" shape="circle" />       36 px round avatar (2xs = 32 px)
//
// The tint follows the robot's own accent colour (the generator's first draw), so a robot always sits on "its"
// colour. Decorative unless `title` is given.

import type { CSSProperties } from "react";
import { cn } from "@/components/ui/cn";
import { PixelRobot } from "./PixelRobot";
import { ACCENT_HEX, ACCENT_TILE, accentFor, type HeroName, type RobotAccent, type RobotMood, type RobotSize, type RobotVariant } from "./params";

export type RobotTileSize = "2xs" | "xs" | "sm" | "md" | "lg" | "xl";

/** tile px / robot px / corner radius per size */
export const TILE_SIZES: Record<RobotTileSize, { tile: number; robot: RobotSize; radius: number }> = {
  "2xs": { tile: 32, robot: 32, radius: 9 },
  xs: { tile: 36, robot: 32, radius: 10 },
  sm: { tile: 40, robot: 32, radius: 10 },
  md: { tile: 72, robot: 64, radius: 16 },
  lg: { tile: 104, robot: 96, radius: 20 },
  xl: { tile: 136, robot: 128, radius: 24 },
};

export interface RobotTileProps {
  seed?: string | null;
  name?: HeroName;
  variant?: RobotVariant;
  mood?: RobotMood;
  size?: RobotTileSize;
  shape?: "square" | "circle";
  /** "accent" = the robot's accent gradient (default), "mint" = brand tint, "neutral" = grey inset. */
  tone?: "accent" | "mint" | "neutral";
  /** Draw a 2 px ring in the robot's accent colour (e.g. a picked trader). */
  ring?: boolean;
  title?: string;
  loading?: "lazy" | "eager";
  className?: string;
  style?: CSSProperties;
}

function tileBackground(tone: RobotTileProps["tone"], accent: RobotAccent): string {
  if (tone === "mint") return "linear-gradient(145deg, var(--mint-50), var(--mint-100))";
  if (tone === "neutral") return "linear-gradient(145deg, var(--card), var(--card-2))";
  const [a, b] = ACCENT_TILE[accent];
  return `linear-gradient(145deg, ${a}, ${b})`;
}

export function RobotTile({
  seed,
  name,
  variant,
  mood,
  size = "sm",
  shape = "square",
  tone = "accent",
  ring,
  title,
  loading,
  className,
  style,
}: RobotTileProps) {
  const s = TILE_SIZES[size];
  const accent = accentFor({ seed, name });
  const shadow = "inset 0 0 0 1px rgb(255 255 255 / 0.4), 0 4px 6px -1px rgb(20 38 48 / 0.14)";
  return (
    <span
      className={cn("relative inline-grid shrink-0 place-items-center overflow-hidden", className)}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      style={{
        width: s.tile,
        height: s.tile,
        borderRadius: shape === "circle" ? 999 : s.radius,
        background: tileBackground(tone, accent),
        boxShadow: ring ? `0 0 0 2px var(--card), 0 0 0 4px ${ACCENT_HEX[accent]}, ${shadow}` : shadow,
        ...style,
      }}
    >
      <PixelRobot seed={seed} name={name} variant={variant} mood={mood} size={s.robot} loading={loading} />
    </span>
  );
}
