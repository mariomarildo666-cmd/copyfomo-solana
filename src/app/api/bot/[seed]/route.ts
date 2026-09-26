import { HttpError } from "@/lib/http";
import { clientIp, rateLimit } from "@/lib/ratelimit";
import { parseBotRequest } from "@/components/bots/params";
import { getHandler } from "../../_lib/request";
import { cacheKey, cachedSvg, renderRobotSvg } from "../render";

/** Fresh renders per client IP (cache hits are free): a leaderboard page shows ~50 robots at once. */
const RENDERS_PER_MIN = 600;

/**
 * GET /api/bot/[seed]?v=trader|agent|hero&mood=<mood>&r=<rev> — one pixel robot as SVG (32×32 grid of crisp
 * rects), drawn by the tools/bots generator:
 *   v=agent  (default) fromSeed(seed): agents (by id / slug), wallet avatars, placeholders
 *   v=trader           fromSeed(seed, { top: "crown" }): a trader's robot, crowned
 *   v=hero             the named robot `seed` of the shipped cast (404 when there is none)
 * `mood` picks the eye state (default: the robot's resting mood); `r` is a revision tag that only busts caches.
 * Deterministic for a given generator, so responses are public and immutable. No database, no secrets.
 */
export const GET = getHandler(async (req, ctx: RouteContext<"/api/bot/[seed]">) => {
  const { seed } = await ctx.params;
  const parsed = parseBotRequest(seed, req.nextUrl.searchParams);
  if (!parsed.ok) throw new HttpError(parsed.status, parsed.error);

  const key = cacheKey(parsed.variant, parsed.seed, parsed.mood);
  if (cachedSvg(key) === undefined) rateLimit(`bot:${clientIp(req)}`, RENDERS_PER_MIN, 60_000);

  const svg = await renderRobotSvg(parsed.variant, parsed.seed, parsed.mood);
  if (svg === null) throw new HttpError(404, "no such robot");
  return new Response(svg, {
    status: 200,
    headers: {
      "content-type": "image/svg+xml; charset=utf-8",
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
});
