// Three cast robots for banners (the mockup's hero trio), as pixel art: each plays its blink strip and bobs by
// one sprite pixel with steps(). Motion stops under prefers-reduced-motion. Decorative (aria-hidden). No hooks.

import type { CSSProperties } from "react";
import { cn } from "@/components/ui/cn";
import styles from "./bots.module.css";
import { heroFiles, type HeroName, type RobotSize } from "./params";

export const DEFAULT_HERO_TRIO = ["minty", "kit", "orbit"] as const satisfies readonly HeroName[];

export function HeroRobots({
  names = DEFAULT_HERO_TRIO,
  size = 128,
  compactSize = 96,
  animate = true,
  className,
  style,
}: {
  /** Which cast robots, left to right (1–4 look right). Default minty, kit, orbit. */
  names?: readonly HeroName[];
  /** Robot px on tablets / desktop (≥ 761 px). */
  size?: RobotSize;
  /** Robot px on phones (≤ 760 px). */
  compactSize?: RobotSize;
  animate?: boolean;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <div
      aria-hidden
      className={cn(styles.trio, animate && styles.animate, className)}
      style={{ "--bot-size": `${size}px`, "--bot-compact": `${compactSize}px`, ...style } as CSSProperties}
    >
      {names.map((n, i) => (
        <span
          key={`${n}-${i}`}
          className={styles.bot}
          style={{ "--i": i, backgroundImage: `url(${heroFiles(n).blink})` } as CSSProperties}
        />
      ))}
    </div>
  );
}
