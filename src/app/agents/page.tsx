import type { Metadata } from "next";
import { MyAgents } from "@/components/app/agent/MyAgents";

export const metadata: Metadata = {
  title: "Your agents",
  description: "The copyfomo agents owned by the wallet you signed in with.",
};

export default function AgentsPage() {
  return <MyAgents />;
}
