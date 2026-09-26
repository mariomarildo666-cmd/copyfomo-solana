import { lookupTrader } from "@/lib/fomo";
import { clientIp, rateLimit } from "@/lib/ratelimit";
import type { TraderLookupDTO } from "@/lib/types";
import { getHandler, ok, parseQuery } from "../../_lib/request";
import { lookupQuery } from "../../_lib/schemas";

/**
 * GET /api/traders/lookup?q=<wallet | @handle>.
 *  - Handles resolve only against labels we hold (seed file / Helius labels); never upstream.
 *  - A wallet we don't know yet gets one on-chain FOMO activity check through Helius (cached 6 h, and capped
 *    per UTC day across all users inside lib/fomo-chain; over the cap → note "check_unavailable").
 * Limits: 60 lookups/min per IP; 10 uncached wallet checks/min per IP (429 beyond that).
 */
export const GET = getHandler(async (req) => {
  const { q } = parseQuery(req, lookupQuery);
  const ip = clientIp(req);
  rateLimit(`lookup:${ip}`, 60, 60_000);
  const result = await lookupTrader(q, { beforeCheck: () => rateLimit(`lookup-check:${ip}`, 10, 60_000) });
  return ok<TraderLookupDTO>(result);
});
