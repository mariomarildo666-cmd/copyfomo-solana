// Run: npx tsx --test src/lib/config.test.ts
// The seal private key never reaches the web process (F11), and live mode's hard requirements.
import "./__testing__/env"; // first: keeps the real .env (keys, RPC URLs) out of this test
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const FAKE_PRIV = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";

/** Import config.ts in a fresh process with `env` and report what it exposes. */
function probe(env: Record<string, string>): { ok: true; key: string; envKey: string | null } | { ok: false; error: string } {
  const code = `import("./src/lib/config.ts").then(
    (m) => console.log(JSON.stringify({ ok: true, key: m.config.walletSealPrivateKey, envKey: process.env.WALLET_SEAL_PRIVATE_KEY ?? null })),
    (e) => console.log(JSON.stringify({ ok: false, error: String(e && e.message) })),
  );`;
  const out = execFileSync(process.execPath, ["--import", "tsx", "-e", code], {
    env: { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "", DATABASE_URL: "file:./none.db", ...env } as unknown as NodeJS.ProcessEnv,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(out.trim().split("\n").pop()!);
}

test("worker / scripts (no NEXT_RUNTIME) read the private key", () => {
  const r = probe({ COPYFOMO_MODE: "live", WALLET_SEAL_PRIVATE_KEY: FAKE_PRIV });
  assert.deepEqual(r, { ok: true, key: FAKE_PRIV, envKey: FAKE_PRIV });
});

test("the Next.js server never exposes it: paper mode scrubs it from process.env", () => {
  const r = probe({ NEXT_RUNTIME: "nodejs", COPYFOMO_MODE: "paper", WALLET_SEAL_PRIVATE_KEY: FAKE_PRIV });
  assert.deepEqual(r, { ok: true, key: "", envKey: null });
});

test("the Next.js server refuses to load config in live mode while the private key is in its environment", () => {
  const r = probe({ NEXT_RUNTIME: "nodejs", COPYFOMO_MODE: "live", WALLET_SEAL_PRIVATE_KEY: FAKE_PRIV });
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /WALLET_SEAL_PRIVATE_KEY is set in the web process/);
  const clean = probe({ NEXT_RUNTIME: "nodejs", COPYFOMO_MODE: "live" });
  assert.deepEqual(clean, { ok: true, key: "", envKey: null });
});

test("fee settings are validated at startup", () => {
  assert.equal(probe({ PLATFORM_FEE_BPS: "2500" }).ok, false, "above 20% is rejected");
  assert.equal(probe({ PLATFORM_FEE_BPS: "abc" }).ok, false);
  assert.equal(probe({ PLATFORM_FEE_WALLET: "not-an-address" }).ok, false);
  assert.equal(probe({ PLATFORM_FEE_BPS: "500", PLATFORM_FEE_WALLET: "So11111111111111111111111111111111111111112" }).ok, true);
});

test("liveConfigErrors: fee wallet, Jupiter key and the retiring lite-api are required for live", async () => {
  const { liveConfigErrors } = await import("./config");
  const ok = { platformFeeWallet: "So11111111111111111111111111111111111111112", jupiterUrl: "https://api.jup.ag", jupiterApiKey: "k" };
  assert.deepEqual(liveConfigErrors(ok), []);
  assert.equal(liveConfigErrors({ ...ok, platformFeeWallet: "" }).length, 1);
  assert.match(liveConfigErrors({ ...ok, platformFeeWallet: "" })[0]!, /PLATFORM_FEE_WALLET/);
  assert.match(liveConfigErrors({ ...ok, jupiterApiKey: "" })[0]!, /JUPITER_API_KEY/);
  assert.match(liveConfigErrors({ ...ok, jupiterUrl: "https://lite-api.jup.ag" })[0]!, /lite-api/);
});
