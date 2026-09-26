// Run: npx tsx --test src/app/api/bot/bot.test.ts
// GET /api/bot/[seed]: renders the tools/bots generator's SVG, immutable caching, deterministic output, input
// validation. No database, no network.
import "../../../lib/__testing__/env"; // first: keeps the real .env out of this test
import { before, test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";

process.env.TRUSTED_IP_SOURCE = "x-real-ip";

let GET: typeof import("./[seed]/route").GET;
before(async () => {
  ({ GET } = await import("./[seed]/route"));
});

const WALLET = "2GtmuqG31LuuWQmKzeK72YjH5iALPkJycuQaEQGsFzLw";

async function get(seed: string, query = ""): Promise<Response> {
  const req = new NextRequest(`http://localhost:3001/api/bot/${encodeURIComponent(seed)}${query}`, {
    headers: { "x-real-ip": "203.0.113.7" },
  });
  return GET(req, { params: Promise.resolve({ seed }) });
}

test("a seed robot is an immutable, cacheable SVG of crisp rects", async () => {
  const res = await get(WALLET, "?v=agent&r=1");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/svg+xml; charset=utf-8");
  assert.equal(res.headers.get("cache-control"), "public, max-age=31536000, immutable");
  const svg = await res.text();
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 32 32"/);
  assert.match(svg, /shape-rendering="crispEdges"/);
  assert.doesNotMatch(svg, /<script|<foreignObject|href=/i);
  // deterministic
  assert.equal(await (await get(WALLET, "?v=agent")).text(), svg);
});

test("variants and moods draw different robots", async () => {
  const agent = await (await get(WALLET)).text();
  const trader = await (await get(WALLET, "?v=trader")).text();
  const buy = await (await get(WALLET, "?v=trader&mood=buy")).text();
  assert.notEqual(agent, trader, "the trader wears a crown");
  assert.notEqual(trader, buy, "buy eyes");
  const hero = await get("minty", "?v=hero&mood=sell");
  assert.equal(hero.status, 200);
  assert.match(await hero.text(), /^<svg/);
});

test("bad input is refused", async () => {
  assert.equal((await get("a b")).status, 400);
  assert.equal((await get("x".repeat(65))).status, 400);
  assert.equal((await get(WALLET, "?v=nope")).status, 400);
  assert.equal((await get(WALLET, "?mood=angry")).status, 400);
  assert.equal((await get("nobody", "?v=hero")).status, 404);
  const body = (await (await get("a b")).json()) as { error: string };
  assert.match(body.error, /seed/);
});
