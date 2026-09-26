import type { Metadata } from "next";
import { CreateWizard } from "@/components/app/create/CreateWizard";

export const metadata: Metadata = {
  title: "Build an agent",
  description: "Pick FOMO traders or any Solana wallet, set copy rules, and fund your copy agent from your wallet in one click.",
};

/** Hard cap on how many ?t= entries we try to resolve; the server enforces the real per-agent limit. */
const MAX_QUERIES = 20;

function parseTraderParam(t: string | string[] | undefined): string[] {
  const raw = Array.isArray(t) ? t.join(",") : (t ?? "");
  const seen = new Set<string>();
  for (const part of raw.split(",")) {
    const q = part.trim();
    if (q && q.length <= 64) seen.add(q);
  }
  return [...seen].slice(0, MAX_QUERIES);
}

export default async function CreatePage(props: PageProps<"/create">) {
  const { t } = await props.searchParams;
  const queries = parseTraderParam(t);
  // Re-key so a new ?t= list starts a fresh wizard.
  return <CreateWizard key={queries.join(",")} initialQueries={queries} />;
}
