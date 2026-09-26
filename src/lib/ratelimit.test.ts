// Run: npx tsx --test src/lib/ratelimit.test.ts
// Per-IP rate-limit keys must not be client-controlled (finding F27).
import "./__testing__/env"; // first: keeps the real .env (keys, RPC URLs) out of this test
import { test } from "node:test";
import assert from "node:assert/strict";
import { clientIp, normalizeIp, rateLimit, UNKNOWN_CLIENT } from "./ratelimit";
import { HttpError } from "./http";

const req = (headers: Record<string, string>) => new Request("http://localhost:3001/api/x", { headers });

test("xff (default): the entry the trusted proxy appended, never the client-controlled leftmost", () => {
  // nginx $proxy_add_x_forwarded_for: "<whatever the client sent>, <real peer>"
  assert.equal(clientIp(req({ "x-forwarded-for": "6.6.6.6, 203.0.113.7" }), { source: "xff", hops: 1 }), "203.0.113.7");
  assert.equal(clientIp(req({ "x-forwarded-for": "1.1.1.1, 2.2.2.2, 203.0.113.7" }), { source: "xff", hops: 1 }), "203.0.113.7");
  // Two trusted proxies (e.g. Cloudflare → nginx): the second entry from the right.
  assert.equal(clientIp(req({ "x-forwarded-for": "6.6.6.6, 198.51.100.4, 10.0.0.2" }), { source: "xff", hops: 2 }), "198.51.100.4");
  // Fewer entries than hops, garbage, or none: shared unknown bucket.
  assert.equal(clientIp(req({ "x-forwarded-for": "10.0.0.2" }), { source: "xff", hops: 2 }), UNKNOWN_CLIENT);
  assert.equal(clientIp(req({ "x-forwarded-for": "not-an-ip" }), { source: "xff", hops: 1 }), UNKNOWN_CLIENT);
  assert.equal(clientIp(req({}), { source: "xff", hops: 1 }), UNKNOWN_CLIENT);
});

test("rotating a spoofed leftmost X-Forwarded-For no longer yields fresh buckets", () => {
  const key = () => `t-spoof:${clientIp(req({ "x-forwarded-for": `${Math.floor(Math.random() * 255)}.1.2.3, 203.0.113.9` }), { source: "xff", hops: 1 })}`;
  let limited = 0;
  for (let i = 0; i < 8; i++) {
    try {
      rateLimit(key(), 5, 600_000);
    } catch (err) {
      assert.ok(err instanceof HttpError && err.status === 429);
      limited++;
    }
  }
  assert.equal(limited, 3, "5 allowed, the rest limited despite 8 different spoofed values");
});

test("single-header sources read only that header; x-real-ip no longer loses to X-Forwarded-For", () => {
  const h = { "x-forwarded-for": "6.6.6.6", "x-real-ip": "203.0.113.8", "cf-connecting-ip": "198.51.100.1" };
  assert.equal(clientIp(req(h), { source: "x-real-ip" }), "203.0.113.8");
  assert.equal(clientIp(req(h), { source: "cf-connecting-ip" }), "198.51.100.1");
  assert.equal(clientIp(req({ "x-vercel-forwarded-for": "203.0.113.5, 10.0.0.1" }), { source: "x-vercel-forwarded-for" }), "203.0.113.5");
  assert.equal(clientIp(req(h), { source: "none" }), UNKNOWN_CLIENT);
});

test("normalizeIp: IPv6 aggregated to /64; ports, brackets and IPv4-mapped forms stripped", () => {
  assert.equal(normalizeIp("2001:db8:abcd:12:1:2:3:4"), "2001:db8:abcd:12::/64");
  assert.equal(normalizeIp("2001:0db8:abcd:0012:ffff:ffff:ffff:ffff"), "2001:db8:abcd:12::/64", "same /64, same key");
  assert.equal(normalizeIp("2001:db8::1"), "2001:db8:0:0::/64");
  assert.equal(normalizeIp("[2001:db8:1:2::5]:443"), "2001:db8:1:2::/64");
  assert.equal(normalizeIp("::1"), "0:0:0:0::/64");
  assert.equal(normalizeIp("::ffff:203.0.113.7"), "203.0.113.7");
  assert.equal(normalizeIp("203.0.113.7:51234"), "203.0.113.7");
  assert.equal(normalizeIp(""), UNKNOWN_CLIENT);
  assert.equal(normalizeIp("<script>"), UNKNOWN_CLIENT);
});
