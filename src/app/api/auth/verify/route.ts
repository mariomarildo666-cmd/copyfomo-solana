import type { NextRequest } from "next/server";
import { handle } from "@/lib/http";
import { clientIp, rateLimit } from "@/lib/ratelimit";
import { assertSameOrigin, issueSession, requestDomain, verifySignIn } from "@/lib/session";
import type { SessionDTO } from "@/lib/types";
import { okWithCookie, parseBody } from "../../_lib/request";
import { verifySchema } from "../../_lib/schemas";

/**
 * POST /api/auth/verify {wallet, message, signature} — check the wallet's signature over the challenge from
 * /api/auth/nonce (same host, unexpired, unused nonce) and sign the browser in: HttpOnly, SameSite=Lax (Secure
 * in production) session cookie for that wallet. 401 on any mismatch.
 */
export const POST = handle(async (req: NextRequest) => {
  assertSameOrigin(req);
  rateLimit(`auth-verify:${clientIp(req)}`, 60, 60_000);
  const input = await parseBody(req, verifySchema);
  rateLimit(`auth-verify-w:${input.wallet}`, 10, 60_000);
  const wallet = await verifySignIn({ ...input, expectedDomain: requestDomain(req) });
  return okWithCookie<SessionDTO>({ wallet }, issueSession(wallet));
});
