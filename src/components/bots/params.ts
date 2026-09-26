// Pure helpers for the pixel robots, shared by the React components (client or server) and the
// GET /api/bot/[seed] route. No React, no Node APIs.
//
// Robots come from tools/bots (the generator; see public/bots/README.md):
//  - "hero":   a named robot of the shipped cast (public/bots/svg/<name>.svg), e.g. minty, kit, orbit.
//  - "trader": fromSeed(wallet, { top: "crown" }): the trader's own robot, wearing the crown of "the original".
//  - "agent":  fromSeed(seed): a plain seed robot (agents by id/slug, the signed-in wallet's avatar, placeholders).

import { HERO_ACCENT, HERO_NAMES, HERO_REST, type HeroName } from "./heroes";

export { HERO_NAMES, type HeroName };

export type RobotVariant = "trader" | "agent" | "hero";

/** Every eye state the generator draws (public/bots/README.md "Naming"). The app set is APP_MOODS. */
export const ROBOT_MOODS = [
  "idle",
  "blink",
  "happy",
  "wink",
  "excited",
  "love",
  "buy",
  "sell",
  "money",
  "thinking",
  "sleep",
  "shock",
  "rekt",
  "lookL",
  "lookR",
  "wave",
] as const;
export type RobotMood = (typeof ROBOT_MOODS)[number];
export const APP_MOODS = ["idle", "blink", "happy", "buy", "sell", "sleep"] as const satisfies readonly RobotMood[];

/** Sprites are 32×32: show them only at whole multiples so every pixel stays square. */
export const ROBOT_SIZES = [32, 64, 96, 128, 160, 192, 256] as const;
export type RobotSize = (typeof ROBOT_SIZES)[number];

/** Nearest crisp size (a multiple of 32, at least 32, at most 256). */
export function snapRobotSize(px: number): RobotSize {
  const n = Math.min(256, Math.max(32, Math.round((Number.isFinite(px) ? px : 64) / 32) * 32));
  return n as RobotSize;
}

/** Bump when the generator's output changes: robot URLs are cached as immutable for a year. */
export const BOT_REV = "1";

/** Seeds the route accepts: wallets (base58), agent ids / slugs, hero names, simple labels. */
export const SEED_RE = /^[A-Za-z0-9._-]{1,64}$/;

// ── the generator's hash + first random draw, mirrored so the client knows a seed's accent colour ──────────────

/** FNV-1a over the UTF-8 bytes (tools/bots/robot.mjs fnv1a). */
export function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (const b of new TextEncoder().encode(str)) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** First value of mulberry32(fnv1a(seed)) (tools/bots/robot.mjs rng). */
function firstDraw(seed: string): number {
  const s = (fnv1a(seed) + 0x6d2b79f5) >>> 0;
  let t = s;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** The generator's accent names, in SEED_RULES.accents order. */
export const ROBOT_ACCENTS = ["mint", "blue", "violet", "gold", "pink", "lime", "orange"] as const;
export type RobotAccent = (typeof ROBOT_ACCENTS)[number];

/** A seeded robot's accent: the generator draws it first, so overrides (the trader crown) never change it. */
export function accentForSeed(seed: string): RobotAccent {
  return ROBOT_ACCENTS[Math.floor(firstDraw(seed) * ROBOT_ACCENTS.length)];
}

export function accentFor(p: { seed?: string | null; name?: HeroName | null }): RobotAccent {
  if (p.name) return HERO_ACCENT[p.name];
  return accentForSeed(safeSeed(p.seed ?? ""));
}

/** Base colour of each accent (tools/bots/palette.mjs): rings, dots, legacy "hat" colours. */
export const ACCENT_HEX: Record<RobotAccent, string> = {
  mint: "#3ed6c5",
  blue: "#4c8dff",
  violet: "#9b7bff",
  gold: "#ffc83a",
  pink: "#ff6fb1",
  lime: "#b6f03c",
  orange: "#ff8a3d",
};

/** Tile gradients (light → mid) behind robots, per accent: RobotTile, avatars. White pearl shells read on all. */
export const ACCENT_TILE: Record<RobotAccent, readonly [string, string]> = {
  mint: ["#9eeade", "#4fcbbb"],
  blue: ["#b4d2fd", "#6c9ff5"],
  violet: ["#ddcdfa", "#ae93ef"],
  gold: ["#f7e5c6", "#dcb57f"],
  pink: ["#fbcfe0", "#ee8fb4"],
  lime: ["#dff3b4", "#9fd35a"],
  orange: ["#ffd8b8", "#f4a06a"],
};

/** A seed the route accepts: the input itself when it already is one, else a stable hash of it. */
export function safeSeed(seed: string): string {
  const s = seed.trim();
  return SEED_RE.test(s) ? s : `h${fnv1a(s || "unknown").toString(36)}`;
}

/** A seeded robot's accent colour (base tone), e.g. for a ring that ties a chip to its robot. */
export function seedColor(seed: string): string {
  return ACCENT_HEX[accentForSeed(safeSeed(seed))];
}

export function isHeroName(v: unknown): v is HeroName {
  return typeof v === "string" && (HERO_NAMES as readonly string[]).includes(v);
}

export function isRobotMood(v: unknown): v is RobotMood {
  return typeof v === "string" && (ROBOT_MOODS as readonly string[]).includes(v);
}

/** The mood a hero shows when none is asked for (tofu sleeps, everyone else idles). */
export function heroRestMood(name: HeroName): RobotMood {
  return HERO_REST[name] ?? "idle";
}

/**
 * Image URL of a robot.
 *  - hero in its resting mood → the static /bots/svg/<name>.svg
 *  - any other hero mood, and every seed robot → GET /api/bot/<seed>?v=<variant>[&mood=<mood>]&r=<BOT_REV>
 *    (idle is left out so the same robot is one cache entry)
 */
export function robotSrc(p: { seed?: string | null; name?: HeroName | null; variant?: RobotVariant; mood?: RobotMood }): string {
  if (p.name) {
    const mood = p.mood ?? heroRestMood(p.name);
    if (mood === heroRestMood(p.name)) return `/bots/svg/${p.name}.svg`;
    return `/api/bot/${p.name}?v=hero&mood=${mood}&r=${BOT_REV}`;
  }
  const variant = p.variant === "trader" ? "trader" : "agent";
  const mood = p.mood && p.mood !== "idle" ? `&mood=${p.mood}` : "";
  return `/api/bot/${encodeURIComponent(safeSeed(p.seed ?? ""))}?v=${variant}${mood}&r=${BOT_REV}`;
}

/** Static sprite files of a hero (public/bots). */
export function heroFiles(name: HeroName) {
  return {
    svg: `/bots/svg/${name}.svg`,
    png: `/bots/png/${name}.png`,
    png8x: `/bots/png@8x/${name}.png`,
    blink: `/bots/anim/${name}.blink.png`, // 8 frames × 32 px, 1600 ms loop
    react: `/bots/anim/${name}.react.png`, // 24 frames × 32 px, 4800 ms loop
  } as const;
}

/**
 * The mood that tells an agent's (or a trader's) story at a glance: asleep when paused / stopped, otherwise the
 * side of its latest trade (buy / sell), otherwise idle.
 */
export function robotMood(p: {
  status?: "awaiting_deposit" | "active" | "paused" | "stopped" | null;
  lastSide?: "buy" | "sell" | null;
}): RobotMood {
  if (p.status === "paused" || p.status === "stopped") return "sleep";
  if (p.lastSide === "buy" || p.lastSide === "sell") return p.lastSide;
  return "idle";
}

// ── route input ─────────────────────────────────────────────────────────────────────────────────────────────────

export type BotRequest =
  | { ok: true; variant: RobotVariant; seed: string; mood: RobotMood | null }
  | { ok: false; status: 400 | 404; error: string };

/** Validates GET /api/bot/[seed]?v=&mood=&r= (r is a cache-busting revision and is otherwise ignored). */
export function parseBotRequest(seed: string, query: URLSearchParams): BotRequest {
  if (!SEED_RE.test(seed)) return { ok: false, status: 400, error: "seed: 1-64 characters of A-Z a-z 0-9 . _ -" };
  const v = query.get("v") ?? "agent";
  if (v !== "trader" && v !== "agent" && v !== "hero") return { ok: false, status: 400, error: "v: trader, agent or hero" };
  const m = query.get("mood");
  if (m !== null && !isRobotMood(m)) return { ok: false, status: 400, error: `mood: one of ${ROBOT_MOODS.join(", ")}` };
  const r = query.get("r");
  if (r !== null && !/^[0-9a-z]{1,12}$/i.test(r)) return { ok: false, status: 400, error: "r: a short revision tag" };
  if (v === "hero" && !isHeroName(seed)) return { ok: false, status: 404, error: "no such robot" };
  return { ok: true, variant: v, seed, mood: m };
}
