// Curated FOMO wallets (src/data/fomo-seed.json, built once by scripts/build-fomo-seed.ts). Design §3.1.
// The seed is authoritative for the labels it provides; `source` records where each row came from.
// A handle resolves to a wallet only through this file or our DB (Helius labels) — never from user input.

import { z } from "zod";
import seedFile from "../data/fomo-seed.json";
import { isValidSolanaAddress } from "./solana";

/** FOMO handle without "@". */
export const FOMO_HANDLE_RE = /^[A-Za-z0-9_.]{1,40}$/;
/** X/Twitter handle without "@". */
export const X_HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;

export interface FomoSeedEntry {
  wallet: string;
  /** Display name (null for placeholders). */
  name: string | null;
  /** FOMO handle without "@". */
  handle: string | null;
  /** True only for a Helius `"<h>" on Fomo` label or manual confirmation. */
  handleVerified: boolean;
  xHandle: string | null;
  /** Honest provenance of the row. */
  source: string;
  addedAt: string;
  /** Never rank this wallet (market makers, bots, opt-outs). */
  exclude: boolean;
  note: string | null;
}

export interface FomoSeedFile {
  version: 1;
  updatedAt: string;
  wallets: FomoSeedEntry[];
}

const entrySchema = z
  .object({
    wallet: z.string().refine(isValidSolanaAddress, "not a Solana address"),
    name: z.string().trim().min(1).max(64).nullable(),
    handle: z.string().regex(FOMO_HANDLE_RE, "invalid FOMO handle").nullable(),
    handleVerified: z.boolean().optional(),
    xHandle: z.string().regex(X_HANDLE_RE, "invalid X handle").nullish(),
    source: z.string().trim().min(1).max(200),
    addedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD"),
    exclude: z.boolean().optional(),
    note: z.string().max(500).nullish(),
  })
  .transform(
    (e): FomoSeedEntry => ({
      wallet: e.wallet,
      name: e.name,
      handle: e.handle,
      handleVerified: e.handle !== null && e.handleVerified === true,
      xHandle: e.xHandle ?? null,
      source: e.source,
      addedAt: e.addedAt,
      exclude: e.exclude ?? false,
      note: e.note ?? null,
    }),
  );

const fileSchema = z.object({
  version: z.literal(1),
  updatedAt: z.string(),
  wallets: z.array(z.unknown()),
});

/** Validate a seed file. Invalid rows are skipped with a warning; the first duplicate wallet wins. */
export function parseFomoSeed(raw: unknown, warn: (msg: string) => void = (m) => console.warn(m)): FomoSeedEntry[] {
  const file = fileSchema.safeParse(raw);
  if (!file.success) {
    warn(`[fomo-seed] invalid seed file: ${file.error.issues[0]?.message ?? "unknown"}`);
    return [];
  }
  const out: FomoSeedEntry[] = [];
  const seen = new Set<string>();
  file.data.wallets.forEach((row, i) => {
    const r = entrySchema.safeParse(row);
    if (!r.success) {
      const issue = r.error.issues[0];
      warn(`[fomo-seed] row ${i} skipped: ${issue ? `${issue.path.join(".") || "(row)"}: ${issue.message}` : "invalid"}`);
      return;
    }
    if (seen.has(r.data.wallet)) {
      warn(`[fomo-seed] row ${i} skipped: duplicate wallet ${r.data.wallet}`);
      return;
    }
    seen.add(r.data.wallet);
    out.push(r.data);
  });
  return out;
}

let cached: readonly FomoSeedEntry[] | null = null;
let byWallet: ReadonlyMap<string, FomoSeedEntry> | null = null;

/** Seed rows in file order (validated once per process). Includes excluded rows — check `exclude`. */
export function loadFomoSeed(): FomoSeedEntry[] {
  cached ??= Object.freeze(parseFomoSeed(seedFile));
  return [...cached];
}

/** Seed rows by wallet. */
export function fomoSeedByWallet(): ReadonlyMap<string, FomoSeedEntry> {
  byWallet ??= new Map(loadFomoSeed().map((e) => [e.wallet, e]));
  return byWallet;
}
