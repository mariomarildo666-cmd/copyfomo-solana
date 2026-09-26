// Landing hero (mockup v2): the mint banner with the pixel-robot trio, "COPY THE TOP / OF FOMO", and the two
// calls to action. The "paste any wallet" box lives in the Explore toolbar right under it (TraderExplorer).
// No hooks: renders on the server.

import { ButtonLink } from "@/components/ui/primitives";
import { HeroBanner } from "@/components/ui/HeroBanner";

export function Hero() {
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
    >
      Pick FOMO&apos;s best traders. Your agent mirrors every buy and sell 1:1, from its own wallet.
    </HeroBanner>
  );
}
