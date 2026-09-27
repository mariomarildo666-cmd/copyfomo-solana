// Landing hero (mockup v2): the mint banner with the pixel-robot trio, "COPY THE TOP / OF FOMO", and the two
// calls to action, with the project token's contract address and X link under them when they are configured.
// The "paste any wallet" box lives in the Explore toolbar right under it (TraderExplorer).
// No hooks: renders on the server (CaCopy is a client island).

import { CaCopy } from "@/components/project/CaCopy";
import { cn } from "@/components/ui/cn";
import { Icon } from "@/components/ui/icons";
import { ButtonLink } from "@/components/ui/primitives";
import { HeroBanner } from "@/components/ui/HeroBanner";
import type { ProjectDTO } from "@/lib/types";

/** Frosted chip on the teal (CaCopy's "hero" look), 40 px on phones. */
const FROST =
  "inline-flex shrink-0 items-center justify-center rounded-full border border-card/70 bg-card/55 text-hero-ink shadow-[0_8px_18px_-12px_rgb(8_80_72/0.55)]";

/** "CA 7xKq…pump [copy]" + the X link; "$SYMBOL · launching soon" before the CA is set. */
function TokenLine({ project }: { project: ProjectDTO }) {
  const token = project.token;
  if (!token) return null;
  const x = project.xUrl ? (
    <a
      href={project.xUrl}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`${project.xHandle ? `@${project.xHandle}` : "copyfomo"} on X (opens in a new tab)`}
      title={project.xHandle ? `@${project.xHandle} on X` : "X"}
      className={cn(FROST, "size-10 transition-colors duration-150 hover:bg-card/80 app:size-8")}
    >
      <Icon name="x-logo" size={15} />
    </a>
  ) : null;

  return (
    <>
      {token.ca ? (
        <CaCopy ca={token.ca} symbol={token.symbol} variant="hero" label="CA" chars={6} className="flex-1" />
      ) : (
        <span className={cn(FROST, "h-10 gap-1.5 px-3.5 text-[12.5px] font-bold app:h-8")}>
          <i aria-hidden className="size-1.5 rounded-full bg-hero-ink animate-blink" />${token.symbol}
          <span className="font-semibold text-hero-ink-2">· launching soon</span>
        </span>
      )}
      {x}
    </>
  );
}

export function Hero({ project }: { project: ProjectDTO }) {
  return (
    <HeroBanner
      id="hero-title"
      title={["Copy the top", "of FOMO"]}
      bubble="gm"
      robots={["minty", "kit", "orbit"]}
      actions={
        <>
          <ButtonLink href="/traders?window=7d" variant="white" iconEnd="arrow">
            Browse traders
          </ButtonLink>
          <ButtonLink href="/create" variant="ink" iconEnd="arrow">
            Build an agent
          </ButtonLink>
        </>
      }
      meta={project.token ? <TokenLine project={project} /> : undefined}
    >
      Pick FOMO&apos;s best traders. Your agent mirrors every buy and sell 1:1, from its own wallet.
    </HeroBanner>
  );
}
