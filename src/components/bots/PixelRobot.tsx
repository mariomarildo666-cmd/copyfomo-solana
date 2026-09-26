// The pixel robot mascot as a crisp <img>. No hooks: renders in server and client components alike.
//
//   <PixelRobot name="minty" size={128} />                    a named hero (static /bots/svg/minty.svg)
//   <PixelRobot seed={wallet} variant="trader" size={32} />   a trader: seed robot of the wallet, crowned
//   <PixelRobot seed={agent.id} mood={robotMood(agent)} />    an agent: seed robot of the agent id
//
// Decorative unless `title` is given (then it is an image with that name).

import type { CSSProperties } from "react";
import { cn } from "@/components/ui/cn";
import { robotSrc, type HeroName, type RobotMood, type RobotSize, type RobotVariant } from "./params";

export interface PixelRobotProps {
  /** Seed of a generated robot: a wallet (trader / avatar) or an agent id / slug. Ignored when `name` is set. */
  seed?: string | null;
  /** A named robot of the shipped cast (public/bots). */
  name?: HeroName;
  /** "trader" = crowned seed robot, "agent" = plain seed robot, "hero" = named robot. Default: hero with `name`, else agent. */
  variant?: RobotVariant;
  /** Eye state. Default: the robot's resting mood (idle; tofu sleeps). */
  mood?: RobotMood;
  /** Rendered px. Whole multiples of the 32 px sprite only, so pixels stay square. Default 64. */
  size?: RobotSize;
  /** Accessible name. Without it the robot is decorative (alt=""). */
  title?: string;
  /** "eager" for robots above the fold (hero banners, the shell). Default "lazy". */
  loading?: "lazy" | "eager";
  className?: string;
  style?: CSSProperties;
}

export function PixelRobot({ seed, name, variant, mood, size = 64, title, loading = "lazy", className, style }: PixelRobotProps) {
  const v: RobotVariant = name ? "hero" : variant === "trader" ? "trader" : "agent";
  const src = robotSrc(v === "hero" ? { name, mood } : { seed: seed ?? "", variant: v, mood });
  return (
    // eslint-disable-next-line @next/next/no-img-element -- 32×32 pixel art: next/image resampling would blur it
    <img
      src={src}
      width={size}
      height={size}
      alt={title ?? ""}
      title={title}
      aria-hidden={title ? undefined : true}
      loading={loading}
      decoding="async"
      draggable={false}
      className={cn("pixelated block shrink-0 select-none", className)}
      style={{ width: size, height: size, imageRendering: "pixelated", ...style }}
    />
  );
}
