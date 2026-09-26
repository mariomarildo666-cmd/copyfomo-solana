import type { Metadata } from "next";
import { config } from "@/lib/config";
import { ButtonLink } from "@/components/ui/primitives";
import { HeroBanner } from "@/components/ui/HeroBanner";
import { FeedRows } from "@/components/app/feed/FeedRows";

export const metadata: Metadata = {
  title: "Feed",
  description: "Every original trade next to what a copyfomo agent did about it: copied, skipped or failed, with latency.",
};

export default function FeedPage() {
  return (
    <div className="page">
      <HeroBanner
        id="feed-title"
        title={["The ", "feed"]}
        robots={["the-original", "blip", "the-copy"]}
        stackActions
        actions={
          <>
            <ButtonLink href="/floor" variant="white" iconEnd="arrow">
              See the floor
            </ButtonLink>
            <ButtonLink href="/create" variant="ink" iconEnd="arrow">
              Build an agent
            </ButtonLink>
          </>
        }
      >
        Original trade on the left, the copy on the right. Skips and failures stay in the feed with their reason, because a
        copy desk you can&apos;t audit isn&apos;t worth much.
        {config.mode === "paper" ? " Copies marked paper are simulated fills: priced on a live quote, never sent." : ""}
      </HeroBanner>
      <FeedRows limit={50} />
    </div>
  );
}
