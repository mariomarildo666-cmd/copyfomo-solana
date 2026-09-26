// One-time build of src/data/fomo-seed.json from the research team's enriched seed (design §3.2).
//   npx tsx scripts/build-fomo-seed.ts <path/to/fomo-seed-enriched.json> [out=src/data/fomo-seed.json]
//
// Mapping (product decision: ship display names, FOMO handles where known and X handles for every row):
//   name           ← displayName; null when missing or the "fomo user" placeholder
//   handle         ← fomoHandle (FOMO handle — NOT the X handle; e.g. RZD is riziderxbt on X, RZDxbt on FOMO)
//   handleVerified ← the handle is confirmed by a Helius `"<h>" on Fomo` label
//   xHandle        ← xHandle
//   source         ← "solanatracker-fomo-lb-30d@<date>" (+ "+helius-identity" when Helius confirmed the handle)
// Not shipped: rank30dST and co-signer signatures (a co-signed tx may be a Relay deposit, not a trade).

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { parseFomoHandleLabel } from "../src/lib/helius";
import type { FomoSeedEntry, FomoSeedFile } from "../src/lib/fomo-seed";

// Same rules as src/lib/fomo-seed.ts. That module statically imports the JSON this script creates, so it
// is loaded only after writing, to validate the result exactly as the app will load it.
const FOMO_HANDLE_RE = /^[A-Za-z0-9_.]{1,40}$/;
const X_HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;

const SNAPSHOT_DATE = "2026-09-26";
const BASE_SOURCE = `solanatracker-fomo-lb-30d@${SNAPSHOT_DATE}`;
const PLACEHOLDER_NAMES = new Set(["fomo user"]);

/** Sampled: most of these wallets' swaps were not made on FOMO. */
const MOSTLY_OFF_FOMO = ["7LoRpj", "F5MYbj", "DQqP2e", "Ay77dk", "93fjdw", "XB7y64"];
const MOSTLY_OFF_FOMO_NOTE = "trades mostly outside FOMO (sampled)";

/** Manual review: Solana Tracker's display name and Helius's FOMO label come from different sources. */
const NAME_HANDLE_CONFLICT: Record<string, string> = {
  "2GtmuqG31LuuWQmKzeK72YjH5iALPkJycuQaEQGsFzLw":
    'display name "miau" (Solana Tracker) and FOMO handle "sadcrissy" (Helius label) come from different sources; pairing unconfirmed',
};

const enrichedSchema = z.array(
  z
    .object({
      rank30dST: z.number().optional(),
      wallet: z.string(),
      displayName: z.string().nullable(),
      xHandle: z.string().nullable(),
      fomoHandle: z.string().nullable(),
      fomoHandleSource: z.string().nullable(),
      helius: z.object({ tags: z.array(z.string()).nullish(), name: z.string().nullish() }).nullish(),
    })
    .passthrough(),
);

async function main(): Promise<void> {
  const input = process.argv[2];
  if (!input) {
    console.error("usage: npx tsx scripts/build-fomo-seed.ts <fomo-seed-enriched.json> [out]");
    process.exit(2);
  }
  const out = process.argv[3] ?? path.join("src", "data", "fomo-seed.json");
  const rows = enrichedSchema.parse(JSON.parse(readFileSync(input, "utf8")));

  const wallets: FomoSeedEntry[] = rows.map((r) => {
    const rawName = r.displayName?.trim() ?? "";
    const name = rawName && !PLACEHOLDER_NAMES.has(rawName.toLowerCase()) ? rawName.slice(0, 64) : null;

    const handle = r.fomoHandle && FOMO_HANDLE_RE.test(r.fomoHandle) ? r.fomoHandle : null;
    if (r.fomoHandle && !handle) console.warn(`dropping invalid FOMO handle for ${r.wallet}`);
    const label = parseFomoHandleLabel(r.helius?.name ?? null);
    const heliusConfirmed =
      handle !== null &&
      (r.fomoHandleSource === "helius-identity-label" || (label !== null && label.toLowerCase() === handle.toLowerCase()));

    const xHandle = r.xHandle && X_HANDLE_RE.test(r.xHandle) ? r.xHandle : null;
    if (r.xHandle && !xHandle) console.warn(`dropping invalid X handle for ${r.wallet}`);

    const notes: string[] = [];
    if (MOSTLY_OFF_FOMO.some((p) => r.wallet.startsWith(p))) notes.push(MOSTLY_OFF_FOMO_NOTE);
    const conflict = NAME_HANDLE_CONFLICT[r.wallet];
    if (conflict) notes.push(conflict);

    return {
      wallet: r.wallet,
      name,
      handle,
      handleVerified: heliusConfirmed,
      xHandle,
      source: heliusConfirmed ? `${BASE_SOURCE}+helius-identity` : BASE_SOURCE,
      addedAt: SNAPSHOT_DATE,
      exclude: false,
      note: notes.length ? notes.join("; ") : null,
    };
  });

  const file: FomoSeedFile = { version: 1, updatedAt: SNAPSHOT_DATE, wallets };
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(file, null, 2)}\n`);

  const { parseFomoSeed } = await import("../src/lib/fomo-seed");
  const problems: string[] = [];
  const parsed = parseFomoSeed(JSON.parse(readFileSync(out, "utf8")), (m) => problems.push(m));
  if (problems.length || parsed.length !== wallets.length) {
    console.error(`seed validation failed (${out} left for inspection):\n  ${problems.join("\n  ")}`);
    process.exit(1);
  }

  const count = (f: (e: FomoSeedEntry) => boolean) => wallets.filter(f).length;
  console.log(
    `wrote ${out}: ${wallets.length} wallets · names ${count((e) => e.name !== null)} · FOMO handles ${count((e) => e.handle !== null)} ` +
      `(verified ${count((e) => e.handleVerified)}) · X handles ${count((e) => e.xHandle !== null)} · notes ${count((e) => e.note !== null)}`,
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
