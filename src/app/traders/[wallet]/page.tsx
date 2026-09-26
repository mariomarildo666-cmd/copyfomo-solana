import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { cache } from "react";
import { limitTraderDetail } from "@/app/api/_lib/limits";
import { config } from "@/lib/config";
import { getTraderDetail } from "@/lib/fomo";
import { HttpError } from "@/lib/http";
import { RANKING_RULES } from "@/lib/fomo-stats";
import { isValidSolanaAddress } from "@/lib/solana";
import type { TraderDetailDTO } from "@/lib/types";
import { traderName } from "@/components/app/TraderIdentity";
import { TraderLoadError, TraderRateLimited } from "@/components/app/traders/TraderNotFound";
import { TraderProfile } from "@/components/app/traders/TraderProfile";

/**
 * One database read per request, shared by metadata and the page. `detail: null` = unknown / excluded wallet
 * (404); `undefined` = the database could not be asked; "limited" = this client used up the per-IP profile budget
 * it shares with GET /api/traders/[wallet] (finding F30). `at` is the render clock for "x ago" labels.
 */
const loadTrader = cache(async (wallet: string): Promise<{ detail: TraderDetailDTO | null | undefined | "limited"; at: number }> => {
  if (!isValidSolanaAddress(wallet)) return { detail: null, at: Date.now() };
  try {
    limitTraderDetail(new Request("http://page.local", { headers: await headers() }));
  } catch (err) {
    if (err instanceof HttpError && err.status === 429) return { detail: "limited", at: Date.now() };
    throw err;
  }
  try {
    return { detail: await getTraderDetail(wallet), at: Date.now() };
  } catch (err) {
    console.error(`[traders/[wallet]] detail failed: ${err instanceof Error ? err.message : String(err)}`);
    return { detail: undefined, at: Date.now() };
  }
});

export async function generateMetadata(props: PageProps<"/traders/[wallet]">): Promise<Metadata> {
  const { wallet } = await props.params;
  const { detail } = await loadTrader(wallet);
  if (detail && detail !== "limited") {
    const name = traderName(detail.trader);
    return {
      title: name,
      description: `${name}'s FOMO trades on Solana, computed by copyfomo from public chain data: realized PnL, win rate, open positions and latest trades. Not affiliated with FOMO.`,
    };
  }
  return { title: detail === null ? "No trader here" : "FOMO trader" };
}

export default async function TraderPage(props: PageProps<"/traders/[wallet]">) {
  const { wallet } = await props.params;
  const { detail, at } = await loadTrader(wallet);
  if (detail === null) notFound();
  if (detail === undefined) return <TraderLoadError wallet={wallet} />;
  if (detail === "limited") return <TraderRateLimited wallet={wallet} />;
  return <TraderProfile detail={detail} now={at} rules={RANKING_RULES} copyVenue={config.copyVenue} />;
}
