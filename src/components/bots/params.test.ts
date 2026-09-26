// Run: npx tsx --test src/components/bots/params.test.ts
// The client-side mirror of the generator (accent of a seed), robot URLs, route input validation, and the hero list
// against public/bots/manifest.json.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ACCENT_HEX,
  BOT_REV,
  HERO_NAMES,
  accentForSeed,
  parseBotRequest,
  robotMood,
  robotSrc,
  safeSeed,
  snapRobotSize,
} from "./params";
import { HERO_ACCENT, HERO_REST } from "./heroes";

const WALLETS = [
  "2GtmuqG31LuuWQmKzeK72YjH5iALPkJycuQaEQGsFzLw",
  "DMTgKsvm44d76mrY7sWUEvr9Tx7fsVc3XiadiwZBUAig",
  "9PLvx6JvBmnNZHgsJBRGphgKJu8EJjviXuZdm4d1TcKd",
  "EC2f5DnHzuNRit1ExqghSifDbp1wgrzktsRRZCtU92MJ",
  "Beqv6dzTcjV2eodo8RRXCiCcnSYrS1vkQKhfqwHXqeit",
  "cmg1abcd0000xyz",
  "smoke.test-a1b2",
  "copyfomo-a",
];

test("accentForSeed matches the generator's own accent roll (plain and crowned)", async () => {
  const robot = (await import("../../../tools/bots/robot.mjs")) as {
    fromSeed(seed: string, o?: Record<string, unknown>): { accent: string };
  };
  for (let i = 0; i < 40; i++) {
    const seed = i < WALLETS.length ? WALLETS[i] : `seed-${i}-${i * 7919}`;
    assert.equal(accentForSeed(seed), robot.fromSeed(seed).accent, seed);
    assert.equal(accentForSeed(seed), robot.fromSeed(seed, { top: "crown" }).accent, `${seed} crowned`);
  }
  assert.match(ACCENT_HEX[accentForSeed(WALLETS[0])], /^#[0-9a-f]{6}$/);
});

test("robotSrc: heroes at rest are static files, everything else goes through the route", () => {
  assert.equal(robotSrc({ name: "minty" }), "/bots/svg/minty.svg");
  assert.equal(robotSrc({ name: "tofu", mood: "sleep" }), "/bots/svg/tofu.svg");
  assert.equal(robotSrc({ name: "minty", mood: "buy" }), `/api/bot/minty?v=hero&mood=buy&r=${BOT_REV}`);
  assert.equal(robotSrc({ seed: WALLETS[0], variant: "trader" }), `/api/bot/${WALLETS[0]}?v=trader&r=${BOT_REV}`);
  assert.equal(robotSrc({ seed: "abc", mood: "idle" }), `/api/bot/abc?v=agent&r=${BOT_REV}`);
  assert.equal(robotSrc({ seed: "abc", mood: "sell" }), `/api/bot/abc?v=agent&mood=sell&r=${BOT_REV}`);
  // anything outside the seed charset is hashed into a stable, valid seed
  const odd = robotSrc({ seed: "@some handle/../x" });
  assert.match(odd, /^\/api\/bot\/h[0-9a-z]+\?v=agent&r=/);
  assert.equal(odd, robotSrc({ seed: "@some handle/../x" }));
  assert.equal(safeSeed(""), safeSeed("   "));
});

test("parseBotRequest validates seed, variant, mood and revision", () => {
  const q = (s: string) => new URLSearchParams(s);
  assert.deepEqual(parseBotRequest("abc", q("")), { ok: true, variant: "agent", seed: "abc", mood: null });
  assert.deepEqual(parseBotRequest(WALLETS[0], q("v=trader&mood=buy&r=1")), { ok: true, variant: "trader", seed: WALLETS[0], mood: "buy" });
  assert.deepEqual(parseBotRequest("kit", q("v=hero")), { ok: true, variant: "hero", seed: "kit", mood: null });
  assert.equal(parseBotRequest("nobody", q("v=hero")).ok, false);
  assert.equal((parseBotRequest("nobody", q("v=hero")) as { status: number }).status, 404);
  for (const bad of ["", "a b", "a/b", "<svg>", "x".repeat(65), "é"]) {
    assert.equal((parseBotRequest(bad, q("")) as { status: number }).status, 400, JSON.stringify(bad));
  }
  assert.equal(parseBotRequest("abc", q("v=robot")).ok, false);
  assert.equal(parseBotRequest("abc", q("mood=angry")).ok, false);
  assert.equal(parseBotRequest("abc", q("r=%3Cx%3E")).ok, false);
});

test("snapRobotSize keeps pixels square", () => {
  assert.equal(snapRobotSize(14), 32);
  assert.equal(snapRobotSize(36), 32);
  assert.equal(snapRobotSize(56), 64);
  assert.equal(snapRobotSize(80), 96);
  assert.equal(snapRobotSize(1000), 256);
  assert.equal(snapRobotSize(Number.NaN), 64);
});

test("robotMood: paused / stopped sleep, otherwise the latest trade's side", () => {
  assert.equal(robotMood({ status: "paused", lastSide: "buy" }), "sleep");
  assert.equal(robotMood({ status: "stopped" }), "sleep");
  assert.equal(robotMood({ status: "active", lastSide: "sell" }), "sell");
  assert.equal(robotMood({ status: "active", lastSide: null }), "idle");
  assert.equal(robotMood({}), "idle");
});

test("the hero list matches public/bots/manifest.json", () => {
  const manifest = JSON.parse(readFileSync(join(process.cwd(), "public", "bots", "manifest.json"), "utf8")) as {
    robots: { name: string; mood?: string; spec: { accent: string } }[];
  };
  assert.deepEqual([...HERO_NAMES], manifest.robots.map((r) => r.name));
  for (const r of manifest.robots) {
    assert.equal(HERO_ACCENT[r.name as keyof typeof HERO_ACCENT], r.spec.accent, r.name);
    assert.equal(HERO_REST[r.name as keyof typeof HERO_REST] ?? "idle", r.mood ?? "idle", r.name);
  }
});
