import type { Metadata } from "next";
import { config } from "@/lib/config";
import { ButtonLink } from "@/components/ui/primitives";
import { Faq } from "@/components/landing/Faq";
import { FeedList } from "@/components/landing/FeedList";
import { FloorStrip } from "@/components/landing/FloorStrip";
import { Footer } from "@/components/landing/Footer";
import { Hero } from "@/components/landing/Hero";
import { HowItWorks } from "@/components/landing/HowItWorks";
import { Safety } from "@/components/landing/Safety";
import { SectionHead } from "@/components/landing/SectionHead";
import { TraderExplorer } from "@/components/landing/TraderExplorer";

export const metadata: Metadata = {
  title: { absolute: "copyfomo — copy the top of FOMO" },
  description:
    "Pick FOMO traders from copyfomo's on-chain leaderboard or paste any Solana wallet. copyfomo spins up an agent with its own wallet that mirrors their FOMO trades 1:1, the moment they land on-chain. Not affiliated with FOMO.",
};

/** Explore (mockup v2): hero banner, the trader grid, then the floor, the feed, how it works, safety + FAQ. */
export default function Home() {
  return (
    <div className="page">
      <Hero />
      <TraderExplorer defaultWindow="7d" />

      <div className="mt-10 flex flex-col gap-10 max-app:mt-8 max-app:gap-8">
        <FloorStrip />

        <section aria-labelledby="feed-title">
          <FeedList
            limit={3}
            lead={<SectionHead id="feed-title" kicker="Original vs copy" title="The feed" />}
            actions={
              <ButtonLink href="/feed" variant="ghost" size="sm" iconEnd="arrow">
                Full feed
              </ButtonLink>
            }
          />
        </section>

        <HowItWorks platformFeeBps={config.platformFeeBps} />

        <section
          id="safety"
          aria-labelledby="safety-title"
          className="grid scroll-mt-6 items-start gap-5 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]"
        >
          <Safety />
          <Faq copyVenue={config.copyVenue} platformFeeBps={config.platformFeeBps} mode={config.mode} />
        </section>

        <Footer />
      </div>
    </div>
  );
}
