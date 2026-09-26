// "How it works": Pick → Deposit → Mirror → Withdraw, told by the robot pair of the cast: "the-original" (a
// crowned top trader) and "the-copy" (your agent). Step 3 is the product, so it gets the mint card. No hooks.

import type { ReactNode } from "react";
import { PixelRobot } from "@/components/bots/PixelRobot";
import { Icon, type IconName } from "@/components/ui/icons";
import { ButtonLink, cn } from "@/components/ui/primitives";
import { feePct } from "@/components/app/fees";
import { SectionHead } from "./SectionHead";

interface Step {
  n: string;
  title: string;
  body: ReactNode;
  art: ReactNode;
  highlight?: boolean;
}

function Chip({ icon, children }: { icon: IconName; children: ReactNode }) {
  return (
    <span className="mb-3 inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-border bg-card px-2.5 text-[11.5px] font-semibold text-text-2 shadow-mini">
      <Icon name={icon} size={13} strokeWidth={2} className="text-icon" />
      {children}
    </span>
  );
}

function Flow({ icon = "arrow" }: { icon?: IconName }) {
  return <Icon name={icon} size={18} strokeWidth={2.2} className="mb-6 shrink-0 text-mint-600" />;
}

function steps(platformFeeBps: number): Step[] {
  return [
    {
      n: "01",
      title: "Pick",
      body: "Choose FOMO traders from our on-chain leaderboard, or paste any Solana wallet. One trader or a whole squad.",
      art: (
        <>
          <PixelRobot name="the-original" size={64} />
          <PixelRobot seed="how-original-2" variant="trader" size={32} className="mb-1 -ml-2" />
          <Chip icon="search">@handle / wallet</Chip>
        </>
      ),
    },
    {
      n: "02",
      title: "Deposit",
      body: "Deposit from your wallet in one click: connect it, pick an amount, approve one transfer. Your agent gets its own fresh wallet, and that balance is its whole budget.",
      art: (
        <>
          <PixelRobot name="the-copy" size={64} />
          <Flow icon="arrow-left" />
          <Chip icon="sol">1-click deposit</Chip>
        </>
      ),
    },
    {
      n: "03",
      title: "Mirror",
      highlight: true,
      body: (
        <>
          Their FOMO buys and sells on Solana are copied 1:1 the moment they land on-chain, inside your caps:{" "}
          <span className="font-semibold text-text">max per trade</span>, <span className="font-semibold text-text">slippage</span>,{" "}
          <span className="font-semibold text-text">copy sells</span> on or off.
        </>
      ),
      art: (
        <>
          <PixelRobot name="the-original" mood="buy" size={64} />
          <Flow />
          <PixelRobot name="the-copy" mood="buy" size={64} />
        </>
      ),
    },
    {
      n: "04",
      title: "Withdraw",
      body: `Pull SOL out anytime, only ever back to the wallet you signed in with. One click closes every position first.${
        platformFeeBps > 0 ? ` Our cut: ${feePct(platformFeeBps)} of the profit on winning trades, nothing on losses.` : ""
      }`,
      art: (
        <>
          <PixelRobot name="the-copy" mood="money" size={64} />
          <Flow />
          <Chip icon="wallet">your wallet</Chip>
        </>
      ),
    },
  ];
}

export function HowItWorks({ platformFeeBps }: { platformFeeBps: number }) {
  return (
    <section id="how" aria-labelledby="how-title" className="flex scroll-mt-6 flex-col gap-4">
      <SectionHead
        id="how-title"
        kicker="How it works"
        title="Four steps. Zero babysitting."
        actions={
          <ButtonLink href="/create" variant="ink" iconEnd="arrow">
            Build an agent
          </ButtonLink>
        }
      />

      <ol className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {steps(platformFeeBps).map((s) => (
          <li
            key={s.n}
            className={cn(
              "relative flex flex-col gap-4 rounded-card border bg-card p-4 shadow-card",
              s.highlight ? "border-mint-300 shadow-[0_0_0_3px_var(--mint-100),var(--shadow-card)]" : "border-hairline",
            )}
          >
            <div
              aria-hidden
              className={cn(
                "flex h-[92px] items-end justify-center gap-2 overflow-hidden rounded-card-sm border px-3 pt-3",
                s.highlight
                  ? "border-mint-200 bg-[linear-gradient(160deg,var(--mint-50),var(--mint-100))]"
                  : "border-border bg-[linear-gradient(160deg,var(--card),var(--card-2))]",
              )}
            >
              {s.art}
            </div>
            <div className="px-1 pb-1">
              <div className="flex items-center justify-between gap-2">
                <h3 className="flex items-baseline gap-2 text-[17px] font-extrabold tracking-[-0.015em] text-text">
                  <span className={cn("text-[12px] font-bold tabular-nums", s.highlight ? "text-mint-700" : "text-muted")}>
                    <span className="sr-only">Step </span>
                    {s.n}
                  </span>
                  {s.title}
                </h3>
                {s.highlight ? (
                  <span className="rounded-full border border-mint-200 bg-mint-50 px-2 py-0.5 text-[11px] font-bold text-mint-800">
                    the copy desk
                  </span>
                ) : null}
              </div>
              <p className="mt-2 text-[13.5px] leading-relaxed text-text-2">{s.body}</p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
