// Landing footer: logo + one-line pitch, link columns, and the independence / risk statement. No hooks.

import Link from "next/link";
import { PixelRobot } from "@/components/bots/PixelRobot";
import { Icon } from "@/components/ui/icons";
import { Kicker } from "@/components/ui/primitives";

const LINK =
  "inline-flex items-center gap-1 rounded-sm text-[13px] font-medium text-text-2 underline-offset-2 transition-colors duration-150 hover:text-text hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";

const COLUMNS: { title: string; links: { href: string; label: string; external?: boolean }[] }[] = [
  {
    title: "Product",
    links: [
      { href: "/create", label: "Build an agent" },
      { href: "/floor", label: "The floor" },
      { href: "/traders", label: "FOMO leaderboard" },
      { href: "/feed", label: "Feed" },
    ],
  },
  {
    title: "Learn",
    links: [
      { href: "/#how", label: "How it works" },
      { href: "/#safety", label: "Safety & FAQ" },
    ],
  },
  {
    title: "Built on",
    links: [
      { href: "https://solana.com", label: "Solana", external: true },
      { href: "https://www.helius.dev", label: "Helius", external: true },
      { href: "https://jup.ag", label: "Jupiter", external: true },
    ],
  },
];

export function Footer() {
  return (
    <footer className="border-t border-border pt-8">
      <div className="flex flex-col gap-8 md:flex-row md:justify-between">
        <div className="max-w-xs">
          {/* the shell's Logo collapses to an icon on the rail breakpoints; the footer always shows the wordmark */}
          <Link
            href="/"
            aria-label="copyfomo home"
            className="inline-flex items-center gap-2 rounded-[10px] text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
          >
            <PixelRobot name="icon-kit" size={32} />
            <span aria-hidden className="text-[17.5px] font-extrabold tracking-[-0.035em]">
              copyfomo
            </span>
          </Link>
          <p className="mt-3 text-[13px] leading-relaxed text-muted">
            The copy desk for FOMO traders. Agents with their own wallets, mirroring on Solana, routed through Jupiter.
          </p>
        </div>
        <nav aria-label="Footer" className="grid grid-cols-2 gap-8 sm:grid-cols-3">
          {COLUMNS.map((col) => (
            <div key={col.title}>
              <Kicker>{col.title}</Kicker>
              <ul className="mt-3 flex flex-col gap-2.5">
                {col.links.map((l) => (
                  <li key={l.href}>
                    {l.external ? (
                      <a href={l.href} target="_blank" rel="noopener noreferrer" className={LINK}>
                        {l.label}
                        <Icon name="external" size={12} strokeWidth={2} className="text-icon" />
                        <span className="sr-only"> (opens in a new tab)</span>
                      </a>
                    ) : (
                      <Link href={l.href} className={LINK}>
                        {l.label}
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
      </div>
      <div className="mt-8 flex flex-col gap-2 border-t border-border pt-5 text-[12px] leading-relaxed text-muted lg:flex-row lg:justify-between lg:gap-8">
        <p className="max-w-3xl">
          copyfomo is an independent tool, not affiliated with, endorsed by, or connected to FOMO (fomo.family).
          Rankings are computed by copyfomo from public Solana data and will differ from FOMO&apos;s in-app numbers.
        </p>
        <p className="shrink-0 font-semibold text-text-2">Not financial advice. Copy-trading memecoins can lose everything.</p>
      </div>
    </footer>
  );
}
