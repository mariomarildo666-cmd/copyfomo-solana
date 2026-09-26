// The mockup's mint hero banner. No hooks.
//
//   <HeroBanner id="explore-hero" title={["Copy the top", "of FOMO"]} bubble="gm"
//     actions={<><ButtonLink href="#traders" variant="white" iconEnd="arrow">Browse traders</ButtonLink>
//               <ButtonLink href="/create" iconEnd="arrow">Build an agent</ButtonLink></>}>
//     Pick FOMO's best traders. Your agent mirrors every buy and sell 1:1, from its own wallet.
//   </HeroBanner>
//
// Title: italic, uppercase; a [line1, line2] pair renders line 1 lighter and line 2 at weight 800.
// Buttons on the teal: variant "white" (secondary) and "ink" (primary).

import type { CSSProperties, ReactNode } from "react";
import { HeroRobots } from "@/components/bots/HeroRobots";
import type { HeroName } from "@/components/bots/params";
import { cn } from "./cn";
import styles from "./HeroBanner.module.css";

export function HeroBanner({
  id,
  title,
  as: Tag = "h1",
  children,
  actions,
  bubble,
  robots = ["minty", "kit", "orbit"],
  stackActions = false,
  compact = false,
  className,
  style,
}: {
  /** id of the heading (the section is labelled by it). */
  id: string;
  title: ReactNode | [ReactNode, ReactNode];
  as?: "h1" | "h2";
  /** Short copy under the title. */
  children?: ReactNode;
  /** Buttons (white + ink pills). */
  actions?: ReactNode;
  /** Text of the speech bubble on the top-left corner ("gm"). Decorative. */
  bubble?: string;
  /** Cast robots standing on the banner, left to right (1–4; the copy column makes room for exactly these). */
  robots?: readonly HeroName[];
  /** Long copy: stack the buttons at every desktop width so the text column gets the room. */
  stackActions?: boolean;
  /** Task pages: smaller robots and title on phones. */
  compact?: boolean;
  className?: string;
  style?: CSSProperties;
}) {
  const lines = Array.isArray(title) ? (title as [ReactNode, ReactNode]) : null;
  return (
    <section
      className={cn(styles.hero, stackActions && styles.stack, compact && styles.compact, className)}
      style={{ "--hb-n": Math.max(1, robots.length), ...style } as CSSProperties}
      aria-labelledby={id}
    >
      <div className={styles.bg} aria-hidden>
        <svg viewBox="0 0 1000 170" preserveAspectRatio="xMaxYMid slice">
          <g fill="none" stroke="#fff" strokeLinecap="round">
            <path d="M660 176 C 780 70, 860 190, 1010 34" strokeOpacity=".22" strokeWidth="1.3" />
            <path d="M692 176 C 800 86, 874 182, 1010 52" strokeOpacity=".16" strokeWidth="1.2" />
            <path d="M724 176 C 820 102, 888 174, 1010 70" strokeOpacity=".12" strokeWidth="1.1" />
            <path d="M756 176 C 840 118, 902 166, 1010 88" strokeOpacity=".09" strokeWidth="1" />
            <path d="M788 176 C 860 134, 916 158, 1010 106" strokeOpacity=".06" strokeWidth="1" />
          </g>
        </svg>
      </div>
      {bubble ? (
        <div className={styles.bubble} aria-hidden>
          {bubble}
        </div>
      ) : null}
      <div className={styles.bots}>
        <HeroRobots names={robots} style={{ "--bot-size": "var(--hb-bot)", "--bot-compact": "var(--hb-bot)" } as CSSProperties} />
      </div>
      <div className={styles.copy}>
        <Tag id={id} className={styles.title}>
          {lines ? (
            <>
              <span className={styles.l1}>{lines[0]}</span>
              <span className={styles.l2}>{lines[1]}</span>
            </>
          ) : (
            <span className={styles.l2}>{title}</span>
          )}
        </Tag>
        {children ? <p className={styles.text}>{children}</p> : null}
      </div>
      {actions ? <div className={styles.cta}>{actions}</div> : null}
    </section>
  );
}
