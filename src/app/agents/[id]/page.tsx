import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";
import { prisma } from "@/lib/db";
import { AgentDashboard } from "@/components/app/agent/AgentDashboard";

/**
 * Name-only lookup (never touches keys or balances), shared by metadata and the page within one request.
 * `undefined` = the DB could not be asked; the client dashboard then reports load errors itself.
 */
const findAgentName = cache(async (idOrSlug: string): Promise<{ name: string } | null | undefined> => {
  try {
    return await prisma.agent.findFirst({ where: { OR: [{ id: idOrSlug }, { slug: idOrSlug }] }, select: { name: true } });
  } catch {
    return undefined;
  }
});

export async function generateMetadata(props: PageProps<"/agents/[id]">): Promise<Metadata> {
  const { id } = await props.params;
  const agent = await findAgentName(id);
  if (agent) {
    return {
      title: agent.name,
      description: `${agent.name} is a copyfomo agent mirroring FOMO traders on Solana. Live positions, copies and latency.`,
    };
  }
  return { title: agent === null ? "No agent here" : "Copy agent" };
}

export default async function AgentPage(props: PageProps<"/agents/[id]">) {
  const { id } = await props.params;
  // A real HTTP 404 for unknown agents (the dashboard polls /api/agents/[id] for everything else).
  if ((await findAgentName(id)) === null) notFound();
  return <AgentDashboard idOrSlug={id} />;
}
