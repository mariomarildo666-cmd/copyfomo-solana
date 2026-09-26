import { listFeed } from "@/lib/agents";
import type { FeedDTO } from "@/lib/types";
import { getHandler, ok, parseQuery } from "../_lib/request";
import { feedQuery } from "../_lib/schemas";

/** GET /api/feed?limit=30 — public feed of original trades and what an agent did about each. */
export const GET = getHandler(async (req) => {
  const { limit } = parseQuery(req, feedQuery);
  return ok<FeedDTO>(await listFeed(limit));
});
