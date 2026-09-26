import { getIndexerStatus } from "@/lib/fomo";
import type { IndexerStatusDTO } from "@/lib/types";
import { getHandler, ok } from "../_lib/request";

/**
 * GET /api/indexer — public status of the on-chain FOMO indexer (from the worker's Kv heartbeat): mode, stream
 * connection, last FOMO trade seen, wallet counts, today's Helius credit use as a rounded % and drift warnings.
 * Never carries keys, RPC URLs or raw credit numbers.
 */
export const GET = getHandler(async () => {
  return ok<IndexerStatusDTO>(await getIndexerStatus());
});
