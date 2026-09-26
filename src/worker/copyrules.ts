// Pure copy-routing rules (no I/O — see copyrules.test.ts):
//  - venue of a detected swap: "fomo" when rule R (src/lib/fomo-chain.ts) says it is this wallet's FOMO trade
//    of the same token in the same direction, else "other";
//  - COPY_VENUE=fomo: buys from any other venue are skipped ("not a FOMO trade"); sells are copied from any
//    venue while the agent holds that sleeve, so agents can always exit;
//  - who receives an event: buys → active followers; sells → active followers + active holders of the sleeve
//    (a trader the agent stopped following can still close what the agent bought from them).

import type { FomoClass } from "@/lib/fomo-chain";
import type { Venue } from "@/lib/types";

export const NOT_FOMO_TRADE = "not a FOMO trade";

export type CopyVenue = "fomo" | "all";

/** Rule R classes the FOMO indexer ingests (trades, SOL⇄USDC conversions, cross-chain orders). */
export type FomoIngestible = Exclude<FomoClass, { kind: "not_fomo" }>;

export function isFomoIngestible(cls: FomoClass): cls is FomoIngestible {
  return cls.kind === "trade" || cls.kind === "convert" || cls.kind === "xchain";
}

/**
 * Venue of the swap the parser found in `tx` for `wallet`. "fomo" only when rule R classifies the tx as this
 * wallet's trade AND agrees with the parser on token and direction; anything else (other apps, copycat bots,
 * parser/rule disagreement) is "other" — never guessed upward.
 */
export function venueOf(cls: FomoClass, swap: { side: string; mint: string }): Venue {
  return cls.kind === "trade" && cls.side === swap.side && cls.mint === swap.mint ? "fomo" : "other";
}

/** Skip reason for an event under the copy-venue setting, or null when it may be copied. */
export function copyVenueSkipReason(side: string, venue: string, copyVenue: CopyVenue): string | null {
  if (copyVenue === "fomo" && side === "buy" && venue !== "fomo") return NOT_FOMO_TRADE;
  return null;
}

export interface AgentRef {
  agentId: string;
  mode: string;
}

/**
 * Agents an event is dispatched to, deduplicated, followers first. Buys go to followers only; sells also go to
 * agents holding a sleeve of that token from this trader (callers pass holders of (trader, mint) only).
 */
export function dispatchTargets(side: string, followers: readonly AgentRef[], holders: readonly AgentRef[]): AgentRef[] {
  const out = new Map<string, AgentRef>();
  for (const a of followers) if (!out.has(a.agentId)) out.set(a.agentId, a);
  if (side === "sell") for (const a of holders) if (!out.has(a.agentId)) out.set(a.agentId, a);
  return [...out.values()];
}
