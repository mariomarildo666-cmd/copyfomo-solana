// 404 and load-error states for /traders/[wallet]. No hooks (server-rendered).

import type { ReactNode } from "react";
import { RobotTile } from "@/components/bots/RobotTile";
import type { RobotMood } from "@/components/bots/params";
import { ButtonLink, Card, Heading } from "@/components/ui/primitives";
import { createHref } from "@/components/landing/model";

/** One centred state card: a trader robot on a mint pad, a code line, the heading, copy and two actions. */
function StateCard({
  seed,
  mood,
  code,
  title,
  children,
  actions,
}: {
  seed: string;
  mood: RobotMood;
  code?: string;
  title: string;
  children: ReactNode;
  actions: ReactNode;
}) {
  return (
    <div className="page">
      <Card className="relative flex flex-col items-center gap-3 overflow-hidden px-5 pb-12 pt-10 text-center app:py-16">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-48"
          style={{ background: "radial-gradient(420px 180px at 50% 0%, var(--mint-50), transparent 70%)" }}
        />
        <RobotTile seed={seed} variant="trader" mood={mood} size="lg" tone="mint" shape="circle" className="relative" />
        {code ? <p className="relative mt-1 text-[11.5px] font-bold uppercase tracking-[0.12em] text-muted">{code}</p> : null}
        <Heading as="h1" size="xl" className="relative">
          {title}
        </Heading>
        <p className="relative max-w-md text-[14px] leading-relaxed text-muted">{children}</p>
        <div className="relative mt-2 flex w-full flex-col justify-center gap-2 min-[420px]:w-auto min-[420px]:flex-row">
          {actions}
        </div>
      </Card>
    </div>
  );
}

export function TraderNotFound() {
  return (
    <StateCard
      seed="trader-404"
      mood="sleep"
      code="error 404"
      title="No trader here"
      actions={
        <>
          <ButtonLink href="/traders" variant="ink" size="lg" icon="podium">
            FOMO leaderboard
          </ButtonLink>
          <ButtonLink href="/create" variant="outline" size="lg" icon="plus">
            Build an agent
          </ButtonLink>
        </>
      }
    >
      We don&apos;t have a profile for this wallet: it isn&apos;t one we index, or it opted out. Paste it into the
      leaderboard to check it for FOMO trades, or copy it anyway.
    </StateCard>
  );
}

export function TraderRateLimited({ wallet }: { wallet: string }) {
  return (
    <StateCard
      seed="trader-429"
      mood="sleep"
      code="429 · slow down"
      title="Too many profiles at once"
      actions={
        <>
          <ButtonLink href={createHref(wallet)} variant="ink" size="lg" icon="copy">
            Copy this wallet
          </ButtonLink>
          <ButtonLink href="/traders" variant="outline" size="lg" icon="arrow-left">
            Back to the leaderboard
          </ButtonLink>
        </>
      }
    >
      You opened a lot of trader profiles in the last minute. Wait a moment and reload — you can still copy the wallet
      meanwhile.
    </StateCard>
  );
}

export function TraderLoadError({ wallet }: { wallet: string }) {
  return (
    <StateCard
      seed="trader-error"
      mood="shock"
      title="Couldn't load this trader"
      actions={
        <>
          <ButtonLink href={createHref(wallet)} variant="ink" size="lg" icon="copy">
            Copy this wallet
          </ButtonLink>
          <ButtonLink href="/traders" variant="outline" size="lg" icon="arrow-left">
            Back to the leaderboard
          </ButtonLink>
        </>
      }
    >
      Our database didn&apos;t answer. Reload in a moment — you can still copy the wallet meanwhile.
    </StateCard>
  );
}
