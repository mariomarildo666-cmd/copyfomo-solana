import { workerOnline } from "@/lib/agents";
import { config } from "@/lib/config";
import type { AppConfigDTO } from "@/lib/types";
import { getHandler, ok } from "../_lib/request";
import { LIVE_MAX_SLIPPAGE_BPS } from "../_lib/schemas";

/** Public app settings. Picks fields explicitly: no keys, RPC URLs, fee wallet or other env ever leave here. */
export const GET = getHandler(async () => {
  return ok<AppConfigDTO>({
    mode: config.mode,
    // Only whether a Helius key is set (and the indexer not switched off) — never the key itself.
    onchainRanking: config.heliusApiKey !== "" && config.fomoIndexer,
    copyVenue: config.copyVenue,
    workerOnline: await workerOnline(),
    minDepositSol: config.minDepositSol,
    paperStartSol: config.paperStartSol,
    maxTradersPerAgent: config.maxTradersPerAgent,
    // 500 = 5% of the realized profit on each winning copy sell. Losing sells, buys, deposits, withdrawals: 0.
    platformFeeBps: config.platformFeeBps,
    maxLiveSlippageBps: LIVE_MAX_SLIPPAGE_BPS,
  });
});
