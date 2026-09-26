// Per-IP budgets shared between API routes and server-rendered pages that do the same work.

import { clientIp, rateLimit } from "@/lib/ratelimit";

const TRADER_DETAIL_MAX = 60;
const TRADER_DETAIL_WINDOW_MS = 60_000;

/**
 * One trader-profile budget per client IP, shared by GET /api/traders/[wallet] and the /traders/[wallet] page
 * (finding F30: the page used to bypass the API's limit). Throws HttpError(429) when exhausted.
 * Pages have no Request: pass `new Request("http://page.local", { headers: await headers() })`.
 */
export function limitTraderDetail(req: Request): void {
  rateLimit(`trader:${clientIp(req)}`, TRADER_DETAIL_MAX, TRADER_DETAIL_WINDOW_MS);
}
