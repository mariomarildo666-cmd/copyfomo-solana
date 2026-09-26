// Section header for the landing / floor / feed sections: small uppercase kicker, heading, optional pills next to
// the heading and actions on the right (they wrap under it on narrow screens). No hooks.

import type { ReactNode } from "react";
import { Heading, Kicker, cn } from "@/components/ui/primitives";

export function SectionHead({
  id,
  kicker,
  title,
  as = "h2",
  size = "lg",
  pills,
  actions,
  className,
}: {
  /** id of the heading (label the section with it). */
  id?: string;
  kicker?: ReactNode;
  title: ReactNode;
  as?: "h1" | "h2" | "h3";
  size?: "xl" | "lg" | "md";
  /** Status pills beside the heading (LIVE, DEMONSTRATION …). */
  pills?: ReactNode;
  /** Links / buttons on the right. */
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <header className={cn("flex flex-wrap items-end justify-between gap-x-4 gap-y-3", className)}>
      <div className="min-w-0">
        {kicker ? <Kicker className="mb-1">{kicker}</Kicker> : null}
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
          <Heading as={as} size={size} id={id}>
            {title}
          </Heading>
          {pills}
        </div>
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}
