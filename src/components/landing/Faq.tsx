// Short FAQ built on native <details> (keyboard + screen reader support for free).

import type { ReactNode } from "react";
import type { AppConfigDTO, Mode } from "@/lib/types";
import { PixelRobot } from "@/components/bots/PixelRobot";
import { Icon } from "@/components/ui/icons";
import { Card, Heading, Kicker } from "@/components/ui/primitives";
import { feeExplainer } from "@/components/app/fees";

type Item = { q: string; a: ReactNode };

function faq(copyVenue: AppConfigDTO["copyVenue"], platformFeeBps: number, mode: Mode): Item[] {
  return [
    {
      q: "What is FOMO?",
      a: (
        <>
          FOMO (
          <a
            href="https://fomo.family"
            target="_blank"
            rel="noopener noreferrer"
            className="font-semibold text-mint-700 underline decoration-mint-300 underline-offset-2 hover:decoration-mint-700 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus"
          >
            fomo.family
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
          ) is a social-trading app whose Solana trades settle on-chain in public. copyfomo recognizes those trades in
          public Solana transactions and ranks the traders itself, so you can pick who to copy.
        </>
      ),
    },
    {
      q: "Is copyfomo affiliated with FOMO?",
      a: "No. copyfomo is an independent tool, not affiliated with, endorsed by, or connected to FOMO (fomo.family). Rankings are computed by copyfomo from public Solana data and will differ from FOMO's in-app numbers.",
    },
    {
      q: "Where do the rankings come from?",
      a: "From public Solana transactions only — we don't use any FOMO service. We detect FOMO trades for a set of wallets we track and rank them by realized profit in USDC (first-in-first-out, after FOMO's fees) over 24 hours, 7 days and 30 days. Names and handles come from our curated list or Helius identity labels; a handle is a label, not a proof.",
    },
    {
      q: "Which trades get copied?",
      a:
        copyVenue === "fomo"
          ? "Your agent copies a trader's FOMO buys on Solana, and their sells of any token it holds for them, so it can always exit. Cross-chain FOMO trades (Base, BNB, Robinhood Chain…) and trades made in other apps are not copied."
          : "Your agent copies every buy and sell a trader makes on Solana, in FOMO or any other app. Cross-chain FOMO trades (Base, BNB, Robinhood Chain…) happen off Solana and are not copied.",
    },
    {
      q: "How fast are copies?",
      a:
        mode === "live"
          ? "The copy engine listens to each trader's wallet and reacts when their swap confirms on-chain, then routes the same trade through Jupiter. Every copy records its latency, and the median is on the floor. Congestion, RPC speed and slippage all matter, so there is no guaranteed number."
          : "The copy engine listens to each trader's wallet and reacts when their swap confirms on-chain, then prices the same trade with a live Jupiter quote. In paper mode nothing is sent, so the latencies on the floor leave out the time a real swap takes to land. Congestion, RPC speed and slippage all matter, so there is no guaranteed number.",
    },
    {
      q: "What does 1:1 mean?",
      a: "Same trades, sized by your rules. Every copied buy and sell mirrors the original: same token, same direction. Size follows your mode (mirror the SOL amount, a fixed SOL per buy, or the same % of balance) and is always capped by your max per trade. FOMO traders pay in USDC; your agent pays in SOL.",
    },
    {
      q: "What happens when a trader sells?",
      a: "With copy sells on, your agent sells the same fraction of what it bought following that trader. If it never bought the token, it skips. Turn copy sells off to hold and exit on your own terms.",
    },
    {
      q: "Who owns my agent? Is there a password?",
      a: "Your wallet. You sign in by connecting Phantom, Solflare, Backpack or any Solana wallet and signing a short message (no transaction, no cost). The agent belongs to that wallet: you fund it from there in one click, and withdrawals can only ever go back to it. There's no password or key to lose.",
    },
    {
      q: "Fees?",
      a: `${feeExplainer(platformFeeBps)} On top, each copy pays normal Solana network and priority fees plus whatever slippage the route takes, so tiny trades lose proportionally more. PnL on your dashboard is shown after the platform fee.`,
    },
  ];
}

export function Faq({
  copyVenue = "fomo",
  platformFeeBps,
  mode,
}: {
  copyVenue?: AppConfigDTO["copyVenue"];
  platformFeeBps: number;
  mode: Mode;
}) {
  return (
    // id="faq": the shell's "Help & FAQ" link lands here
    <Card id="faq" className="scroll-mt-6 p-5 sm:p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <Kicker className="mb-1">FAQ</Kicker>
          <Heading id="faq-title" size="lg">
            Fair questions.
          </Heading>
        </div>
        {/* pip, the rookie of the cast, asking the questions */}
        <PixelRobot name="pip" mood="thinking" size={64} className="-mt-2 shrink-0" />
      </div>
      <div className="mt-4 divide-y divide-border border-y border-border">
        {faq(copyVenue, platformFeeBps, mode).map((f) => (
          <details key={f.q} className="group">
            <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-4 rounded-field py-3 text-[14.5px] font-semibold tracking-[-0.01em] text-text transition-colors duration-150 hover:text-mint-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus [&::-webkit-details-marker]:hidden">
              {f.q}
              <span
                aria-hidden
                className="grid size-7 shrink-0 place-items-center rounded-full border border-border bg-card text-text-2 shadow-mini transition-colors duration-150 group-open:border-ink group-open:bg-ink group-open:text-on-ink"
              >
                <Icon name="plus" size={14} strokeWidth={2.2} className="group-open:hidden" />
                <Icon name="minus" size={14} strokeWidth={2.2} className="hidden group-open:block" />
              </span>
            </summary>
            <div className="pb-4 pr-10 text-[13.5px] leading-relaxed text-text-2 max-app:pr-0">{f.a}</div>
          </details>
        ))}
      </div>
    </Card>
  );
}
