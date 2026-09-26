// Server-side robot rendering for GET /api/bot/[seed]: loads the pixel-robot generator from tools/bots (plain
// Node ESM that reads its part files from disk at import time) and turns a spec into the generator's own SVG.
//
// The generator is imported at runtime with a native import() that the bundler leaves alone
// (webpackIgnore / turbopackIgnore): it must run from its own folder so `import.meta.url` and its part
// registry resolve. It is resolved from the project root (process.cwd(), as `next dev` / `next start` run).

import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { RobotMood, RobotVariant } from "@/components/bots/params";

type Spec = Record<string, unknown> & { mood?: string };
interface Composed {
  rgba: Uint8ClampedArray;
  w: number;
  h: number;
}
interface RobotModule {
  fromSeed(seed: string, overrides?: Record<string, unknown>): Spec;
  compose(spec: Spec): Composed;
  LOAD_ERRORS: string[];
}
interface SvgModule {
  toSVG(rgba: Uint8ClampedArray, w: number, h: number, opts?: { scale?: number; title?: string }): string;
}
interface CastEntry extends Spec {
  name: string;
}
interface Engine {
  robot: RobotModule;
  svg: SvgModule;
  cast: Map<string, Spec>;
}

const LIST_ONLY_KEYS = ["name", "group", "about", "moodSet", "lab", "seed"] as const;

let engine: Promise<Engine> | null = null;

async function importTool<T>(dir: string, file: string): Promise<T> {
  const url = pathToFileURL(join(dir, file)).href;
  return (await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ url)) as T;
}

function loadEngine(): Promise<Engine> {
  engine ??= (async () => {
    const dir = join(process.cwd(), "tools", "bots");
    const [robot, svg, castMod] = await Promise.all([
      importTool<RobotModule>(dir, "robot.mjs"),
      importTool<SvgModule>(dir, "svg.mjs"),
      importTool<{ default: CastEntry[] }>(dir, "robots.mjs"),
    ]);
    if (robot.LOAD_ERRORS.length) throw new Error(`robot parts failed to load: ${robot.LOAD_ERRORS.join("; ")}`);
    const cast = new Map<string, Spec>();
    for (const entry of castMod.default) {
      // drop the list-only keys (tools/bots/render.mjs resolveSpec); cast entries are full specs, never seeds
      const spec: Spec = { ...entry };
      for (const k of LIST_ONLY_KEYS) delete spec[k];
      cast.set(entry.name, spec);
    }
    return { robot, svg, cast };
  })().catch((err: unknown) => {
    engine = null; // retry on the next request
    throw err;
  });
  return engine;
}

/** The spec of one robot: a seeded agent, a crowned trader, or a named hero (null when there is no such hero). */
function specFor(e: Engine, variant: RobotVariant, seed: string): Spec | null {
  if (variant === "hero") return e.cast.get(seed) ?? null;
  if (variant === "trader") return e.robot.fromSeed(seed, { top: "crown" });
  return e.robot.fromSeed(seed);
}

// Rendered SVGs by request key. Small (≈10 KB each) and deterministic; a bounded map is enough.
const MAX_CACHED = 400;
const cache = new Map<string, string>();

export function cacheKey(variant: RobotVariant, seed: string, mood: RobotMood | null): string {
  return `${variant}:${seed}:${mood ?? ""}`;
}

export function cachedSvg(key: string): string | undefined {
  const hit = cache.get(key);
  if (hit !== undefined) {
    cache.delete(key); // LRU: move to the newest end
    cache.set(key, hit);
  }
  return hit;
}

/**
 * The robot as the generator's SVG (32×32 viewBox of crisp rects, shape-rendering="crispEdges"), or null for an
 * unknown hero. `mood` null = the robot's resting mood.
 */
export async function renderRobotSvg(variant: RobotVariant, seed: string, mood: RobotMood | null): Promise<string | null> {
  const key = cacheKey(variant, seed, mood);
  const hit = cachedSvg(key);
  if (hit !== undefined) return hit;
  const e = await loadEngine();
  const spec = specFor(e, variant, seed);
  if (!spec) return null;
  const r = e.robot.compose({ ...spec, mood: mood ?? spec.mood ?? "idle" });
  const svg = e.svg.toSVG(r.rgba, r.w, r.h, { scale: 8 });
  cache.set(key, svg);
  if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value as string);
  return svg;
}
