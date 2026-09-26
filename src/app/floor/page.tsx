import type { Metadata } from "next";
import { config } from "@/lib/config";
import { ButtonLink } from "@/components/ui/primitives";
import { HeroBanner } from "@/components/ui/HeroBanner";
import { FloorBoard } from "@/components/app/floor/FloorBoard";

export const metadata: Metadata = {
  title: "The floor",
  description: "Every copyfomo agent, live: equity, PnL, copies and copy latency, refreshed every few seconds.",
};

export default function FloorPage() {
  return (
    <div className="page">
      <HeroBanner
        id="floor-title"
        title={["The ", "floor"]}
        robots={["volt", "blip", "luna"]}
        stackActions
        actions={
          <>
            <ButtonLink href="/feed" variant="white" iconEnd="arrow">
              Open the feed
            </ButtonLink>
            <ButtonLink href="/create" variant="ink" iconEnd="arrow">
              Build an agent
            </ButtonLink>
          </>
        }
      >
        Every copy agent on copyfomo, each with its own wallet. Bars show the last 12 copies: up is a buy, down is a sell,
        height is size.
        {config.mode === "paper" ? " Paper mode: every fill here is simulated against a live quote; no swap is sent." : ""}
      </HeroBanner>
      <FloorBoard />
    </div>
  );
}
