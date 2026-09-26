// What an agent on the floor "says" in its speech bubble, derived from real state:
// its status, its latest copy in the feed, else its last spark bar, else small talk.

import type { RobotMood } from "@/components/bots/params";
import type { AgentSummaryDTO, FeedItemDTO } from "@/lib/types";
import { tokenLabel } from "@/lib/format";
import { shortReason } from "./model";

export interface Chatter {
  text: string;
  mood: RobotMood;
}

const SMALL_TALK = ["watching…", "dip incoming", "gm", "waiting for a move", "eyes on chain"];

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** Latest feed row per agent id (feed is newest first). */
export function latestCopyByAgent(items: FeedItemDTO[]): Map<string, FeedItemDTO> {
  const m = new Map<string, FeedItemDTO>();
  for (const it of items) if (it.copy && !m.has(it.copy.agentId)) m.set(it.copy.agentId, it);
  return m;
}

export function chatterFor(a: AgentSummaryDTO, latest: FeedItemDTO | undefined): Chatter {
  if (a.status === "awaiting_deposit") return { text: "feed me SOL", mood: "blink" };
  if (a.status === "paused") return { text: "zzz", mood: "sleep" };
  if (a.status === "stopped") return { text: "cashed out", mood: "sleep" };

  const c = latest?.copy;
  if (latest && c) {
    const token = tokenLabel(latest.original.symbol, latest.original.mint);
    const side = latest.original.side;
    switch (c.status) {
      case "filled":
        return { text: `${side === "buy" ? "copied" : "sold"} ${token}`, mood: side };
      case "skipped":
        return { text: `skipped: ${shortReason(c.reason)}`, mood: "blink" };
      case "failed":
        return { text: `failed: ${shortReason(c.reason)}`, mood: "blink" };
      case "pending":
        return { text: `copying ${token}…`, mood: "idle" };
    }
  }

  const last = a.spark.at(-1);
  if (last) return { text: last.side === "buy" ? "copied" : "sold", mood: last.side };
  return { text: SMALL_TALK[hash(a.id) % SMALL_TALK.length], mood: "idle" };
}
