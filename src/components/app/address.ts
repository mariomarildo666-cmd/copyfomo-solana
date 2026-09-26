// Client-side Solana address sanity check. The server validates for real;
// this only catches typos before a round trip.

import bs58 from "bs58";

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function looksLikeSolanaAddress(s: string): boolean {
  const v = s.trim();
  if (!BASE58.test(v)) return false;
  try {
    return bs58.decode(v).length === 32;
  } catch {
    return false;
  }
}

/** Sanitize anything into an agent name: `[a-z0-9_.-]`, max 24 chars. */
export function toAgentName(base: string): string {
  const cleaned = base
    .toLowerCase()
    .replace(/^@/, "")
    .replace(/[^a-z0-9_.-]+/g, "")
    .slice(0, 19); // leave room for ".copy"
  return cleaned ? `${cleaned}.copy` : "";
}

export const AGENT_NAME_RE = /^[a-z0-9_.-]{1,24}$/;
