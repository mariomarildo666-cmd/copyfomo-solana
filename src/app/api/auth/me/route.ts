import { readSession } from "@/lib/session";
import type { SessionDTO } from "@/lib/types";
import { getHandler, ok } from "../../_lib/request";

/** GET /api/auth/me — the signed-in wallet, or { wallet: null }. Never 401. */
export const GET = getHandler(async (req) => {
  return ok<SessionDTO>({ wallet: readSession(req) });
});
