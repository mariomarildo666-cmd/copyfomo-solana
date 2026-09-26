import type { Metadata } from "next";
import type { LeaderboardWindow } from "@/lib/types";
import { LeaderboardPicker } from "@/components/app/traders/LeaderboardPicker";

export const metadata: Metadata = {
  title: "FOMO leaderboard",
  description:
    "FOMO traders ranked by copyfomo from public Solana data: realized profit in USDC over 24h, 7d and 30d. Pick who to copy and build an agent that mirrors their FOMO trades. Not affiliated with FOMO.",
};

const WINDOWS: readonly LeaderboardWindow[] = ["24h", "7d", "30d"];

/** ?window=24h|7d|30d; the old "all" maps to the longest window we rank (30d). */
function toWindow(v: string | string[] | undefined): LeaderboardWindow {
  if (v === "all") return "30d";
  return typeof v === "string" && (WINDOWS as readonly string[]).includes(v) ? (v as LeaderboardWindow) : "24h";
}

export default async function TradersPage(props: PageProps<"/traders">) {
  const { window: w } = await props.searchParams;
  return <LeaderboardPicker initialWindow={toWindow(w)} />;
}
