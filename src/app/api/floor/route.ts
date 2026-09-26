import { listFloor } from "@/lib/agents";
import type { FloorDTO } from "@/lib/types";
import { getHandler, ok, parseQuery } from "../_lib/request";
import { floorQuery } from "../_lib/schemas";

/** GET /api/floor?limit=24 — public agent floor (demo agents while there are none). */
export const GET = getHandler(async (req) => {
  const { limit } = parseQuery(req, floorQuery);
  return ok<FloorDTO>(await listFloor(limit));
});
