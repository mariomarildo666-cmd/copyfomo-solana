import type { NextRequest } from "next/server";
import { handle } from "@/lib/http";
import { assertSameOrigin, clearSession } from "@/lib/session";
import type { SessionDTO } from "@/lib/types";
import { okWithCookie } from "../../_lib/request";

/** POST /api/auth/logout — clear the session cookie. No body. Always 200 { wallet: null }. */
export const POST = handle(async (req: NextRequest) => {
  assertSameOrigin(req);
  return okWithCookie<SessionDTO>({ wallet: null }, clearSession());
});
