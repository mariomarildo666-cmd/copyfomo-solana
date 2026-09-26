import type { NextRequest } from "next/server";
import { handle } from "@/lib/http";
import { clientIp, rateLimit } from "@/lib/ratelimit";
import { assertSameOrigin, createSignInChallenge, requestDomain } from "@/lib/session";
import type { SignInChallengeDTO } from "@/lib/types";
import { ok, parseBody } from "../../_lib/request";
import { nonceSchema } from "../../_lib/schemas";

/**
 * POST /api/auth/nonce {wallet} — a single-use sign-in challenge (10 min) bound to this wallet and this site's
 * host. The wallet signs `message` (signMessage, UTF-8) and the client posts it to /api/auth/verify.
 * Each call stores a nonce, so it is rate limited per IP and per wallet.
 */
export const POST = handle(async (req: NextRequest) => {
  assertSameOrigin(req);
  rateLimit(`auth-nonce:${clientIp(req)}`, 60, 60_000);
  const { wallet } = await parseBody(req, nonceSchema);
  rateLimit(`auth-nonce-w:${wallet}`, 10, 60_000);
  const challenge = await createSignInChallenge({ wallet, domain: requestDomain(req) });
  return ok<SignInChallengeDTO>(challenge);
});
