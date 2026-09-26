import { getLeaderboard } from "@/lib/fomo";
import type { LeaderboardDTO } from "@/lib/types";
import { getHandler, okShared, parseQuery } from "../_lib/request";
import { tradersQuery } from "../_lib/schemas";

/**
 * GET /api/traders?window=24h&limit=50 — FOMO leaderboard computed by copyfomo from indexed on-chain FOMO trades
 * (database only; no upstream call). Windows 24h / 7d / 30d ("all" → 30d). Stats refresh every few minutes, so a
 * shared cache may keep the response for a minute.
 */
export const GET = getHandler(async (req) => {
  const { window, limit } = parseQuery(req, tradersQuery);
  return okShared<LeaderboardDTO>(await getLeaderboard(window, limit), 60, 300);
});
