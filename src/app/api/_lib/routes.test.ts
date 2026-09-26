// Run: npx tsx --test src/app/api/_lib/routes.test.ts
// The API route handlers end to end (paper server): wallet sign-in, create with one-click paper funding, owner
// checks, CSRF, trader denylist (F13), live step-up (F18), tampered deposit (never relayed), withdraw rules (F37)
// and command history (F39). Throwaway SQLite DB; no network (RPC URLs point at a closed local port).
import "../../../lib/__testing__/env"; // first: keeps the real .env (keys, RPC URLs) out of this test
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createPrivateKey, generateKeyPairSync, randomBytes, sign as edSign } from "node:crypto";
import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { NextRequest } from "next/server";
import { createTestDatabase } from "../../../lib/__testing__/db";
import type { AgentDetailDTO, AgentDTO, CommandDTO, CreateAgentResult, MyAgentsDTO, SessionDTO, SignInChallengeDTO } from "@/lib/types";

const testDb = createTestDatabase();
process.env.SESSION_SECRET = randomBytes(32).toString("base64url");
{
  const { publicKey } = generateKeyPairSync("x25519");
  const der = publicKey.export({ format: "der", type: "spki" });
  process.env.WALLET_SEAL_PUBLIC_KEY = Buffer.from(der.subarray(der.length - 32)).toString("base64");
}
process.env.COPYFOMO_MODE = "paper";
process.env.MIN_DEPOSIT_SOL = "0.05";
process.env.TRUSTED_IP_SOURCE = "x-real-ip";

const HOST = "localhost:3001";
const ORIGIN = `http://${HOST}`;
const RELAYER = "AgmLJBMDCqWynYnQiPCuj9ewsNNsBJXyzoUhD9LJzN51";

// Route modules (imported after the env is set).
let routes: {
  nonce: typeof import("../auth/nonce/route");
  verify: typeof import("../auth/verify/route");
  logout: typeof import("../auth/logout/route");
  me: typeof import("../auth/me/route");
  myAgents: typeof import("../me/agents/route");
  agents: typeof import("../agents/route");
  agent: typeof import("../agents/[id]/route");
  paper: typeof import("../agents/[id]/paper-deposit/route");
  depositTx: typeof import("../agents/[id]/deposit-tx/route");
  depositSubmit: typeof import("../agents/[id]/deposit-submit/route");
  withdraw: typeof import("../agents/[id]/withdraw/route");
  closeAll: typeof import("../agents/[id]/close-all/route");
  commands: typeof import("../agents/[id]/commands/route");
};
let prisma: typeof import("@/lib/db").prisma;
let seedWallet: string;
let seedWallet2: string;

before(async () => {
  routes = {
    nonce: await import("../auth/nonce/route"),
    verify: await import("../auth/verify/route"),
    logout: await import("../auth/logout/route"),
    me: await import("../auth/me/route"),
    myAgents: await import("../me/agents/route"),
    agents: await import("../agents/route"),
    agent: await import("../agents/[id]/route"),
    paper: await import("../agents/[id]/paper-deposit/route"),
    depositTx: await import("../agents/[id]/deposit-tx/route"),
    depositSubmit: await import("../agents/[id]/deposit-submit/route"),
    withdraw: await import("../agents/[id]/withdraw/route"),
    closeAll: await import("../agents/[id]/close-all/route"),
    commands: await import("../agents/[id]/commands/route"),
  };
  ({ prisma } = await import("@/lib/db"));
  const { loadFomoSeed } = await import("@/lib/fomo-seed");
  const seeds = loadFomoSeed().filter((e) => !e.exclude);
  seedWallet = seeds[0]!.wallet;
  seedWallet2 = seeds[1]!.wallet;
});

after(async () => {
  await prisma?.$disconnect();
  testDb.cleanup();
});

// ── helpers ─────────────────────────────────────────────────────────────────────────────────────────

let ipCounter = 0;
/** Each request gets its own client IP so per-IP limits don't interfere between tests. */
function request(method: string, path: string, o: { body?: unknown; cookie?: string | null; origin?: string | null; headers?: Record<string, string> } = {}): NextRequest {
  const h = new Headers({ host: HOST, "x-real-ip": `10.0.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`, ...o.headers });
  if (o.body !== undefined) h.set("content-type", "application/json");
  if (o.cookie) h.set("cookie", o.cookie);
  const origin = o.origin === undefined ? (method === "GET" ? null : ORIGIN) : o.origin;
  if (origin) h.set("origin", origin);
  return new NextRequest(`${ORIGIN}${path}`, { method, headers: h, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
}
const ctx = <P extends Record<string, string>>(params: P) => ({ params: Promise.resolve(params) });
const noCtx = ctx({});

async function body<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

interface TestWallet {
  kp: Keypair;
  address: string;
  cookie: string | null;
}
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
function newWallet(): TestWallet {
  const kp = Keypair.generate();
  return { kp, address: kp.publicKey.toBase58(), cookie: null };
}
function signMessage(w: TestWallet, message: string): string {
  const key = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(w.kp.secretKey.subarray(0, 32))]), format: "der", type: "pkcs8" });
  return bs58.encode(edSign(null, Buffer.from(message, "utf8"), key));
}

async function signIn(w: TestWallet): Promise<void> {
  const ch = await routes.nonce.POST(request("POST", "/api/auth/nonce", { body: { wallet: w.address } }), noCtx);
  assert.equal(ch.status, 200);
  const { message } = await body<SignInChallengeDTO>(ch);
  const res = await routes.verify.POST(request("POST", "/api/auth/verify", { body: { wallet: w.address, message, signature: signMessage(w, message) } }), noCtx);
  assert.equal(res.status, 200);
  assert.equal((await body<SessionDTO>(res)).wallet, w.address);
  const setCookie = res.headers.get("set-cookie") ?? "";
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);
  w.cookie = setCookie.split(";")[0]!;
}

const createBody = (traders: string[], extra: Record<string, unknown> = {}) => ({
  name: "route.test",
  traders: traders.map((wallet) => ({ wallet })),
  sizingMode: "fixed",
  fixedSol: 0.05,
  maxPerTradeSol: 0.1,
  slippageBps: 300,
  depositSol: 1,
  ...extra,
});

const OWNER = newWallet();
const STRANGER = newWallet();

// ── tests ───────────────────────────────────────────────────────────────────────────────────────────

test("sign in: nonce → verify sets an HttpOnly session; replay is refused; me / logout", async () => {
  const ch = await routes.nonce.POST(request("POST", "/api/auth/nonce", { body: { wallet: OWNER.address } }), noCtx);
  const { message } = await body<SignInChallengeDTO>(ch);
  assert.ok(message.startsWith(`${HOST} wants you to sign in`));
  const signed = { wallet: OWNER.address, message, signature: signMessage(OWNER, message) };
  const ok = await routes.verify.POST(request("POST", "/api/auth/verify", { body: signed }), noCtx);
  assert.equal(ok.status, 200);
  const replay = await routes.verify.POST(request("POST", "/api/auth/verify", { body: signed }), noCtx);
  assert.equal(replay.status, 401);

  await signIn(OWNER);
  await signIn(STRANGER);
  const me = await routes.me.GET(request("GET", "/api/auth/me", { cookie: OWNER.cookie }), noCtx);
  assert.equal((await body<SessionDTO>(me)).wallet, OWNER.address);
  const anon = await routes.me.GET(request("GET", "/api/auth/me"), noCtx);
  assert.equal((await body<SessionDTO>(anon)).wallet, null);

  const out = await routes.logout.POST(request("POST", "/api/auth/logout", { cookie: OWNER.cookie }), noCtx);
  assert.equal(out.status, 200);
  assert.match(out.headers.get("set-cookie") ?? "", /Max-Age=0/);
});

test("create: session required, same-origin only, no payout field, deposit ≥ minimum", async () => {
  const noSession = await routes.agents.POST(request("POST", "/api/agents", { body: createBody([seedWallet]) }), noCtx);
  assert.equal(noSession.status, 401);
  const crossSite = await routes.agents.POST(request("POST", "/api/agents", { cookie: OWNER.cookie, origin: "https://evil.example", body: createBody([seedWallet]) }), noCtx);
  assert.equal(crossSite.status, 403);
  const payout = await routes.agents.POST(request("POST", "/api/agents", { cookie: OWNER.cookie, body: createBody([seedWallet], { payoutAddress: STRANGER.address }) }), noCtx);
  assert.equal(payout.status, 400);
  const tooSmall = await routes.agents.POST(request("POST", "/api/agents", { cookie: OWNER.cookie, body: createBody([seedWallet], { depositSol: 0.01 }) }), noCtx);
  assert.equal(tooSmall.status, 400);
  assert.ok((await body<{ fields: Record<string, string> }>(tooSmall)).fields.depositSol);
});

test("F13: create refuses FOMO's relayer as a trader (before any DB write)", async () => {
  const before = await prisma.agent.count();
  const res = await routes.agents.POST(request("POST", "/api/agents", { cookie: OWNER.cookie, body: createBody([RELAYER]) }), noCtx);
  assert.equal(res.status, 400);
  assert.match((await body<{ fields: Record<string, string> }>(res)).fields["traders.0.wallet"] ?? "", /relayer/);
  assert.equal(await prisma.agent.count(), before);
  assert.equal(await prisma.trader.count({ where: { wallet: RELAYER } }), 0);
});

let agentId = "";

test("create (paper): owned by the session wallet, payout = owner, simulated deposit credited, no transfer", async () => {
  const res = await routes.agents.POST(request("POST", "/api/agents", { cookie: OWNER.cookie, body: createBody([seedWallet]) }), noCtx);
  assert.equal(res.status, 201);
  const { agent, deposit } = await body<CreateAgentResult>(res);
  assert.equal(deposit, null);
  assert.equal(agent.isOwner, true);
  assert.equal(agent.ownerWallet, OWNER.address);
  assert.equal(agent.payoutAddress, OWNER.address);
  assert.equal(agent.balanceSol, 1);
  assert.equal(agent.status, "active");
  assert.equal(agent.feesPaidSol, 0);
  agentId = agent.id;

  const row = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
  assert.equal(row.ownerWallet, OWNER.address);
  assert.equal(row.payoutAddress, OWNER.address);
  assert.equal(row.ownerKeyHash, "");
  const deposits = await prisma.deposit.findMany({ where: { agentId } });
  assert.equal(deposits.length, 1);
  assert.ok(deposits[0]!.signature.startsWith("paper_") && deposits[0]!.status === "confirmed");
});

test("reads: public view hides the owner; owner view and /api/me/agents are per wallet", async () => {
  const pub = await routes.agent.GET(request("GET", `/api/agents/${agentId}`), ctx({ id: agentId }));
  const text = await pub.text();
  const d = JSON.parse(text) as AgentDetailDTO;
  assert.equal(d.agent.isOwner, false);
  assert.ok(!("ownerWallet" in d.agent) && !("payoutAddress" in d.agent));
  assert.ok(!text.includes(OWNER.address), "the owner's wallet leaks into the public view");

  const own = await routes.agent.GET(request("GET", `/api/agents/${agentId}`, { cookie: OWNER.cookie }), ctx({ id: agentId }));
  assert.equal((await body<AgentDetailDTO>(own)).agent.ownerWallet, OWNER.address);

  const mine = await body<MyAgentsDTO>(await routes.myAgents.GET(request("GET", "/api/me/agents", { cookie: OWNER.cookie }), noCtx));
  assert.ok(mine.agents.some((a) => a.id === agentId));
  const theirs = await body<MyAgentsDTO>(await routes.myAgents.GET(request("GET", "/api/me/agents", { cookie: STRANGER.cookie }), noCtx));
  assert.ok(!theirs.agents.some((a) => a.id === agentId));
  assert.equal((await routes.myAgents.GET(request("GET", "/api/me/agents"), noCtx)).status, 401);
});

test("owner routes: other wallet 403, no session 401, cross-site 403, a legacy owner key is ignored", async () => {
  const id = { id: agentId };
  const patch = (o: Parameters<typeof request>[2]) => routes.agent.PATCH(request("PATCH", `/api/agents/${agentId}`, { body: { status: "paused" }, ...o }), ctx(id));
  assert.equal((await patch({ cookie: STRANGER.cookie })).status, 403);
  assert.equal((await patch({})).status, 401);
  assert.equal((await patch({ headers: { "x-owner-key": `cf_${bs58.encode(randomBytes(32))}` } })).status, 401);
  assert.equal((await patch({ cookie: OWNER.cookie, origin: "https://evil.example" })).status, 403);

  // Every other state-changing owner route refuses a cross-site request too.
  const evil = { cookie: OWNER.cookie, origin: "https://evil.example" };
  const checks: [string, Promise<Response>][] = [
    ["paper-deposit", routes.paper.POST(request("POST", "/x", { ...evil, body: { amountSol: 1 } }), ctx(id))],
    ["deposit-tx", routes.depositTx.POST(request("POST", "/x", { ...evil, body: { amountSol: 1 } }), ctx(id))],
    ["deposit-submit", routes.depositSubmit.POST(request("POST", "/x", { ...evil, body: { txBase64: "AA==", amountSol: 1 } }), ctx(id))],
    ["withdraw", routes.withdraw.POST(request("POST", "/x", { ...evil, body: { all: true } }), ctx(id))],
    ["close-all", routes.closeAll.POST(request("POST", "/x", evil), ctx(id))],
    ["nonce", routes.nonce.POST(request("POST", "/x", { origin: "https://evil.example", body: { wallet: OWNER.address } }), noCtx)],
    ["logout", routes.logout.POST(request("POST", "/x", evil), noCtx)],
  ];
  for (const [name, p] of checks) assert.equal((await p).status, 403, name);
});

test("paper funding: paper-deposit tops up; deposit-tx / deposit-submit are live-only", async () => {
  const id = { id: agentId };
  const top = await routes.paper.POST(request("POST", "/x", { cookie: OWNER.cookie, body: { amountSol: 0.5 } }), ctx(id));
  assert.equal(top.status, 200);
  assert.equal((await body<{ agent: AgentDTO }>(top)).agent.balanceSol, 1.5);
  assert.equal((await routes.depositTx.POST(request("POST", "/x", { cookie: OWNER.cookie, body: { amountSol: 1 } }), ctx(id))).status, 400);
  assert.equal((await routes.depositSubmit.POST(request("POST", "/x", { cookie: OWNER.cookie, body: { txBase64: "AA==", amountSol: 1 } }), ctx(id))).status, 400);
});

test("F13: PATCH can't add the relayer either; paper rule changes need no wallet confirmation", async () => {
  const id = { id: agentId };
  const bad = await routes.agent.PATCH(request("PATCH", "/x", { cookie: OWNER.cookie, body: { traders: [{ wallet: seedWallet }, { wallet: RELAYER }] } }), ctx(id));
  assert.equal(bad.status, 400);
  const good = await routes.agent.PATCH(
    request("PATCH", "/x", { cookie: OWNER.cookie, body: { traders: [{ wallet: seedWallet }, { wallet: seedWallet2 }], maxPerTradeSol: 5, slippageBps: 5000 } }),
    ctx(id),
  );
  assert.equal(good.status, 200);
  assert.equal((await body<{ agent: AgentDTO }>(good)).agent.maxPerTradeSol, 5);
});

test("F37 + F39: withdraw rules, 409 names the open command, and the owner can list commands after a reload", async () => {
  const id = { id: agentId };
  const agent = await prisma.agent.findUniqueOrThrow({ where: { id: agentId }, include: { follows: true } });
  await prisma.position.create({
    data: { agentId, traderId: agent.follows[0]!.traderId, mint: Keypair.generate().publicKey.toBase58(), decimals: 6, rawAmount: "1000000", costSol: 0.2 },
  });

  const closeWithAmount = await routes.withdraw.POST(request("POST", "/x", { cookie: OWNER.cookie, body: { amountSol: 0.5, closePositions: true } }), ctx(id));
  assert.equal(closeWithAmount.status, 400);
  assert.ok((await body<{ fields: Record<string, string> }>(closeWithAmount)).fields.closePositions);
  assert.equal(await prisma.command.count({ where: { agentId } }), 0, "nothing queued, nothing sold");

  const tooMuch = await routes.withdraw.POST(request("POST", "/x", { cookie: OWNER.cookie, body: { amountSol: 2 } }), ctx(id));
  assert.equal(tooMuch.status, 400);

  const first = await routes.withdraw.POST(request("POST", "/x", { cookie: OWNER.cookie, body: { amountSol: 0.5 } }), ctx(id));
  assert.equal(first.status, 202);
  const { command } = await body<{ command: CommandDTO }>(first);
  const second = await routes.withdraw.POST(request("POST", "/x", { cookie: OWNER.cookie, body: { amountSol: 0.1 } }), ctx(id));
  assert.equal(second.status, 409);
  assert.equal((await body<{ command: CommandDTO }>(second)).command.id, command.id);

  const list = await routes.commands.GET(request("GET", `/api/agents/${agentId}/commands?type=withdraw`, { cookie: OWNER.cookie }), ctx(id));
  assert.equal(list.status, 200);
  assert.equal((await body<{ commands: CommandDTO[] }>(list)).commands[0]?.id, command.id);
  const other = await routes.commands.GET(request("GET", `/api/agents/${agentId}/commands`, { cookie: STRANGER.cookie }), ctx(id));
  assert.equal(other.status, 403);
});

// ── live agents (created directly: this server runs in paper mode) ──────────────────────────────────

async function liveAgent(owner: TestWallet, traderWallet: string): Promise<{ id: string; depositAddress: string }> {
  const trader = await prisma.trader.upsert({ where: { wallet: traderWallet }, create: { wallet: traderWallet }, update: {} });
  const depositAddress = Keypair.generate().publicKey.toBase58();
  const a = await prisma.agent.create({
    data: {
      name: "live.test",
      slug: `live.test-${randomBytes(3).toString("hex")}`,
      ownerKeyHash: "",
      ownerWallet: owner.address,
      payoutAddress: owner.address,
      depositAddress,
      sealedSecret: "sealed",
      mode: "live",
      status: "active",
      sizingMode: "fixed",
      fixedSol: 0.1,
      maxPerTradeSol: 1,
      slippageBps: 300,
      lastBalanceSol: 1,
      balanceAt: new Date(Date.now() + 3600_000), // fresh: no RPC from owner views
      follows: { create: [{ traderId: trader.id }] },
    },
  });
  return { id: a.id, depositAddress };
}

test("F18: raising risk on a LIVE agent needs the owner's wallet signature; lowering doesn't; slippage is capped", async () => {
  const { id } = await liveAgent(OWNER, seedWallet);
  const patch = (b: unknown, w: TestWallet = OWNER) => routes.agent.PATCH(request("PATCH", "/x", { cookie: w.cookie, body: b }), ctx({ id }));

  const lower = await patch({ maxPerTradeSol: 0.5, slippageBps: 200 });
  assert.equal(lower.status, 200);

  const capped = await patch({ slippageBps: 2000 });
  assert.equal(capped.status, 400);

  const raise = { maxPerTradeSol: 5, traders: [{ wallet: seedWallet }, { wallet: seedWallet2 }] };
  const challenge = await patch(raise);
  assert.equal(challenge.status, 428);
  const { stepUp } = await body<{ stepUp: SignInChallengeDTO }>(challenge);
  assert.ok(stepUp.message.includes(`start copying wallet ${seedWallet2}`));
  assert.equal((await prisma.agent.findUniqueOrThrow({ where: { id } })).maxPerTradeSol, 0.5, "nothing applied before the signature");

  // A session thief can't sign with the owner's wallet.
  const forged = await patch({ ...raise, confirm: { nonce: stepUp.nonce, signature: signMessage(STRANGER, stepUp.message) } });
  assert.equal(forged.status, 401);

  const again = await body<{ stepUp: SignInChallengeDTO }>(await patch(raise));
  const confirmed = await patch({ ...raise, confirm: { nonce: again.stepUp.nonce, signature: signMessage(OWNER, again.stepUp.message) } });
  assert.equal(confirmed.status, 200);
  const saved = await prisma.agent.findUniqueOrThrow({ where: { id }, include: { follows: { include: { trader: true } } } });
  assert.equal(saved.maxPerTradeSol, 5);
  assert.deepEqual(saved.follows.map((f) => f.trader.wallet).sort(), [seedWallet, seedWallet2].sort());
});

test("live deposit relay never forwards a tampered transfer (validated before anything is recorded or sent)", async () => {
  const { id, depositAddress } = await liveAgent(OWNER, seedWallet);
  const attacker = Keypair.generate().publicKey;
  const tx = (to: PublicKey, lamports: number) => {
    const msg = new TransactionMessage({
      payerKey: OWNER.kp.publicKey,
      recentBlockhash: "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N",
      instructions: [SystemProgram.transfer({ fromPubkey: OWNER.kp.publicKey, toPubkey: to, lamports })],
    }).compileToV0Message();
    const v = new VersionedTransaction(msg);
    v.sign([OWNER.kp]);
    return Buffer.from(v.serialize()).toString("base64");
  };
  const submit = (txBase64: string, amountSol: number) =>
    routes.depositSubmit.POST(request("POST", "/x", { cookie: OWNER.cookie, body: { txBase64, amountSol } }), ctx({ id }));

  const wrongRecipient = await submit(tx(attacker, 1_000_000_000), 1);
  assert.equal(wrongRecipient.status, 400);
  assert.match((await body<{ error: string }>(wrongRecipient)).error, /recipient/);
  const wrongAmount = await submit(tx(new PublicKey(depositAddress), 2_000_000_000), 1);
  assert.equal(wrongAmount.status, 400);
  const garbage = await submit(Buffer.from("not a transaction").toString("base64"), 1);
  assert.equal(garbage.status, 400);
  assert.equal(await prisma.deposit.count({ where: { agentId: id } }), 0);

  // Another wallet can't relay into (or build for) this agent.
  const stranger = await routes.depositSubmit.POST(request("POST", "/x", { cookie: STRANGER.cookie, body: { txBase64: tx(new PublicKey(depositAddress), 1_000_000_000), amountSol: 1 } }), ctx({ id }));
  assert.equal(stranger.status, 403);
});
