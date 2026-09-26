// Which addresses may be followed as a trader (finding F13).
//
// A "trader" is watched on-chain: the copy watcher streams every transaction that touches it and the FOMO
// indexer adds it to its stream. Following infrastructure (FOMO's relayer, a token mint, a program, an AMM
// authority) would stream a large share of Solana's traffic at priorities the Helius daily cap never pauses,
// and following another agent's deposit wallet makes agents copy each other. So, on create and PATCH:
//   1. a static denylist: FOMO relayer / marker / routers / Relay depository / fee accounts, our platform fee
//      wallet, SOL / USDC / USDT and other well-known mints, system / token / loader / sysvar / DEX programs;
//   2. off-curve addresses (PDAs) are refused: nobody can sign for them, so they can never trade (the parser
//      only copies transactions the trader signed);
//   3. copyfomo agent deposit addresses;
//   4. wallets excluded from copyfomo (seed or indexer: bots, market makers, opt-outs);
//   5. for a wallet we know nothing about, one getAccountInfo: it must not exist yet, or be owned by the System
//      program and not executable (mints, token accounts and programs are refused). Budget-checked at P2;
//      failing to check is a 503, never a silent pass.
// The static rules live in src/lib/infra.ts; the worker filters the same addresses on its side (defense in depth:
// rows created before this check).

import { PublicKey } from "@solana/web3.js";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { fomoSeedByWallet } from "@/lib/fomo-seed";
import { HELIUS_PRIORITY, heliusConfigured, rpc } from "@/lib/helius";
import { HttpError } from "@/lib/http";
import { _resetInfraDenylist, accountRejection, staticTraderRejection, type AccountSnapshot } from "@/lib/infra";
import { connection } from "@/lib/solana";

export {
  accountRejection,
  isInfrastructureAddress,
  KNOWN_MINTS,
  KNOWN_PROGRAMS,
  staticTraderRejection,
  SYSTEM_PROGRAM,
  type AccountSnapshot,
} from "@/lib/infra";

// ── Account check ───────────────────────────────────────────────────────────────────────────────────

/** getAccountInfo for one address: null when the account does not exist. Throws when it can't be checked. */
export type AccountProbe = (address: string) => Promise<AccountSnapshot | null>;

const accountInfoResult = z
  .object({
    value: z
      .object({ owner: z.string(), executable: z.boolean(), space: z.number().int().nonnegative().optional() })
      .passthrough()
      .nullable(),
  })
  .passthrough();

/** Default probe: Helius JSON-RPC at P2 (paused near the daily cap → throws), else the plain RPC connection. */
export const defaultAccountProbe: AccountProbe = async (address) => {
  const params = { encoding: "base64", commitment: "confirmed", dataSlice: { offset: 0, length: 0 } } as const;
  if (heliusConfigured()) {
    const res = await rpc<unknown>("getAccountInfo", [address, params], {
      priority: HELIUS_PRIORITY.backfill,
      retries: 1,
      timeoutMs: 10_000,
    });
    const parsed = accountInfoResult.safeParse(res);
    if (!parsed.success) throw new Error("getAccountInfo: unexpected result shape");
    const v = parsed.data.value;
    return v ? { owner: v.owner, executable: v.executable, space: v.space ?? null } : null;
  }
  const info = await connection().getAccountInfo(new PublicKey(address), { commitment: "confirmed", dataSlice: { offset: 0, length: 0 } });
  return info ? { owner: info.owner.toBase58(), executable: info.executable, space: null } : null;
};

// Positive answers are stable (a System-owned wallet stays one); cache them per process.
const PROBE_OK_TTL_MS = 6 * 3600_000;
const probeOk = new Map<string, number>();

// ── Entry point ─────────────────────────────────────────────────────────────────────────────────────

export interface TraderGuardOptions {
  /** Wallets the agent already follows (PATCH): skip the network check for them. */
  alreadyFollowed?: ReadonlySet<string>;
  /** Injectable for tests. */
  probe?: AccountProbe;
  now?: number;
}

/**
 * Throw HttpError(400) with `fields["traders.<i>.wallet"]` for every wallet (in input order) that can't be
 * followed; HttpError(503) when an unknown wallet could not be checked.
 */
export async function assertFollowableTraders(wallets: readonly string[], opts: TraderGuardOptions = {}): Promise<void> {
  const fields: Record<string, string> = {};
  const reject = (i: number, why: string) => {
    fields[`traders.${i}.wallet`] ??= why;
  };

  wallets.forEach((w, i) => {
    const why = staticTraderRejection(w);
    if (why) reject(i, why);
  });

  const unique = [...new Set(wallets)];
  const [agentWallets, fomoRows] = await Promise.all([
    prisma.agent.findMany({ where: { depositAddress: { in: unique } }, select: { depositAddress: true } }),
    prisma.fomoWallet.findMany({
      where: { wallet: { in: unique } },
      select: { wallet: true, status: true, origin: true, evidenceSig: true },
    }),
  ]);
  const agentSet = new Set(agentWallets.map((a) => a.depositAddress));
  const fomo = new Map(fomoRows.map((r) => [r.wallet, r]));
  const seed = fomoSeedByWallet();

  wallets.forEach((w, i) => {
    if (agentSet.has(w)) reject(i, "that's a copyfomo agent wallet — copy the trader it follows instead");
    if (seed.get(w)?.exclude || fomo.get(w)?.status === "excluded") {
      reject(i, "this wallet is excluded from copyfomo (bot, market maker or opted out)");
    }
  });

  // Network check only for wallets that passed so far, are new to this agent and that we know nothing about.
  const now = opts.now ?? Date.now();
  const probe = opts.probe ?? defaultAccountProbe;
  const toProbe: { i: number; wallet: string }[] = [];
  wallets.forEach((w, i) => {
    if (fields[`traders.${i}.wallet`] || opts.alreadyFollowed?.has(w)) return;
    const row = fomo.get(w);
    const known = seed.has(w) || (row !== undefined && (row.origin !== "user" || row.status === "tracked" || row.evidenceSig !== null));
    if (known) return;
    const okAt = probeOk.get(w);
    if (okAt !== undefined && now - okAt < PROBE_OK_TTL_MS) return;
    toProbe.push({ i, wallet: w });
  });

  const unavailable: string[] = [];
  await Promise.all(
    toProbe.map(async ({ i, wallet }) => {
      let acct: AccountSnapshot | null;
      try {
        acct = await probe(wallet);
      } catch {
        unavailable.push(wallet);
        return;
      }
      const why = accountRejection(acct);
      if (why) reject(i, why);
      else {
        if (probeOk.size > 10_000) probeOk.clear();
        probeOk.set(wallet, now);
      }
    }),
  );

  if (Object.keys(fields).length > 0) throw new HttpError(400, "invalid input", fields);
  if (unavailable.length > 0) {
    throw new HttpError(503, "couldn't check the trader wallet right now — try again in a moment", undefined, { "retry-after": "10" });
  }
}

/** Test hook: forget cached probe results. */
export function _resetTraderGuardCache(): void {
  probeOk.clear();
  _resetInfraDenylist();
}
