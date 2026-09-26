import { walletSolBalance } from "@/lib/deposit";
import { clientIp, rateLimit } from "@/lib/ratelimit";
import { requireSession } from "@/lib/session";
import type { WalletBalanceDTO } from "@/lib/types";
import { getHandler, ok, upstream } from "../../_lib/request";

/**
 * GET /api/me/balance — the signed-in wallet's SOL balance for the create wizard's "Fund" step. Cached 10 s and
 * single-flight per wallet (lib/deposit), budget-checked (P2), and rate limited per wallet and per IP. The browser
 * never gets an RPC URL. 401 signed out, 503 when the balance can't be read right now.
 */
export const GET = getHandler(async (req) => {
  const wallet = requireSession(req);
  rateLimit(`me-balance:${wallet}`, 20, 60_000);
  rateLimit(`me-balance-ip:${clientIp(req)}`, 60, 60_000);
  const sol = await upstream("wallet balance", "couldn't read your wallet balance right now — try again", () => walletSolBalance(wallet));
  return ok<WalletBalanceDTO>({ sol });
});
