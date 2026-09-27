"use client";

// App chrome (mockup v2): one frosted app frame with a left sidebar on desktop (an icon rail ≤ 1060 px), and a
// sticky top bar + floating bottom tab bar on phones (≤ 760 px). Every page renders inside <main id="main">;
// pages own their padding (the `.page` class in globals.css gives the mockup's).

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { PixelRobot } from "@/components/bots/PixelRobot";
import { TokenCard } from "@/components/project/TokenCard";
import { useClientConfig } from "@/components/providers/AppConfig";
import { cn } from "@/components/ui/cn";
import { Icon, type IconName } from "@/components/ui/icons";
import { DotList } from "@/components/ui/primitives";
import { WalletAccount } from "@/components/wallet/WalletButton";
import { ModeChip } from "./ModeChip";
import { SideToken } from "./SideToken";
import s from "./Shell.module.css";

interface NavItem {
  href: string;
  label: string;
  icon: IconName;
  live?: boolean;
  match: (pathname: string) => boolean;
}

const isAgents = (p: string) => p.startsWith("/agents") || p.startsWith("/create");

export const NAV: NavItem[] = [
  { href: "/", label: "Explore", icon: "explore", match: (p) => p === "/" },
  { href: "/traders", label: "Leaderboard", icon: "podium", match: (p) => p.startsWith("/traders") },
  { href: "/agents", label: "My agents", icon: "bot", match: isAgents },
  { href: "/floor", label: "The floor", icon: "activity", live: true, match: (p) => p.startsWith("/floor") },
  { href: "/feed", label: "Feed", icon: "feed", match: (p) => p.startsWith("/feed") },
  { href: "/#how", label: "How it works", icon: "book", match: () => false },
];

export const TABS: NavItem[] = [
  { href: "/", label: "Explore", icon: "explore", match: (p) => p === "/" || p.startsWith("/traders") },
  { href: "/agents", label: "Agents", icon: "bot", match: isAgents },
  { href: "/floor", label: "Floor", icon: "activity", live: true, match: (p) => p.startsWith("/floor") },
  { href: "/feed", label: "Feed", icon: "feed", match: (p) => p.startsWith("/feed") },
  { href: "/#how", label: "Guide", icon: "book", match: () => false },
];


function NavIcon({ item, active, size = 18 }: { item: NavItem; active: boolean; size?: number }) {
  // Explore's mark is the filled mint grid while it is the current page, a plain line grid otherwise.
  const name: IconName = item.icon === "explore" ? (active ? "explore" : "grid") : item.icon;
  return <Icon name={name} size={size} />;
}

function LiveDot() {
  return <span className={s.liveDot} role="img" aria-label="live" />;
}

/** Pixel robot mark + wordmark. */
export function Logo({ className }: { className?: string }) {
  return (
    <Link href="/" className={cn(s.brand, className)} aria-label="copyfomo home">
      <PixelRobot name="icon-kit" size={32} loading="eager" />
      <span className={s.word} aria-hidden>
        copyfomo
      </span>
    </Link>
  );
}

function SideLink({ item, pathname }: { item: NavItem; pathname: string }) {
  const active = item.match(pathname);
  return (
    <Link href={item.href} className={s.item} aria-current={active ? "page" : undefined} title={item.label}>
      <NavIcon item={item} active={active} />
      <span className={s.lbl}>{item.label}</span>
      {item.live ? <LiveDot /> : null}
    </Link>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { project } = useClientConfig();

  return (
    <div className={s.outer}>
      <a href="#main" className={s.skip}>
        Skip to content
      </a>
      <div className={s.frame}>
        <div className={s.app}>
          {/* Desktop sidebar / icon rail */}
          <aside className={s.side} aria-label="Sidebar">
            <Logo />
            <nav className={s.nav} aria-label="Main">
              {NAV.map((item) => (
                <SideLink key={item.href} item={item} pathname={pathname} />
              ))}
            </nav>
            <div className={s.foot}>
              <SideToken />
              <WalletAccount />
            </div>
          </aside>

          {/* Phone top bar */}
          <header className={s.mtop}>
            <Logo />
            <div className={s.mtopRight}>
              <ModeChip placement="topbar" />
              <WalletAccount compact />
            </div>
          </header>

          <main id="main" tabIndex={-1} className={cn(s.main, "focus-visible:outline-none")}>
            {children}
            {/* phones have no sidebar: the token card closes every page (the home page has it in its hero and footer) */}
            {project.token && pathname !== "/" ? (
              <div className="mx-auto w-full max-w-md px-4 pt-8 app:hidden">
                <TokenCard project={project} layout="strip" />
              </div>
            ) : null}
            <div className={s.legal}>
              <DotList items={["copyfomo · Solana", "not affiliated with FOMO", "copy-trading memecoins is risky"]} />
            </div>
          </main>

          {/* Phone tab bar */}
          <nav className={s.tabbar} aria-label="Main">
            {TABS.map((item) => {
              const active = item.match(pathname);
              return (
                <Link key={item.href} href={item.href} className={s.tab} aria-current={active ? "page" : undefined}>
                  <span className={s.tabIc}>
                    <NavIcon item={item} active={active} size={20} />
                    {item.live ? <LiveDot /> : null}
                  </span>
                  {item.label}
                </Link>
              );
            })}
          </nav>
        </div>
      </div>
    </div>
  );
}
