import { getTraderDetail } from "@/lib/fomo";
import { HttpError } from "@/lib/http";
import type { TraderDetailDTO } from "@/lib/types";
import { limitTraderDetail } from "../../_lib/limits";
import { getHandler, ok, parseQuery, walletRef } from "../../_lib/request";
import { traderDetailQuery } from "../../_lib/schemas";

/**
 * GET /api/traders/[wallet] — one trader's copyfomo profile: labels, per-window stats, 30d per-mint PnL (computed
 * on demand from indexed FOMO trades, cached 30 s per wallet in lib/fomo), open positions and the newest 50 FOMO
 * trades. Database only. 404 for invalid, unknown or excluded (opted-out) wallets. 60/min per IP, shared with the
 * /traders/[wallet] page (_lib/limits).
 * `?view=summary` returns the trader + window stats only (perMint / positions / recent empty): a light poll for an
 * open profile tab instead of re-rendering the whole page (finding F30).
 */
export const GET = getHandler(async (req, ctx: RouteContext<"/api/traders/[wallet]">) => {
  limitTraderDetail(req);
  const { wallet } = await ctx.params;
  const { view } = parseQuery(req, traderDetailQuery);
  const detail = await getTraderDetail(walletRef(wallet));
  if (!detail) throw new HttpError(404, "trader not found");
  if (view === "summary") {
    return ok<TraderDetailDTO>({ ...detail, perMint: [], positions: [], recent: [] }, 200, { "cache-control": "private, max-age=30" });
  }
  return ok<TraderDetailDTO>(detail);
});
