// Who a trader is, as far as we honestly know: display name, FOMO handle (seed file or Helius label only),
// X handle (seed file) and the wallet. Pure helpers (the name block itself is the TraderCard's / ProfileHeader's).

import type { TraderDTO } from "@/lib/types";
import { shortAddr } from "@/lib/format";

type Named = Pick<TraderDTO, "wallet" | "handle" | "displayName">;

/** Primary label: display name, else @handle, else "Wallet 7LoR…BENhz" (design §3.3). */
export function traderName(t: Named): string {
  if (t.displayName) return t.displayName;
  if (t.handle) return `@${t.handle}`;
  return `Wallet ${shortAddr(t.wallet, 4, 5)}`;
}

/** Our own profile page for a wallet. */
export function traderHref(wallet: string): string {
  return `/traders/${encodeURIComponent(wallet)}`;
}

/** FOMO's public profile page: a plain outbound link, never fetched by us. */
export function fomoProfileUrl(handle: string): string {
  return `https://fomo.family/profile/${encodeURIComponent(handle)}`;
}

export function xProfileUrl(xHandle: string): string {
  return `https://x.com/${encodeURIComponent(xHandle)}`;
}
