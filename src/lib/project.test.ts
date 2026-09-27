// Run: npx tsx --test src/lib/project.test.ts
// The project links (PROJECT_X_URL, TOKEN_*): X URL forms, CA validation, default buy / chart URLs.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_TOKEN_SYMBOL,
  defaultBuyUrl,
  defaultChartUrl,
  isTokenAddress,
  parseHttpsUrl,
  parseTokenSymbol,
  parseXAccount,
  projectFromEnv,
} from "./project";

/** Fake but valid mints: 32 bytes of base58; the first one ends in "pump" like pump.fun mints. */
const PUMP_CA = "DK1c3Nx5c36ubbZzZTvyrSbo6SLFu6wqmuGVU4yipump";
const OTHER_CA = "So11111111111111111111111111111111111111112";

test("X account: URL, twitter.com, @handle and bare handle all normalize to https://x.com/<handle>", () => {
  const want = { url: "https://x.com/copyfomo", handle: "copyfomo" };
  for (const raw of [
    "https://x.com/copyfomo",
    "https://twitter.com/copyfomo",
    "http://x.com/copyfomo",
    "https://www.x.com/copyfomo/",
    "https://mobile.twitter.com/copyfomo",
    "HTTPS://X.COM/copyfomo",
    "x.com/copyfomo",
    "https://x.com/copyfomo?s=21&t=abc",
    "@copyfomo",
    "copyfomo",
    "  @copyfomo  ",
  ]) {
    assert.deepEqual(parseXAccount(raw), want, raw);
  }
  // the handle's case is kept
  assert.deepEqual(parseXAccount("https://x.com/CopyFomo_SOL"), { url: "https://x.com/CopyFomo_SOL", handle: "CopyFomo_SOL" });
});

test("X account: other sites, posts, pages and bad handles are rejected", () => {
  for (const raw of [
    "",
    "@",
    "https://x.com/",
    "https://x.com/copyfomo/status/1834",
    "https://x.com/i/communities/123",
    "https://x.com/home",
    "https://x.com/search?q=copyfomo",
    "https://evil.com/copyfomo",
    "https://x.com.evil.com/copyfomo",
    "https://notx.com/copyfomo",
    "javascript:alert(1)",
    "ftp://x.com/copyfomo",
    "copy fomo",
    "copy-fomo",
    "@abcdefghijklmnop", // 16 characters: X allows 15
    "https://x.com/copyfomo<script>",
  ]) {
    assert.equal(parseXAccount(raw), null, raw);
  }
});

test("token symbol: 1–12 letters or digits, an optional leading $ is dropped", () => {
  assert.equal(parseTokenSymbol("COPYFOMO"), "COPYFOMO");
  assert.equal(parseTokenSymbol("$COPYFOMO"), "COPYFOMO");
  assert.equal(parseTokenSymbol("fomo2"), "fomo2");
  assert.equal(parseTokenSymbol("ABCDEFGHIJKL"), "ABCDEFGHIJKL");
  for (const bad of ["", "$", "ABCDEFGHIJKLM", "COPY FOMO", "COPY-FOMO", "$$COPY", "<b>"]) {
    assert.equal(parseTokenSymbol(bad), null, bad);
  }
});

test("CA: base58 that decodes to a 32-byte address", () => {
  assert.equal(isTokenAddress(PUMP_CA), true);
  assert.equal(isTokenAddress(OTHER_CA), true);
  assert.equal(isTokenAddress("7xKqAbCdEfGhJkLmNpQrStUvWxYz1234567890pump"), false, "0 is not base58");
  assert.equal(isTokenAddress("z".repeat(44)), false, "decodes to 33 bytes");
  assert.equal(isTokenAddress(`${PUMP_CA}1`), false, "45 characters");
  assert.equal(isTokenAddress("abc"), false);
  assert.equal(isTokenAddress(`${PUMP_CA} `), false);
});

test("default links: pump.fun for pump mints, Jupiter otherwise; DexScreener chart", () => {
  assert.equal(defaultBuyUrl(PUMP_CA), `https://pump.fun/coin/${PUMP_CA}`);
  assert.equal(defaultBuyUrl(OTHER_CA), `https://jup.ag/swap/SOL-${OTHER_CA}`);
  assert.equal(defaultChartUrl(PUMP_CA), `https://dexscreener.com/solana/${PUMP_CA}`);
});

test("https URLs only, without credentials", () => {
  assert.equal(parseHttpsUrl("https://birdeye.so/token/abc?chain=solana"), "https://birdeye.so/token/abc?chain=solana");
  assert.equal(parseHttpsUrl("https://Example.com"), "https://example.com/");
  for (const bad of ["http://pump.fun/coin/x", "javascript:alert(1)", "data:text/html,hi", "pump.fun/coin/x", "https://user:pw@pump.fun/", "https://localhost/", ""]) {
    assert.equal(parseHttpsUrl(bad), null, bad);
  }
});

test("projectFromEnv: nothing set → no links, no card", () => {
  assert.deepEqual(projectFromEnv({}), { xUrl: null, xHandle: null, token: null });
  assert.deepEqual(projectFromEnv({ PROJECT_X_URL: " ", TOKEN_CA: "", TOKEN_SYMBOL: "" }), { xUrl: null, xHandle: null, token: null });
});

test("projectFromEnv: X only → the default ticker, launching soon", () => {
  assert.deepEqual(projectFromEnv({ PROJECT_X_URL: "https://twitter.com/copyfomo/" }), {
    xUrl: "https://x.com/copyfomo",
    xHandle: "copyfomo",
    token: { symbol: DEFAULT_TOKEN_SYMBOL, name: null, ca: null, venue: null, buyUrl: null, chartUrl: null },
  });
  // a symbol alone announces the token too (no X link)
  assert.deepEqual(projectFromEnv({ TOKEN_SYMBOL: "$CF" }).token, { symbol: "CF", name: null, ca: null, venue: null, buyUrl: null, chartUrl: null });
});

test("projectFromEnv: a pump.fun CA gets pump.fun + DexScreener links", () => {
  const p = projectFromEnv({ PROJECT_X_URL: "@copyfomo", TOKEN_CA: ` ${PUMP_CA} ` });
  assert.deepEqual(p.token, {
    symbol: "COPYFOMO",
    name: null,
    ca: PUMP_CA,
    venue: "pump.fun",
    buyUrl: `https://pump.fun/coin/${PUMP_CA}`,
    chartUrl: `https://dexscreener.com/solana/${PUMP_CA}`,
  });
});

test("projectFromEnv: another mint buys on Jupiter; explicit URLs win; they need a CA", () => {
  assert.equal(projectFromEnv({ TOKEN_CA: OTHER_CA }).token?.venue, "Solana");
  assert.equal(projectFromEnv({ TOKEN_CA: OTHER_CA }).token?.buyUrl, `https://jup.ag/swap/SOL-${OTHER_CA}`);
  const custom = projectFromEnv({
    TOKEN_CA: PUMP_CA,
    TOKEN_BUY_URL: "https://jup.ag/swap/SOL-COPYFOMO",
    TOKEN_CHART_URL: "https://birdeye.so/token/x",
  }).token;
  assert.equal(custom?.buyUrl, "https://jup.ag/swap/SOL-COPYFOMO");
  assert.equal(custom?.chartUrl, "https://birdeye.so/token/x");
  // before the CA exists there is nothing to buy: the URLs wait for it
  const early = projectFromEnv({ TOKEN_SYMBOL: "COPYFOMO", TOKEN_BUY_URL: "https://pump.fun/" }).token;
  assert.equal(early?.buyUrl, null);
  assert.equal(early?.chartUrl, null);
});

test("projectFromEnv: a malformed value throws and names the setting", () => {
  assert.throws(() => projectFromEnv({ PROJECT_X_URL: "https://instagram.com/copyfomo" }), /PROJECT_X_URL/);
  assert.throws(() => projectFromEnv({ TOKEN_SYMBOL: "TOO-LONG-SYMBOL" }), /TOKEN_SYMBOL/);
  assert.throws(() => projectFromEnv({ TOKEN_CA: "7xKqAbCdEfGhJkLmNpQrStUvWxYz1234567890pump" }), /TOKEN_CA/);
  assert.throws(() => projectFromEnv({ TOKEN_CA: PUMP_CA, TOKEN_BUY_URL: "http://pump.fun/coin/x" }), /TOKEN_BUY_URL/);
  assert.throws(() => projectFromEnv({ TOKEN_CA: PUMP_CA, TOKEN_CHART_URL: "javascript:alert(1)" }), /TOKEN_CHART_URL/);
});

test("projectFromEnv: TOKEN_NAME is shown next to the ticker; junk names are rejected", () => {
  const t = projectFromEnv({ TOKEN_NAME: "  CopyFomo ", TOKEN_SYMBOL: "COPYFOMO" }).token;
  assert.equal(t?.name, "CopyFomo");
  assert.equal(t?.symbol, "COPYFOMO");
  assert.equal(projectFromEnv({ TOKEN_NAME: "CopyFomo" }).token?.name, "CopyFomo", "a name alone announces the token");
  assert.throws(() => projectFromEnv({ TOKEN_NAME: "<b>x</b>" }), /TOKEN_NAME/);
  assert.throws(() => projectFromEnv({ TOKEN_NAME: "x".repeat(40) }), /TOKEN_NAME/);
});
