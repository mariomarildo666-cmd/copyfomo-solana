// Agent names and slugs. name: ≤ 24 chars of [a-z0-9_.-]; slug: name + "-" + 4 random chars.

import { randomInt } from "node:crypto";
import type { Trader } from "@prisma/client";
import { AGENT_NAME_MAX } from "./schemas";

const NAME_SUFFIX = ".copy";
const SLUG_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const SLUG_RANDOM_LEN = 4;

function sanitize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9_.-]/g, "")
    .replace(/^[._-]+|[._-]+$/g, "");
}

/** `<first handle or short wallet>.copy`, e.g. "moonmath.copy" or "9wzd_awwm.copy". */
export function defaultAgentName(first: Trader): string {
  const room = AGENT_NAME_MAX - NAME_SUFFIX.length;
  const fromHandle = first.handle ? sanitize(sanitize(first.handle).slice(0, room)) : "";
  const base = /[a-z0-9]/.test(fromHandle)
    ? fromHandle
    : `${first.wallet.slice(0, 4)}_${first.wallet.slice(-4)}`.toLowerCase();
  return `${base}${NAME_SUFFIX}`;
}

export function newSlug(name: string): string {
  let suffix = "";
  for (let i = 0; i < SLUG_RANDOM_LEN; i++) suffix += SLUG_ALPHABET[randomInt(SLUG_ALPHABET.length)];
  return `${name}-${suffix}`;
}
