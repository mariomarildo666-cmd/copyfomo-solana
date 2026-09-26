// End-to-end smoke test of every /api endpoint against a running copyfomo server (paper mode only).
//
//   npx tsx scripts/smoke-api.ts                      # BASE_URL defaults to http://localhost:3001
//   BASE_URL=http://localhost:3002 npx tsx scripts/smoke-api.ts
//
// Optional env:
//   SMOKE_TRADER_WALLET        wallet to follow (default: the first non-excluded wallet of src/data/fomo-seed.json,
//                              so lookups need no Helius check and no new wallet gets tracked)
//   SMOKE_COMMAND_TIMEOUT_MS   how long to wait for the worker to finish a command (default 30000)
//
// Wallet login: the script signs in with two FRESH throwaway keypairs (SIWS-style message, ed25519), keeps each
// one's session cookie, and sends a same-origin Origin header on writes like a browser would.
// Side effects: creates ONE paper agent named "smoke.test" in the target DB (credited 1 simulated SOL) and
// pauses it at the end. POST /api/agents is rate limited, so back-to-back runs may hit 429.
// Every response body is also scanned for leaked secrets (Helius key / RPC URLs).
// Never moves real SOL: the deposit-transaction checks build and validate a signed transfer LOCALLY (made-up
// blockhash, never sent), and the server only ever sees it on a paper agent, where relaying is refused.

import { createPrivateKey, sign as edSign } from "node:crypto";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction, type TransactionInstruction } from "@solana/web3.js";
import bs58 from "bs58";
import seedFile from "../src/data/fomo-seed.json";
import type {
  AgentDetailDTO,
  AgentDTO,
  ApiError,
  AppConfigDTO,
  CommandDTO,
  CreateAgentInput,
  CreateAgentResult,
  FeedDTO,
  FloorDTO,
  IndexerStatusDTO,
  LeaderboardDTO,
  MyAgentsDTO,
  SessionDTO,
  SignInChallengeDTO,
  TraderDetailDTO,
  TraderLookupDTO,
  WalletBalanceDTO,
} from "../src/lib/types";

const BASE_URL = (process.env.BASE_URL ?? "http://localhost:3001").replace(/\/+$/, "");
const ORIGIN = new URL(BASE_URL).origin;
const SEED_WALLET = (seedFile as { wallets: { wallet: string; exclude?: boolean }[] }).wallets.find((w) => !w.exclude)?.wallet;
const TRADER_WALLET = process.env.SMOKE_TRADER_WALLET ?? SEED_WALLET ?? "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const TRADER_IS_SEED = TRADER_WALLET === SEED_WALLET;
const COMMAND_TIMEOUT_MS = Number(process.env.SMOKE_COMMAND_TIMEOUT_MS ?? 30_000);
/** Labels a client tries to put on a wallet; the server must ignore them. */
const SPOOF_HANDLE = "smoke_spoofed_handle";
const SPOOF_NAME = "Smoke Spoofed Name";
const LOOKUP_NOTES: readonly (TraderLookupDTO["note"])[] = [null, "unknown_handle", "no_fomo_activity", "check_unavailable"];
/** FOMO's gas relayer: infrastructure, never followable (finding F13). */
const FOMO_RELAYER = "AgmLJBMDCqWynYnQiPCuj9ewsNNsBJXyzoUhD9LJzN51";

// ── Test wallets (fresh keypairs, never funded) ─────────────────────────────────────────────────────

interface TestWallet {
  address: string;
  keypair: Keypair;
  /** "name=value" session cookie after sign-in. */
  cookie: string | null;
  lastSignIn: { wallet: string; message: string; signature: string } | null;
}

function testWallet(): TestWallet {
  const keypair = Keypair.generate();
  return { address: keypair.publicKey.toBase58(), keypair, cookie: null, lastSignIn: null };
}

const OWNER = testWallet();
const STRANGER = testWallet();
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

/** What a wallet's signMessage returns: ed25519 over the UTF-8 bytes, base58. */
function signMessage(w: TestWallet, message: string): string {
  const key = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(w.keypair.secretKey.subarray(0, 32))]), format: "der", type: "pkcs8" });
  return bs58.encode(edSign(null, Buffer.from(message, "utf8"), key));
}

async function signIn(w: TestWallet): Promise<void> {
  const ch = await call<SignInChallengeDTO>("POST", "/api/auth/nonce", { body: { wallet: w.address } });
  expectStatus(ch, 200);
  check(typeof ch.body.message === "string" && ch.body.message.includes(w.address) && ch.body.message.includes(ch.body.nonce), "bad challenge", ch);
  const body = { wallet: w.address, message: ch.body.message, signature: signMessage(w, ch.body.message) };
  const res = await call<SessionDTO>("POST", "/api/auth/verify", { body });
  expectStatus(res, 200);
  check(res.body.wallet === w.address, "verify should return the wallet", res);
  const setCookie = res.headers.get("set-cookie") ?? "";
  check(/HttpOnly/i.test(setCookie) && /SameSite=Lax/i.test(setCookie), `session cookie must be HttpOnly + SameSite=Lax: "${setCookie}"`, res);
  w.cookie = setCookie.split(";")[0] ?? null;
  w.lastSignIn = body;
}

// ── HTTP ────────────────────────────────────────────────────────────────────────────────────────────

interface Res<T> {
  status: number;
  body: T;
  text: string;
  headers: Headers;
}

async function call<T>(
  method: "GET" | "POST" | "PATCH",
  path: string,
  opts: { body?: unknown; session?: TestWallet; origin?: string } = {},
): Promise<Res<T>> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (opts.session?.cookie) headers.cookie = opts.session.cookie;
  // Browsers send Origin on every non-GET fetch; the server checks it (CSRF).
  if (method !== "GET") headers.origin = opts.origin ?? ORIGIN;
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  const out: Res<T> = { status: res.status, body: body as T, text, headers: res.headers };
  // No response may ever carry the Helius key or a keyed RPC URL.
  if (SECRET_RE.test(text)) throw new CheckFailed(`${method} ${path}: response looks like it leaks a secret`, { ...out, text: "(redacted)" });
  return out;
}

const SECRET_RE = /api[-_]?key|helius-rpc\.com|HELIUS_API_KEY|WALLET_SEAL_PRIVATE_KEY|SESSION_SECRET/i;

// ── Reporting ───────────────────────────────────────────────────────────────────────────────────────

class CheckFailed extends Error {
  constructor(
    message: string,
    readonly res?: Res<unknown>,
  ) {
    super(message);
  }
}

class Skipped extends Error {}

function check(cond: unknown, message: string, res?: Res<unknown>): asserts cond {
  if (!cond) throw new CheckFailed(message, res);
}

function expectStatus<T>(res: Res<T>, status: number): void {
  check(res.status === status, `expected HTTP ${status}, got ${res.status}`, res);
}

function fieldError(res: Res<unknown>, field: string): string | undefined {
  const body = res.body as Partial<ApiError> | null;
  return body?.fields?.[field];
}

function near(a: number, b: number, eps = 1e-6): boolean {
  return Math.abs(a - b) <= eps;
}

const counts = { pass: 0, fail: 0, skip: 0 };

async function step(name: string, fn: () => Promise<string | void>): Promise<boolean> {
  try {
    const note = await fn();
    counts.pass++;
    console.log(`PASS  ${name}${note ? `  (${note})` : ""}`);
    return true;
  } catch (err) {
    if (err instanceof Skipped) {
      counts.skip++;
      console.log(`SKIP  ${name}  (${err.message})`);
      return true;
    }
    counts.fail++;
    console.log(`FAIL  ${name}: ${err instanceof Error ? err.message : String(err)}`);
    if (err instanceof CheckFailed && err.res) {
      const text = err.res.text.length > 2000 ? `${err.res.text.slice(0, 2000)}…` : err.res.text;
      console.log(`      HTTP ${err.res.status} ${text}`);
    }
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Scenario ────────────────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`copyfomo API smoke test → ${BASE_URL}`);
  console.log(`trader ${TRADER_WALLET} · test wallet ${OWNER.address}\n`);

  // Filled by steps; a property bag so TS doesn't narrow closure-assigned locals to `null`.
  const state: { config?: AppConfigDTO; created?: CreateAgentResult; withdraw?: CommandDTO; close?: CommandDTO } = {};
  await step("GET /api/config", async () => {
    const res = await call<AppConfigDTO>("GET", "/api/config");
    expectStatus(res, 200);
    check(typeof res.body.minDepositSol === "number" && typeof res.body.workerOnline === "boolean", "bad AppConfigDTO", res);
    check(res.body.mode === "paper", `server is in "${res.body.mode}" mode — this smoke test only runs against paper mode`, res);
    check(typeof res.body.onchainRanking === "boolean", "expected onchainRanking: boolean", res);
    check(res.body.copyVenue === "fomo" || res.body.copyVenue === "all", "expected copyVenue fomo | all", res);
    check(typeof res.body.platformFeeBps === "number", "expected platformFeeBps: number", res);
    check(!("fomoConfigured" in res.body), "stale field fomoConfigured still present", res);
    state.config = res.body;
    return `mode=${res.body.mode} worker=${res.body.workerOnline ? "online" : "offline"} onchain=${res.body.onchainRanking} venue=${res.body.copyVenue} fee=${res.body.platformFeeBps}bps`;
  });
  const config = state.config;
  if (!config) return;

  // Public reads: leaderboard (DB only, CDN-cacheable)
  await step("GET /api/traders?window=24h&limit=5", async () => {
    const res = await call<LeaderboardDTO>("GET", "/api/traders?window=24h&limit=5");
    expectStatus(res, 200);
    const b = res.body;
    check(Array.isArray(b.traders) && b.traders.length <= 5, "expected ≤ 5 traders", res);
    check(b.source === "onchain" || b.source === "seed", "bad source (onchain | seed)", res);
    check(b.window === "24h" && typeof b.stale === "boolean" && typeof b.capturedAt === "string", "bad LeaderboardDTO header", res);
    check(typeof b.universe?.tracked === "number" && typeof b.universe?.ranked === "number", "bad universe", res);
    check(typeof b.rules?.minTrades === "number" && typeof b.rules?.minVolumeUsd === "number", "bad rules", res);
    for (const t of b.traders) {
      check(typeof t.wallet === "string" && t.wallet.length >= 32, "every row needs a wallet (no demo rows)", res);
      check(t.avatarUrl === null, "avatarUrl must be null (no hotlinked images)", res);
      check(!("followers" in t), "stale field followers still present", res);
      check(t.source === "fomo" || t.source === "custom", `bad trader source "${t.source}"`, res);
    }
    const cc = res.headers.get("cache-control") ?? "";
    check(/public/.test(cc) && /s-maxage=60/.test(cc) && /stale-while-revalidate=300/.test(cc), `bad cache-control "${cc}"`, res);
    return `source=${b.source} traders=${b.traders.length} tracked=${b.universe.tracked} ranked=${b.universe.ranked}`;
  });
  await step("GET /api/traders?window=all → 30d", async () => {
    const res = await call<LeaderboardDTO>("GET", "/api/traders?window=all&limit=3");
    expectStatus(res, 200);
    check(res.body.window === "30d", `expected window 30d, got ${res.body.window}`, res);
  });
  await step("GET /api/traders?window=1y → 400", async () => {
    const res = await call("GET", "/api/traders?window=1y");
    expectStatus(res, 400);
    check(fieldError(res, "window"), "expected fields.window", res);
  });

  // Lookup (handles only resolve from our own labels; wallets we know need no Helius call)
  await step("GET /api/traders/lookup?q=<wallet>", async () => {
    const res = await call<TraderLookupDTO>("GET", `/api/traders/lookup?q=${TRADER_WALLET}`);
    expectStatus(res, 200);
    check(res.body.trader?.wallet === TRADER_WALLET, "expected the wallet back", res);
    check(LOOKUP_NOTES.includes(res.body.note), `bad note "${String(res.body.note)}"`, res);
    if (TRADER_IS_SEED) {
      check(res.body.note === null, "a seed wallet is known: expected note null", res);
      check(res.body.trader.source === "fomo", "a seed wallet should be source fomo", res);
    }
    return `source=${res.body.trader.source} note=${res.body.note} name=${res.body.trader.displayName ?? res.body.trader.handle ?? "-"}`;
  });
  await step("GET /api/traders/lookup?q=<garbage> → unknown_handle", async () => {
    const res = await call<TraderLookupDTO>("GET", `/api/traders/lookup?q=${encodeURIComponent("not a wallet!")}`);
    expectStatus(res, 200);
    check(res.body.trader === null && res.body.note === "unknown_handle", "expected { trader: null, note: unknown_handle }", res);
  });
  await step("GET /api/traders/lookup?q=@<unknown handle> → unknown_handle", async () => {
    const res = await call<TraderLookupDTO>("GET", `/api/traders/lookup?q=${encodeURIComponent("@zz_smoke_no_such_handle")}`);
    expectStatus(res, 200);
    check(res.body.trader === null && res.body.note === "unknown_handle", "expected { trader: null, note: unknown_handle }", res);
  });

  // Trader profile + indexer status
  await step("GET /api/traders/[wallet]", async () => {
    const res = await call<TraderDetailDTO>("GET", `/api/traders/${TRADER_WALLET}`);
    if (res.status === 404 && !TRADER_IS_SEED) throw new Skipped("custom wallet not known to the indexer");
    expectStatus(res, 200);
    const d = res.body;
    check(d.trader?.wallet === TRADER_WALLET, "expected the wallet back", res);
    check(Array.isArray(d.stats) && Array.isArray(d.perMint) && Array.isArray(d.positions) && Array.isArray(d.recent), "bad TraderDetailDTO", res);
    check(d.recent.length <= 50, "recent is capped at 50", res);
    check(d.stats.every((s) => s.window === "24h" || s.window === "7d" || s.window === "30d"), "bad stats window", res);
    return `windows=${d.stats.map((s) => s.window).join(",") || "none"} recent=${d.recent.length} positions=${d.positions.length}`;
  });
  await step("GET /api/traders/[wallet]?view=summary (light poll)", async () => {
    const res = await call<TraderDetailDTO>("GET", `/api/traders/${TRADER_WALLET}?view=summary`);
    if (res.status === 404 && !TRADER_IS_SEED) throw new Skipped("custom wallet not known to the indexer");
    expectStatus(res, 200);
    check(res.body.trader?.wallet === TRADER_WALLET && Array.isArray(res.body.stats), "bad summary", res);
    check(res.body.recent.length === 0 && res.body.perMint.length === 0 && res.body.positions.length === 0, "summary must drop the heavy lists", res);
  });
  await step("GET /api/traders/<not a wallet> → 404", async () => {
    expectStatus(await call("GET", "/api/traders/not-a-wallet"), 404);
  });
  await step("GET /api/traders/<unknown wallet> → 404", async () => {
    expectStatus(await call("GET", `/api/traders/${Keypair.generate().publicKey.toBase58()}`), 404);
  });
  await step("GET /api/indexer", async () => {
    const res = await call<IndexerStatusDTO>("GET", "/api/indexer");
    expectStatus(res, 200);
    const s = res.body;
    check(typeof s.enabled === "boolean" && ["stream", "logs", "off"].includes(s.mode), "bad IndexerStatusDTO", res);
    check(typeof s.tracked === "number" && typeof s.candidates === "number", "bad counts", res);
    check(typeof s.creditsTodayPct === "number" && Number.isInteger(s.creditsTodayPct), "creditsTodayPct must be a rounded %", res);
    check(typeof s.throttled === "boolean", "bad throttled", res);
    return `enabled=${s.enabled} mode=${s.mode} connected=${s.connected} tracked=${s.tracked} credits=${s.creditsTodayPct}%${s.driftWarning ? ` drift="${s.driftWarning}"` : ""}`;
  });
  await step("GET /api/floor?limit=5", async () => {
    const res = await call<FloorDTO>("GET", "/api/floor?limit=5");
    expectStatus(res, 200);
    check(Array.isArray(res.body.agents) && typeof res.body.stats?.agents === "number", "bad FloorDTO", res);
    return `demo=${res.body.demo} agents=${res.body.agents.length}`;
  });
  await step("GET /api/feed?limit=5", async () => {
    const res = await call<FeedDTO>("GET", "/api/feed?limit=5");
    expectStatus(res, 200);
    check(Array.isArray(res.body.items) && typeof res.body.demo === "boolean", "bad FeedDTO", res);
    return `demo=${res.body.demo} items=${res.body.items.length}`;
  });

  // Wallet sign-in (SIWS-style): the test wallet is a fresh keypair; nobody's real wallet.
  await step("POST /api/agents without a session → 401", async () => {
    const res = await call("POST", "/api/agents", { body: { traders: [{ wallet: TRADER_WALLET }], sizingMode: "fixed", fixedSol: 0.05, depositSol: 1 } });
    expectStatus(res, 401);
  });
  await step("sign in: POST /api/auth/nonce → POST /api/auth/verify", async () => {
    await signIn(OWNER);
    const me = await call<SessionDTO>("GET", "/api/auth/me", { session: OWNER });
    expectStatus(me, 200);
    check(me.body.wallet === OWNER.address, "GET /api/auth/me should return the signed-in wallet", me);
    return `wallet=${OWNER.address}`;
  });
  await step("sign in with a replayed signature → 401", async () => {
    const res = await call<SessionDTO>("POST", "/api/auth/verify", { body: OWNER.lastSignIn });
    expectStatus(res, 401);
  });
  await step("sign in with a wrong signature → 401", async () => {
    const ch = await call<SignInChallengeDTO>("POST", "/api/auth/nonce", { body: { wallet: STRANGER.address } });
    expectStatus(ch, 200);
    const res = await call("POST", "/api/auth/verify", {
      body: { wallet: STRANGER.address, message: ch.body.message, signature: signMessage(OWNER, ch.body.message) },
    });
    expectStatus(res, 401);
  });
  await step("second wallet signs in (for ownership checks)", async () => {
    await signIn(STRANGER);
  });

  // Create: validation first (validation failures don't count against the create rate limit)
  const base: CreateAgentInput = {
    name: "smoke.test",
    // Client labels are ignored by the server (it copies labels from its own data): these must not stick.
    traders: [{ wallet: TRADER_WALLET, handle: SPOOF_HANDLE, displayName: SPOOF_NAME, avatarUrl: "https://example.com/x.png" }],
    sizingMode: "fixed",
    fixedSol: 0.05,
    maxPerTradeSol: 0.1,
    slippageBps: 300,
    copySells: true,
    depositSol: 1,
  };
  await step("POST /api/agents cross-site → 403", async () => {
    expectStatus(await call("POST", "/api/agents", { session: OWNER, origin: "https://evil.example", body: base }), 403);
  });
  await step("POST /api/agents duplicate trader → 400", async () => {
    const res = await call("POST", "/api/agents", { session: OWNER, body: { ...base, traders: [base.traders[0], base.traders[0]] } });
    expectStatus(res, 400);
    check(fieldError(res, "traders.1.wallet"), "expected fields['traders.1.wallet']", res);
  });
  await step("POST /api/agents following FOMO's relayer → 400 (F13)", async () => {
    const res = await call("POST", "/api/agents", { session: OWNER, body: { ...base, traders: [{ wallet: FOMO_RELAYER }] } });
    expectStatus(res, 400);
    check(/relayer/.test(fieldError(res, "traders.0.wallet") ?? ""), "expected fields['traders.0.wallet'] naming the relayer", res);
  });
  await step("POST /api/agents with a payout field → 400 (withdrawals go to the signed-in wallet)", async () => {
    const res = await call("POST", "/api/agents", { session: OWNER, body: { ...base, payoutAddress: STRANGER.address } });
    expectStatus(res, 400);
  });
  await step("POST /api/agents depositSol below the minimum → 400", async () => {
    const res = await call("POST", "/api/agents", { session: OWNER, body: { ...base, depositSol: config.minDepositSol / 10 } });
    expectStatus(res, 400);
    check(fieldError(res, "depositSol"), "expected fields.depositSol", res);
  });
  await step("chunked 1 MB body → 413 without buffering it (F28)", async () => {
    const status = await chunkedPost("/api/auth/nonce", 1024 * 1024);
    check(status === 413, `expected HTTP 413, got ${status}`);
  });
  await step("POST /api/agents trader without a wallet → 400", async () => {
    const res = await call("POST", "/api/agents", { session: OWNER, body: { ...base, traders: [{ wallet: null, handle: "demo_nightowl" }] } });
    expectStatus(res, 400);
    check(fieldError(res, "traders.0.wallet"), "expected fields['traders.0.wallet']", res);
  });

  await step("POST /api/agents → 201 (paper: simulated deposit credited at once)", async () => {
    const res = await call<CreateAgentResult>("POST", "/api/agents", { session: OWNER, body: base });
    if (res.status === 429) throw new CheckFailed("rate limited — wait and rerun", res);
    expectStatus(res, 201);
    const { agent, deposit } = res.body;
    check(deposit === null, "paper mode returns no deposit transaction", res);
    check(!("ownerKey" in res.body), "no owner key any more", res);
    check(agent.mode === "paper" && agent.isOwner === true, "expected a paper agent owned by the caller", res);
    check(agent.ownerWallet === OWNER.address && agent.payoutAddress === OWNER.address, "the signed-in wallet owns it and is the payout", res);
    check(near(agent.balanceSol, 1), `expected 1 simulated SOL, got ${agent.balanceSol}`, res);
    const expected = 1 >= config.minDepositSol ? "active" : "awaiting_deposit";
    check(agent.status === expected, `expected status ${expected}`, res);
    check(agent.name === "smoke.test" && agent.slug.startsWith("smoke.test-"), "unexpected name/slug", res);
    check(agent.traders[0]?.wallet === TRADER_WALLET, "trader not followed", res);
    const followed = agent.traders[0];
    check(followed.handle !== SPOOF_HANDLE && followed.displayName !== SPOOF_NAME, "client-supplied trader labels were stored", res);
    check(followed.avatarUrl === null, "client-supplied avatar was stored", res);
    check(agent.sizingMode === "fixed" && near(agent.fixedSol, 0.05), "rules not applied", res);
    check(agent.feesPaidSol === 0 && agent.feeOwedSol === 0, "a new agent owes no fees", res);
    state.created = res.body;
    return `id=${agent.id} slug=${agent.slug} status=${agent.status}`;
  });
  if (!state.created) {
    console.log("\nCannot continue without an agent.");
    return;
  }
  const { agent: fresh } = state.created;
  const path = (rest = "") => `/api/agents/${encodeURIComponent(fresh.id)}${rest}`;

  // Reads & ownership
  await step("GET /api/agents/[id] (public): no owner-only fields", async () => {
    const res = await call<AgentDetailDTO>("GET", path());
    expectStatus(res, 200);
    const a = res.body.agent;
    check(a.id === fresh.id && Array.isArray(res.body.positions) && Array.isArray(res.body.trades), "bad AgentDetailDTO", res);
    check(!("ownerKeyHash" in a) && !("sealedSecret" in a), "secret fields leaked", res);
    check(a.isOwner === false && !("ownerWallet" in a) && !("payoutAddress" in a), "owner-only fields leaked to the public", res);
    check(!res.text.includes(OWNER.address), "the owner's wallet appears in the public response", res);
  });
  await step("GET /api/agents/[slug] (owner session): owner fields", async () => {
    const res = await call<AgentDetailDTO>("GET", `/api/agents/${encodeURIComponent(fresh.slug)}`, { session: OWNER });
    expectStatus(res, 200);
    check(res.body.agent.id === fresh.id, "slug resolved to a different agent", res);
    check(res.body.agent.isOwner === true && res.body.agent.ownerWallet === OWNER.address, "owner view expected", res);
  });
  await step("GET /api/agents/[unknown] → 404", async () => {
    expectStatus(await call("GET", "/api/agents/no-such-agent-xyz"), 404);
  });
  await step("GET /api/me/agents lists the agent", async () => {
    const res = await call<MyAgentsDTO>("GET", "/api/me/agents", { session: OWNER });
    expectStatus(res, 200);
    check(res.body.agents.some((a) => a.id === fresh.id), "agent missing from /api/me/agents", res);
    const other = await call<MyAgentsDTO>("GET", "/api/me/agents", { session: STRANGER });
    expectStatus(other, 200);
    check(!other.body.agents.some((a) => a.id === fresh.id), "another wallet sees this agent as its own", other);
  });
  await step("GET /api/me/balance", async () => {
    const res = await call<WalletBalanceDTO>("GET", "/api/me/balance", { session: OWNER });
    if (res.status === 503 || res.status === 502) throw new Skipped(`balance unavailable (HTTP ${res.status})`);
    expectStatus(res, 200);
    check(typeof res.body.sol === "number" && res.body.sol >= 0, "expected { sol: number }", res);
    expectStatus(await call("GET", "/api/me/balance"), 401);
  });

  // Owner-only writes
  await step("PATCH as another wallet → 403", async () => {
    expectStatus(await call("PATCH", path(), { session: STRANGER, body: { status: "paused" } }), 403);
  });
  await step("PATCH without a session → 401", async () => {
    expectStatus(await call("PATCH", path(), { body: { status: "paused" } }), 401);
  });
  await step("PATCH cross-site (owner cookie, evil origin) → 403", async () => {
    expectStatus(await call("PATCH", path(), { session: OWNER, origin: "https://evil.example", body: { status: "paused" } }), 403);
  });
  await step("POST paper-deposit 0 → 400", async () => {
    const res = await call("POST", path("/paper-deposit"), { session: OWNER, body: { amountSol: 0 } });
    expectStatus(res, 400);
    check(fieldError(res, "amountSol"), "expected fields.amountSol", res);
  });
  await step("POST paper-deposit 0.5 SOL (top-up)", async () => {
    const res = await call<{ agent: AgentDTO }>("POST", path("/paper-deposit"), { session: OWNER, body: { amountSol: 0.5 } });
    expectStatus(res, 200);
    check(near(res.body.agent.balanceSol, 1.5), `expected balance 1.5, got ${res.body.agent?.balanceSol}`, res);
    return `status=${res.body.agent.status}`;
  });
  await step("POST deposit-tx on a paper agent → 400", async () => {
    expectStatus(await call("POST", path("/deposit-tx"), { session: OWNER, body: { amountSol: 0.5 } }), 400);
  });
  await step("POST deposit-submit (signed transfer) on a paper agent → 400, never relayed", async () => {
    const tx = signedTransfer(OWNER, new PublicKey(fresh.depositAddress), 500_000_000);
    const res = await call("POST", path("/deposit-submit"), { session: OWNER, body: { txBase64: tx, amountSol: 0.5 } });
    expectStatus(res, 400);
  });
  await step("POST deposit-submit as another wallet → 403", async () => {
    const tx = signedTransfer(STRANGER, new PublicKey(fresh.depositAddress), 500_000_000);
    expectStatus(await call("POST", path("/deposit-submit"), { session: STRANGER, body: { txBase64: tx, amountSol: 0.5 } }), 403);
  });
  await step("tampered deposit transfers fail validation (local build + validate only)", () => tamperedDepositChecks());
  await step("PATCH status=paused", async () => {
    const res = await call<{ agent: AgentDTO }>("PATCH", path(), { session: OWNER, body: { status: "paused" } });
    expectStatus(res, 200);
    check(res.body.agent.status === "paused", "expected paused", res);
  });
  await step("PATCH status=active (resume)", async () => {
    const res = await call<{ agent: AgentDTO }>("PATCH", path(), { session: OWNER, body: { status: "active" } });
    expectStatus(res, 200);
    check(res.body.agent.status === "active", "expected active", res);
  });
  await step("PATCH rules", async () => {
    const res = await call<{ agent: AgentDTO }>("PATCH", path(), {
      session: OWNER,
      body: { sizingMode: "mirror", maxPerTradeSol: 0.2, slippageBps: 500, copySells: false },
    });
    expectStatus(res, 200);
    const a = res.body.agent;
    check(a.sizingMode === "mirror" && near(a.maxPerTradeSol, 0.2) && a.slippageBps === 500 && a.copySells === false, "rules not saved", res);
  });
  await step("PATCH slippageBps=5 → 400", async () => {
    const res = await call("PATCH", path(), { session: OWNER, body: { slippageBps: 5 } });
    expectStatus(res, 400);
    check(fieldError(res, "slippageBps"), "expected fields.slippageBps", res);
  });

  // Withdraw (always to the signed-in wallet)
  await step("POST withdraw 1000 SOL → 400", async () => {
    const res = await call("POST", path("/withdraw"), { session: OWNER, body: { amountSol: 1000 } });
    expectStatus(res, 400);
    check(fieldError(res, "amountSol"), "expected fields.amountSol", res);
  });
  await step("POST withdraw as another wallet → 403", async () => {
    expectStatus(await call("POST", path("/withdraw"), { session: STRANGER, body: { amountSol: 0.1 } }), 403);
  });
  await step("POST withdraw 0.1 SOL → 202", async () => {
    const res = await call<{ command: CommandDTO }>("POST", path("/withdraw"), { session: OWNER, body: { amountSol: 0.1 } });
    expectStatus(res, 202);
    check(res.body.command?.type === "withdraw" && res.body.command.status === "pending", "expected a pending withdraw command", res);
    state.withdraw = res.body.command;
    return `command=${res.body.command.id}`;
  });
  await step("POST second withdraw while one is open → 409 naming the open command", async () => {
    const res = await call<{ command: CommandDTO }>("POST", path("/withdraw"), { session: OWNER, body: { amountSol: 0.1 } });
    if (res.status === 202) throw new Skipped("the worker finished the first withdrawal already; a second one was queued");
    expectStatus(res, 409);
    check(res.body.command?.id === state.withdraw?.id, "the 409 should carry the open command", res);
  });
  await step("GET /api/agents/[id]/commands?type=withdraw (owner) lists it; other wallet → 403", async () => {
    const res = await call<{ commands: CommandDTO[] }>("GET", path("/commands?type=withdraw"), { session: OWNER });
    expectStatus(res, 200);
    check(res.body.commands.some((c) => c.id === state.withdraw?.id), "withdraw command missing from the list", res);
    check(res.body.commands.every((c) => c.type === "withdraw"), "type filter ignored", res);
    expectStatus(await call("GET", path("/commands"), { session: STRANGER }), 403);
    expectStatus(await call("GET", path("/commands")), 401);
  });
  await step("POST withdraw amount + closePositions while holding positions → 400 (F37)", async () => {
    const detail = await call<AgentDetailDTO>("GET", path(), { session: OWNER });
    if (detail.body.positions.length === 0) throw new Skipped("the agent holds no positions yet");
    const res = await call("POST", path("/withdraw"), { session: OWNER, body: { amountSol: 0.01, closePositions: true } });
    expectStatus(res, 400);
  });
  const withdrawCmd = state.withdraw;
  if (withdrawCmd) {
    const cmd = withdrawCmd;
    await step("GET withdraw command until done", () => pollCommand(path, cmd.id, config.workerOnline));
    await step("balance after withdraw", async () => {
      const res = await call<AgentDetailDTO>("GET", path(), { session: OWNER });
      expectStatus(res, 200);
      const cmdRes = await call<{ command: CommandDTO }>("GET", path(`/commands/${cmd.id}`), { session: OWNER });
      if (cmdRes.body.command?.status !== "done") throw new Skipped("withdrawal not done yet");
      check(near(res.body.agent.balanceSol, 1.4, 1e-4), `expected ≈ 1.4 SOL left, got ${res.body.agent.balanceSol}`, res);
      return `balance=${res.body.agent.balanceSol}`;
    });
  }
  await step("GET /commands/[unknown] → 404", async () => {
    expectStatus(await call("GET", path("/commands/does-not-exist"), { session: OWNER }), 404);
  });

  // Close all
  await step("POST close-all → 202", async () => {
    const res = await call<{ command: CommandDTO }>("POST", path("/close-all"), { session: OWNER });
    expectStatus(res, 202);
    check(res.body.command?.type === "close_all", "expected a close_all command", res);
    state.close = res.body.command;
    return `command=${res.body.command.id}`;
  });
  const closeCmd = state.close;
  if (closeCmd) {
    const cmd = closeCmd;
    await step("GET close-all command until done", () => pollCommand(path, cmd.id, config.workerOnline));
  }

  // Cleanup: pause so the worker stops watching the trader for this test agent; then sign out.
  await step("PATCH status=paused (cleanup)", async () => {
    const res = await call<{ agent: AgentDTO }>("PATCH", path(), { session: OWNER, body: { status: "paused" } });
    expectStatus(res, 200);
    check(res.body.agent.status === "paused", "expected paused", res);
  });
  await step("POST /api/auth/logout", async () => {
    const res = await call("POST", "/api/auth/logout", { session: OWNER });
    check(res.status === 200 || res.status === 204, `expected 200/204, got ${res.status}`, res);
    const cookie = res.headers.get("set-cookie") ?? "";
    check(/Max-Age=0/i.test(cookie), "logout must clear the session cookie", res);
  });
}

// ── Deposit transaction helpers (local only: made-up blockhash, never sent anywhere) ─────────────────

const FAKE_BLOCKHASH = "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N";

function signedTx(w: TestWallet, instructions: TransactionInstruction[], sign = true): string {
  const msg = new TransactionMessage({ payerKey: w.keypair.publicKey, recentBlockhash: FAKE_BLOCKHASH, instructions }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  if (sign) tx.sign([w.keypair]);
  return Buffer.from(tx.serialize()).toString("base64");
}

function signedTransfer(w: TestWallet, to: PublicKey, lamports: number): string {
  return signedTx(w, [SystemProgram.transfer({ fromPubkey: w.keypair.publicKey, toPubkey: to, lamports })]);
}

/** lib/deposit.validateSignedDeposit in-process (inert env first, so no real keys or RPC URLs are loaded). */
async function tamperedDepositChecks(): Promise<string> {
  await import("../src/lib/__testing__/env");
  const { validateSignedDeposit } = await import("../src/lib/deposit");
  const agentWallet = Keypair.generate().publicKey;
  const attacker = Keypair.generate().publicKey;
  const lamports = 500_000_000;
  const expected = { from: OWNER.address, to: agentWallet.toBase58(), lamports };
  const transfer = (to: PublicKey, n: number) => SystemProgram.transfer({ fromPubkey: OWNER.keypair.publicKey, toPubkey: to, lamports: n });

  validateSignedDeposit(signedTransfer(OWNER, agentWallet, lamports), expected); // the exact transfer passes
  const cases: [string, string][] = [
    ["recipient swapped", signedTransfer(OWNER, attacker, lamports)],
    ["amount changed", signedTransfer(OWNER, agentWallet, lamports * 2)],
    ["second transfer appended", signedTx(OWNER, [transfer(agentWallet, lamports), transfer(attacker, 1)])],
    ["unsigned", signedTx(OWNER, [transfer(agentWallet, lamports)], false)],
    ["signed by another wallet", signedTransfer(STRANGER, agentWallet, lamports)],
  ];
  for (const [name, tx] of cases) {
    let status: number | null = null;
    try {
      validateSignedDeposit(tx, expected);
    } catch (err) {
      status = (err as { status?: number }).status ?? -1;
    }
    check(status === 400, `${name}: expected a 400 rejection, got ${status === null ? "accepted" : status}`);
  }
  return `${cases.length} tampered variants rejected`;
}

/** POST a chunked body of `bytes` (no content-length) and return the HTTP status the server answered with. */
function chunkedPost(path: string, bytes: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const url = new URL(`${BASE_URL}${path}`);
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    const req = send(
      url,
      { method: "POST", headers: { "content-type": "application/json", "transfer-encoding": "chunked", origin: ORIGIN } },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on("error", reject); // after a response it is a no-op (the server may close while we still write)
    const chunk = Buffer.alloc(16 * 1024, 0x20);
    let sent = 0;
    const pump = (): void => {
      while (sent < bytes) {
        sent += chunk.length;
        if (!req.write(chunk)) {
          req.once("drain", pump);
          return;
        }
      }
      req.end();
    };
    pump();
  });
}

/** Poll a command until done (PASS) / failed (FAIL). With the worker offline, only check it's readable. */
async function pollCommand(path: (rest?: string) => string, id: string, workerOnline: boolean): Promise<string> {
  const deadline = Date.now() + COMMAND_TIMEOUT_MS;
  for (;;) {
    const res = await call<{ command: CommandDTO }>("GET", path(`/commands/${encodeURIComponent(id)}`), { session: OWNER });
    expectStatus(res, 200);
    const c = res.body.command;
    check(c?.id === id, "wrong command returned", res);
    if (c.status === "done") return `done: ${c.result ?? ""}`;
    check(c.status !== "failed", `command failed: ${c.result ?? "(no result)"}`, res);
    if (!workerOnline) throw new Skipped(`still ${c.status} — worker offline, start it with npm run worker`);
    if (Date.now() > deadline) throw new CheckFailed(`still ${c.status} after ${COMMAND_TIMEOUT_MS}ms`, res);
    await sleep(1000);
  }
}

main()
  .catch((err: unknown) => {
    counts.fail++;
    console.log(`FAIL  unexpected error: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  })
  .finally(() => {
    console.log(`\n${counts.pass} passed · ${counts.fail} failed · ${counts.skip} skipped`);
    process.exitCode = counts.fail > 0 ? 1 : 0;
  });
