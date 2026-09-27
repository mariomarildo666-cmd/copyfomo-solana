# copyfomo — architecture & contracts

copyfomo lets a visitor sign in with a Solana wallet, pick one or more top traders from **FOMO** (fomo.family, the
Solana social-trading app), and spin up a **copy agent**: a fresh Solana wallet (the *deposit address*), owned by the
signed-in wallet, that mirrors every buy and sell of those traders 1:1 the moment they land on-chain. The owner funds
it in one click (the wallet signs a transfer the server built and validated), and withdrawals only ever go back to the
owner wallet. The platform takes **`PLATFORM_FEE_BPS` (500 = 5%) of the realized profit on each winning copy sell**.

**No FOMO API is used.** FOMO trades are detected on-chain from public Solana data (read through our
Helius key) with *rule R* (`src/lib/fomo-chain.ts`), and the leaderboard is computed by copyfomo
(FIFO realized PnL in USDC, after FOMO's fees) over a bounded set of wallets we index. copyfomo is not
affiliated with FOMO; its numbers will differ from FOMO's in-app numbers. Cross-chain FOMO trades
(Relay deposits) are detected but never counted in PnL and never copied.

This file is the contract every module is built against. If you change a signature here,
you own updating every caller.

## Processes

```
┌──────────── Next.js (web) ────────────┐        ┌────────────── worker (npm run worker) ───────────────┐
│ pages (UI)  →  /api/* route handlers  │        │ watcher: transactionSubscribe | logsSubscribe + poll │
│   - wallet sign-in (SIWS) + cookie    │  DB    │ parser : tx → TraderEvent (buy/sell, mint, SOL size, │
│   - seals new keys with PUBLIC key    │◄──────►│          venue fomo|other via rule R)                │
│   - builds / validates / relays the   │ SQLite │ engine : TraderEvent → sizing → CopyTrade (+ fee)    │
│     owner's deposit transfer          │        │ exec   : paper (Jupiter quote) | live (guarded swap) │
│   - enqueues Command rows             │        │ cmds   : withdraw / close_all; balances; fee sweep;  │
│   - leaderboard/lookup read the DB    │        │          in-flight reconciler; sell retries          │
│     (pasted-wallet check → Helius P4) │        │ fomo/  : FOMO indexer (Helius): stream S1 | logs,    │
└───────────────────────────────────────┘        │          ingest, backfill, sampler, promote, stats,  │
                                                  │          prices, identity, solprice, retention       │
                                                  └──────────────────────────────────────────────────────┘
      both processes → src/lib/helius.ts: metered (HeliusUsage), rate-gated, daily-capped Helius client
```

- **Web** can create agents (generates the key with node:crypto, seals it with `WALLET_SEAL_PUBLIC_KEY` bound to the
  deposit address and the owner wallet, stores only the sealed blob) but can never decrypt it. The only transaction
  it ever relays is the owner's own deposit, after proving it is exactly that transfer.
- **Worker** is the only process with `WALLET_SEAL_PRIVATE_KEY` (from `.env.worker`). It signs swaps, withdrawals,
  fee sweeps and rent reclaims.
- **Ownership** = `Agent.ownerWallet`, the wallet that signed in and created the agent (session cookie). Withdrawals
  only go to it (`payoutAddress = ownerWallet`, fixed). Legacy agents (`ownerWallet` null) keep the `x-owner-key`
  header path (sha256 hash in `ownerKeyHash`); wallet-owned agents store `ownerKeyHash = ""`.

## Modes

`COPYFOMO_MODE=paper` (default): agents get a virtual SOL balance (`Agent.paperSol`) credited at creation
(`depositSol`, simulated) and via "Add simulated SOL". Buys/sells are priced with **real Jupiter quotes** but never
sent; the fee on winning sells is deducted from `paperSol`.
`COPYFOMO_MODE=live`: balance = on-chain SOL of the deposit address; swaps are signed & sent after the tx guard; the
fee accrues in `feeOwedSol` and is swept to `PLATFORM_FEE_WALLET`. The worker refuses to start in live mode without
`PLATFORM_FEE_WALLET`, `JUPITER_API_KEY` + an https non-lite `JUPITER_API_URL`, or a matching seal key pair.
`Agent.mode` is stamped at creation and never changes.

## Stack

- Next.js 16 App Router (READ `node_modules/next/dist/docs/` — params are Promises, use
  `RouteContext<'/api/agents/[id]'>` / `PageProps<'/agents/[id]'>` helpers; `npx next typegen`), React 19,
  Tailwind v4. The root layout is dynamic (it reads the session cookie and renders public config per request).
  `next.config.ts` sets a CSP, `X-Frame-Options: DENY` and friends; `src/instrumentation.ts` refuses to boot the web
  process when `WALLET_SEAL_PRIVATE_KEY` is in its environment.
- Wallets: `@solana/wallet-adapter-base` / `-react` / `-react-ui` with an empty wallets array (Wallet Standard
  auto-detection), no ConnectionProvider (the browser never gets an RPC URL).
- Prisma 6 + SQLite (`prisma/schema.prisma`). `npm run db:push` to sync (additive). The worker runs
  `PRAGMA journal_mode=WAL`. Above ~500 tracked wallets (or the Business global stream) move to Postgres.
- `@solana/web3.js` v1, `bs58`, `zod` v3, `qrcode`, `ws` (worker only: Helius WebSocket stream with ping).
- Worker runs with `tsx --env-file-if-exists=.env --env-file-if-exists=.env.worker` (supports the `@/*` alias).

## Directory ownership

| Path | Owner | Notes |
|---|---|---|
| `prisma/schema.prisma`, `src/lib/types.ts`, `src/lib/config.ts`, `src/lib/format.ts` | contract | change only if unavoidable; keep callers in sync |
| `src/app/layout.tsx`, `src/app/globals.css`, `src/components/shell/*`, `src/components/ui/*`, `src/components/bots/*`, `src/components/wallet/*`, `src/app/api/bot/**` | design system | tokens, Shell (sidebar / phone bars), primitives, pixel robots (PixelRobot, RobotTile, HeroRobots, `GET /api/bot`), wallet providers / sign-in button |
| `src/lib/{db,crypto,solana,jupiter,tokens,prices,fomo,agents,auth,session,deposit,fees,sealguard,infra,ratelimit,http}.ts`, `scripts/*` | core-lib | server-only |
| `src/lib/{helius,fomo-chain,fomo-stats,fomo-seed}.ts`, `src/data/*` | core-lib (FOMO on-chain) | server-only; web + worker. Never import `ws` or worker code here |
| `src/worker/**` | engine | long-running process |
| `src/worker/fomo/**` | engine (FOMO indexer) | started from `src/worker/index.ts` |
| `src/app/api/**` | api | route handlers (`_lib/`: request helpers, schemas, trader guard, step-up, commands, limits) |
| `src/app/page.tsx`, `src/app/floor/**`, `src/app/feed/**`, `src/components/landing/**` | ui-site | marketing + public live views |
| `src/app/traders/**`, `src/app/create/**`, `src/app/agents/**`, `src/components/app/**` | ui-app | leaderboard picker, create wizard, deposit flow, agent dashboard |

## Core lib contracts (`src/lib`)

Do NOT use `server-only` in src/lib (the worker is plain Node and imports it); just never import src/lib/* (other than
`types.ts` / `format.ts`, and the pure `fees.ts`) from client components.

```ts
// db.ts
export const prisma: PrismaClient            // singleton (globalThis cache in dev)
export async function kvGet<T>(key: string): Promise<{ value: T; updatedAt: Date } | null>
export async function kvSet(key: string, value: unknown): Promise<void>

// config.ts — read once, validated, frozen
export const IS_NEXT_SERVER: boolean          // Next's NEXT_RUNTIME define; inside Next walletSealPrivateKey is always ""
export const config                           // + sessionSecret, platformFeeBps (0..2000), platformFeeWallet (base58|""),
                                              //   feeSweepMinSol, trustedIpSource/trustedProxyHops, jupiterRps/jupiterBurst,
                                              //   priorityFeeMaxBps/priorityFeeFloorLamports, minLiveTradeSol, …
                                              //   project: ProjectDTO (PROJECT_X_URL, TOKEN_*; public, parsed by project.ts)
export function liveConfigErrors(c = config): string[]   // missing PLATFORM_FEE_WALLET / JUPITER_API_KEY, lite-api URL

// crypto.ts  (node:crypto only). Blob "v1." (no AAD) | "v2." (AES-GCM AAD = agentSealAad), see the file header
export function generateSealKeypair(): { publicKey: string; privateKey: string }   // base64 raw x25519
export function agentSealAad(depositAddress: string, ownerWallet: string): string  // "copyfomo-agent-v2|dep|owner"
export function sealedVersion(sealed: string): string | null
export function sealSecret(secret: Uint8Array, publicKeyB64 = config.walletSealPublicKey, aad?: string): string   // aad → v2
export function openSecret(sealed: string, privateKeyB64 = config.walletSealPrivateKey, aad?: string): Uint8Array // v2 needs aad; wipes every plaintext chunk
export function newSealedAgentWallet(p: { ownerWallet: string; sealPublicKey?: string }): { depositAddress: string; sealedSecret: string } // ed25519 via node:crypto, v2, raw bytes zeroed
export function verifyEd25519(message: Uint8Array, signature: Uint8Array, publicKey: Uint8Array): boolean
export function newOwnerKey(): string; export function hashOwnerKey(key: string): string    // legacy owner keys
export function safeEqualHex(a: string, b: string): boolean

// session.ts — wallet sign-in (web only)
export const NONCE_TTL_MS /* 10 min */, SESSION_TTL_MS /* 7 days */
export function sessionCookieName(): string                     // "__Host-cf_session" in production, else "cf_session"
export function buildSignInMessage(f: SignInFields): string
export async function createNonce(bind?: { wallet?; domain? }, now?): Promise<{ nonce; issuedAt; expiresAt }>   // Kv "siws:<nonce>", single use
export async function createSignInChallenge(p: { wallet; domain; now? }): Promise<{ message; nonce; expiresAt: string }>
export async function verifySignIn(p: { wallet; message; signature /* base58 */; expectedDomain; now? }): Promise<string>  // 400/401
export function requestDomain(req: Request): string            // Host header; use for BOTH nonce and verify
export function encodeSessionToken(wallet, now?): string; export function decodeSessionToken(token, now?): string | null
export function issueSession(wallet): string; export function clearSession(): string     // Set-Cookie values
export function readSession(req): string | null
export function requireSession(req): string                     // 401; runs assertSameOrigin for unsafe methods
export function assertSameOrigin(req): void                     // 403 cross-site (Sec-Fetch-Site / Origin / Referer)

// auth.ts
export function isOwnerOf(req: Request | null | undefined, agent: { ownerWallet; ownerKeyHash }): boolean
export async function requireOwner(req: Request, idOrSlug: string): Promise<Agent>   // 404/401/403; session wallet === ownerWallet; x-owner-key only when ownerWallet is null

// deposit.ts — one-click funding (see the file header for the exact validation rules)
export const MIN_TOPUP_SOL = 0.001, MAX_DEPOSIT_SOL = 1_000, MAX_PAPER_BALANCE_SOL = 1_000
export function solToLamports(sol: number): bigint
export async function buildDepositTx(p: { from; to; lamports }): Promise<{ txBase64; lastValidBlockHeight; blockhash }>  // fee payer = from
export function validateSignedDeposit(txBase64, expected): ValidatedDeposit   // HttpError(400) on anything but that exact transfer
export class DepositPendingError extends HttpError /* 504 */ { signature }
export async function submitDeposit(txBase64, expected?): Promise<string>     // always re-validates; routes pass `expected`
export async function prepareDeposit(p: { agent; amountSol }): Promise<DepositTxDTO>
export async function relayDeposit(p: { agent; txBase64; amountSol }): Promise<{ signature; status: "confirmed" | "submitted"; balanceSol }>  // Deposit row, 400/409
export async function refreshStoredBalance(agent): Promise<number>   // activates at ≥ minDepositSol only after the worker's seal check (Kv sealcheck:<id> ok)
export async function creditPaperDeposit(p: { agent; amountSol; fromWallet }): Promise<number>   // simulated, "paper_…" Deposit row, activates
export async function walletSolBalance(wallet): Promise<number>      // 10 s cache, single-flight, Helius P2

// fees.ts — pure (safe for client code too)
export const LAMPORTS_PER_SOL_NUM, LIVE_WITHDRAW_BUFFER_SOL /* 0.002 */
export function floorLamportsSol(sol): number
export function computeSellFee(p: { proceedsSol; costPartSol; bps }): number          // profit × bps / 10000 when profit > 0, else 0
export function liveSellReserveSol(maxPriorityFeeLamports): number                    // WSOL rent + fees + priority cap, ≥ 0.005
export function liveWithdrawReserveSol(p: { holdsTokens; maxPriorityFeeLamports }): number
export function withdrawableSol(p: { mode; balanceSol; feeOwedSol; holdsTokens?; maxPriorityFeeLamports? }): number  // same ceiling as the worker
export function planFeeSweep(p: { balanceSol; feeOwedSol; minSweepSol; force?; reserveSol? }): FeeSweepPlan
export function formatFeePct(bps): string

// sealguard.ts — live funding guard (F12)
export async function assertWorkerCanOpenNewKeys(now?): Promise<void>   // live: 503 unless a fresh LIVE heartbeat publishes our seal public key
export async function assertAgentKeyNotBroken(agentId): Promise<void>  // 503 when Kv sealcheck:<id> = {ok:false}
export async function agentKeyVerified(agentId): Promise<boolean>
export function sameSealPublicKey(a, b): boolean

// infra.ts — addresses that are never a trader (shared by the web trader guard and the worker)
export const SYSTEM_PROGRAM, KNOWN_PROGRAMS, KNOWN_MINTS
export function staticTraderRejection(wallet): string | null     // denylist (FOMO relayer/marker/routers, fee accounts, mints, programs) + off-curve
export function isInfrastructureAddress(address): boolean
export function accountRejection(acct: AccountSnapshot | null): string | null   // must be absent or System-owned, not executable

// solana.ts
export const SOL_MINT, USDC_MINT, USDT_MINT, LAMPORTS_PER_SOL
export function connection(): Connection                  // singleton, "confirmed", fetch: heliusFetch (meters Helius hosts at P0)
export function isValidSolanaAddress(s: string): boolean  // base58 32-byte, on-curve not required
export async function getSolBalance(address): Promise<number>
export async function getSolBalanceBudgeted(address, priority: HeliusPriority): Promise<number>   // web paths: daily cap applies
export async function getTokenBalanceRaw(owner, mint): Promise<{ raw: bigint; decimals: number | null }>  // decimals null = unknown, never 0
export class SolanaTxError { signature; outcome: "failed" | "expired" | "unconfirmed" }
export async function sendAndConfirmRaw(raw, signature, blockhash): Promise<string>   // deposit relay; "expired" only after a history lookup
// (The worker signs and confirms its own transactions in src/worker/send.ts.)

// jupiter.ts  (config.jupiterUrl, x-api-key when set; one process-wide JupiterGate: exit > build > entry > background)
export const JUP_PRIORITY; export class JupiterGate; export class JupiterBudgetError
export async function getQuote(p: { inputMint; outputMint; amount: bigint; slippageBps; priority? }): Promise<JupQuote>
export function priorityFeeCapLamports(quote, opts?): number        // size-relative cap (F23)
export async function buildSwap(quote, user): Promise<BuiltSwap>     // { tx, priorityFeeLamports, priorityFeeCapLamports, computeUnitLimit }
export async function buildSwapTx(quote, user): Promise<VersionedTransaction>

// prices.ts (Jupiter price v3, 20 s cache) / tokens.ts (Jupiter tokens v2, Kv forever)
export async function getUsdPrices(mints): Promise<Record<string, number>>
export async function getUsdPriceStatus(mints): Promise<{ prices; unpriced: Set<string>; unavailable: Set<string> }>
export async function getSolUsd(): Promise<number>
export async function getTokenMeta(mint): Promise<{ symbol; name; icon; decimals }>

// fomo.ts — DB only (+ checkFomoActivity for pasted wallets). Labels come from the seed file or Helius labels only.
export const LEADERBOARD_WINDOWS; export async function getLeaderboard(window, limit = 50): Promise<LeaderboardDTO>
export async function lookupTrader(q, opts?): Promise<TraderLookupDTO>
export async function upsertTrader(t): Promise<Trader>      // never marks a wallet tracked: new wallets are "user" candidates
export function retrackReset(now: Date)                     // clean-slate fields when a wallet (re)enters the tracked set
export async function getTraderDetail(wallet): Promise<TraderDetailDTO | null>   // cached 30 s per wallet
export async function copierCounts(wallets): Promise<Map<string, number>>
export async function syncFomoSeed(): Promise<{ created; updated; excluded }>
export async function getIndexerStatus(): Promise<IndexerStatusDTO>

// helius.ts — plain-fetch JSON-RPC + REST client (no web3.js, no ws). Priorities P0 copy, P1 live/gap-fill,
//   P2 backfill/reconcile, P3 discovery, P4 identity/lookups. Token bucket + concurrency gate (plan profile); a 429
//   at priority p backs off p and lower priorities only. Meter → HeliusUsage (UTC day). Daily cap: ≥70 % pauses
//   P3/P4, ≥85 % P2, P0/P1 always run. The key only lives in URLs built here — log with redactUrl().
export const HELIUS_PRIORITY; export class Gate; export function heliusBackoffMs(priority?)
export async function rpc<T>(method, params, opts): Promise<T>
export async function getTransaction / getSignatures / getTransactionsForAddress / batchIdentity / probeCaps / getCachedCaps
export const meter; export async function heliusFetch(input, init); export function heliusWsUrl(); export function redactUrl(url)

// fomo-chain.ts (rule R), fomo-stats.ts (FIFO PnL, ranking), fomo-seed.ts — unchanged, see the files.

// agents.ts — DB → DTO mapping + shared queries
export const agentInclude; export type AgentWithRelations
export function sizeLabel(a: Agent): string
export async function toAgentSummary(a): Promise<AgentSummaryDTO>
export async function toAgentDTO(a, opts: { isOwner?; refreshBalance? } = {}): Promise<AgentDTO>   // PUBLIC by default
export async function withdrawLimits(a): Promise<{ balanceSol; feeOwedSol; reserveSol; withdrawableSol; withdrawAfterCloseSol }>
export function toCommandDTO(c: Command): CommandDTO
export async function findAgent(idOrSlug); export async function getAgentDetail(idOrSlug, { req?, isOwner? } = {})
export async function listMyAgents(wallet, limit = 50): Promise<AgentSummaryDTO[]>
export async function agentBalanceSol(a: Agent): Promise<number>   // owner paths only: 20 s freshness, single-flight, P2
export async function workerOnline(): Promise<boolean>              // Kv "worker:heartbeat" < 60 s old
export async function listFloor(limit?): Promise<FloorDTO>          // stats count the deployment's own mode only
export async function listFeed(limit?): Promise<FeedDTO>            // copy.mode; a live copy beats a paper one on ties

// http.ts / ratelimit.ts
export class HttpError { status; fields?; headers? }; export function json(); export function handle(fn)
export class UpstreamError { status; retryAfterMs }; export function retryAfterMsFrom(headers, now?)
export function rateLimit(key, max, windowMs): void      // in-memory; HttpError(429)
export function clientIp(req, { source?, hops? } = {}): string   // TRUSTED_IP_SOURCE; never the leftmost XFF entry
```

## API contract (`src/app/api`) — all JSON, types from `src/lib/types.ts`

Errors are `ApiError { error, fields? }`. Every state-changing route calls `assertSameOrigin` (403 cross-site).
Bodies are JSON only (415), capped at 32 KB (streamed, 413). `cache-control: no-store` unless noted.

| Method & path | Auth | Body | Response |
|---|---|---|---|
| POST `/api/auth/nonce` | 60/min/IP, 10/min/wallet | `{ wallet }` | `SignInChallengeDTO` |
| POST `/api/auth/verify` | same limits | `{ wallet, message, signature (base58) }` | `SessionDTO` + `Set-Cookie` session; 401 on mismatch / replay / expiry |
| POST `/api/auth/logout` | – | – | `{ wallet: null }` + cookie cleared |
| GET `/api/auth/me` | – | – | `SessionDTO` (never 401) |
| GET `/api/me/agents` | session | – | `MyAgentsDTO` |
| GET `/api/me/balance` | session; 20/min/wallet, 60/min/IP | – | `WalletBalanceDTO` (503 when unavailable) |
| GET `/api/config` | – | – | `AppConfigDTO` (incl. `platformFeeBps`, `maxLiveSlippageBps`, `project`: the site's X account and token) |
| GET `/api/traders?window=24h&limit=50` | – | – | `LeaderboardDTO` (`Cache-Control: public, s-maxage=60, stale-while-revalidate=300`) |
| GET `/api/traders/lookup?q=` | 60/min/IP; 10/min/IP uncached wallet checks | – | `TraderLookupDTO` |
| GET `/api/traders/[wallet]?view=full\|summary` | 60/min/IP (shared with the profile page) | – | `TraderDetailDTO` or 404 (`summary`: stats only, `private, max-age=30`) |
| GET `/api/indexer` | – | – | `IndexerStatusDTO` |
| GET `/api/floor?limit=24` / `/api/feed?limit=30` | – | – | `FloorDTO` / `FeedDTO` |
| POST `/api/agents` | session; 5/10 min per IP and per wallet, 60/10 min site-wide; ≤ 20 open agents per wallet | `CreateAgentInput` | 201 `CreateAgentResult` (`deposit`: unsigned transfer in live, `null` in paper = already credited) |
| GET `/api/agents/[id]` (id or slug) | 60/min/IP | – | `AgentDetailDTO` (owner view with owner-only fields for the owner) |
| PATCH `/api/agents/[id]` | owner; follow-list edits 10/10 min per agent, 30/10 min per IP | `UpdateAgentInput` | `{ agent }`; live risk-raising change → 428 `StepUpRequiredDTO`, resend with `confirm` |
| POST `/api/agents/[id]/deposit-tx` | owner, live; 20/min/agent; seal guard | `{ amountSol }` | `DepositTxDTO` (first deposit must reach `minDepositSol`) |
| POST `/api/agents/[id]/deposit-submit` | owner, live; 10/min/agent; seal guard | `{ txBase64, amountSol }` | `DepositSubmitResultDTO`; tampered tx 400 (nothing recorded), replay 409 |
| POST `/api/agents/[id]/paper-deposit` | owner, paper only | `{ amountSol }` (0 < x ≤ 100) | `{ agent }` |
| POST `/api/agents/[id]/withdraw` | owner | `WithdrawInput` | 202 `{ command }`; open withdrawal → 409 `CommandConflictDTO` |
| POST `/api/agents/[id]/close-all` | owner | – | 202 `{ command }`; open close-all → 409 `CommandConflictDTO` |
| GET `/api/agents/[id]/commands?type=&limit=` | owner | – | `CommandListDTO` (open commands first) |
| GET `/api/agents/[id]/commands/[cid]` | owner | – | `{ command }` |
| GET `/api/agents/[id]/verify` | owner (legacy owner-key agents) | – | `{ ok: true }` |

Validation rules (zod): traders 1..`maxTradersPerAgent`, valid Solana wallets that pass the trader guard (not
infrastructure, not off-curve, not an agent wallet, not excluded; unknown wallets must be absent or System-owned —
503 when that can't be checked); `depositSol` ≥ `minDepositSol` and ≤ 100 (paper) / 1000 (live); no `payoutAddress`
(strict schema: 400); fixedSol 0.001..hardMax, maxPerTradeSol 0.001..`hardMaxPerTradeSol`, slippageBps 10..5000
(live ≤ 1500); name ≤ 24 chars `[a-z0-9_.-]` (default `<first handle or short wallet>.copy`), slug = name + "-" + 4
random chars. Live create also requires the owner wallet to be a plain System account and the seal guard to pass.
Withdraw: a set amount ≤ `withdrawableSol`; a set amount with `closePositions` while positions are open is refused
(`fields.closePositions`: close first, then withdraw an amount); "all + closePositions" is estimated by
`withdrawAfterCloseSol`.

Status rules: new agent → `awaiting_deposit`. Paper create / paper deposit, or a live balance ≥ `minDepositSol` (after
the worker verified the agent's sealed key) → `active`. Owner can toggle `active` ⇄ `paused`. `stopped` is terminal
(after "withdraw everything + close positions" sold every position and left no tokens).

## Engine rules (`src/worker`)

1. Watch set = wallets of Traders followed by agents with status `active` ∪ traders an `active`/`paused` agent still
   holds a sleeve from (so sells can be copied after an unfollow). Refreshed every 10 s (`watchset.ts`).
   Infrastructure addresses (`lib/infra.ts`) are never watched. A per-wallet noise breaker (`noise.ts`: > 600
   notifications a minute that the wallet did not sign) drops a wallet's live subscription for 15 minutes; the poll
   still covers it.
2. Fast path: when the Helius probe says `transactionSubscribe` works (Kv `helius:caps`), one stream (`txstream.ts`):
   `transactionSubscribe{accountInclude: watched, failed: false, vote: false}` with `transactionDetails: "accounts"`,
   jsonParsed, v1 and **no** `accountRequired` (sells on any venue must be seen). A rejected subscribe or 8 drops
   without a subscribe falls back for 30 min to `connection.onLogs(wallet)`; with `COPY_VENUE=fomo` a log
   notification without a FOMO router / Relay invoke is fetched only when an agent may hold a sleeve from that
   trader (open sleeve, a recent buy, or a copy buy still settling). Backfill/fallback: every `pollIntervalMs`
   (default **60 s**; every 5 s for 2 min after a WebSocket error/reconnect, and once right after startup),
   `getSignaturesForAddress` paginated back to the cursor (≤ 10 × 100). On first sight of a wallet, just record the
   newest signature as the cursor — never copy history. Dispatch is **per wallet in the order noticed**.
3. Parse (`parser.ts`, pure): unchanged — the trader must have signed, failed txs are skipped, SOL delta incl. WSOL,
   token deltas per mint, USDC/USDT legs converted with the SOL price; BUY / SELL / null; venue via rule R.
   With `COPY_VENUE=fomo` (default): **buy** events with venue ≠ "fomo" become skipped CopyTrades ("not a FOMO
   trade"); **sells** are copied from any venue while the agent holds that sleeve.
4. `TraderEvent.blockTime` is the local receive time for pushed events, chain blockTime for polled ones. **Buys**
   older than `maxEventAgeMs` are dropped; **sells** are copied up to 6 h old (exits matter).
5. For each active agent following the trader (sells: each active agent holding a sleeve of that token from this
   trader), one async queue per agent:
   - Idempotency: `CopyTrade @@unique([agentId, eventId])`, created first (status pending).
   - BUY sizing (spendable = balance − max(minReserveSol, live sell reserve) − live `feeOwedSol`): mirror / fixed /
     proportional, then min(size, maxPerTradeSol, hardMaxPerTradeSol, spendable). Below 0.001 SOL (paper) or
     `MIN_LIVE_TRADE_SOL` (live) → skipped. Buys whose quote shows > 25 % price impact, or that fill > 25 % worse than
     the trader's own fill, are skipped.
   - SELL: requires copySells and an open Position; amount = floor(sleeve × sellFraction), ≥ 0.98 → whole sleeve.
   - paper: Jupiter quote → fill at outAmount, adjust paperSol, no tx.
   - live: quote → build → **tx guard** (`txguard.ts`: per-venue program / instruction allowlist + a simulation diff
     of the wallet and every agent token account) → sign → journal (CopyTrade "sending" + Kv `inflight:<sig>`, written
     before broadcast) → `send.ts` (rebroadcast, confirm by status polling; "expired" only after block height and a
     history lookup) → amounts from the transaction's own metadata (`txmeta.ts`). The reconciler (`inflight.ts`)
     settles anything left open from the chain. A copy sell that failed while nothing landed is parked and retried
     with rising slippage for 10 minutes (`sellretry.ts`).
   - **Fee** (`ledger.ts`, same DB transaction as the fill): every FILLED sell (copied, close-all, withdraw
     liquidation, retried, reconciled) gets `feeSol = computeSellFee(proceeds, cost part, PLATFORM_FEE_BPS)` on
     `CopyTrade.feeSol`; the sleeve's realizedSol is net of it. Paper: paperSol += proceeds − fee, feesPaidSol += fee.
     Live: feeOwedSol += fee. Buys and losing sells pay nothing.
6. Commands (poll every 2 s): `withdraw` → optional close-all (untracked tokens the agent itself bought are adopted
   and sold too) → reclaim empty token-account rent → forced fee sweep → transfer of at most balance − owed −
   reserve to `ownerWallet ?? payoutAddress` (a row whose payout differs from its owner wallet, the fee wallet, the
   deposit address itself, or a destination that is not a plain System account is refused). Reserve = the sell
   reserve while tokens are held, else 0.002 SOL; an empty wallet with nothing owed is drained to 0. A set amount
   after a close-all is capped at what the sale left (`requestedSol`, `clamped`) and nothing is sent when a sell
   failed. "all + closePositions" sets `stopped: true` only when every position was sold and no tokens remain; else
   `stopped: false` + `positionsLeft`. `close_all` → sell every position at 100 %. Results are JSON
   `{ ok: true, … }` / `{ ok: false, error, … }`; an unconfirmed transfer is `{ ok: false, pending: true, signature }`
   until the reconciler settles it.
7. Balances (live): awaiting_deposit every 30 s, active/paused every 300 s, plus after fills / withdrawals. Every live
   agent's sealed key is opened once per process (Kv `sealcheck:<id>`); an awaiting agent is activated only after
   that succeeds, an active one whose key can't be opened is paused. Deposit rows left `submitted` are settled from
   the chain. Fee sweeps (`feesweep.ts`): every 60 s when owed ≥ `FEE_SWEEP_MIN_SOL`, keeping the reserve; FeeSweep
   rows pending → sent (journaled) → confirmed (owed −= amount, paid += amount) | failed.
8. Heartbeat: Kv `worker:heartbeat` every 10 s (`{ at, mode, watching, watchTransport, sealPublicKey? }`).
9. Never crash on one bad tx/agent: log + continue. Graceful SIGINT / SIGTERM / SIGHUP / SIGBREAK: queued buys stand
   down, queued sells are parked, sends in flight are awaited (≤ ~165 s). `WORKER_EXIT_AFTER_MS` for Windows/CI.
10. A worker only touches agents of its own mode family: paper agents always; live agents only when
    `COPYFOMO_MODE=live`. Run exactly one worker per database. Live startup refuses without `liveConfigErrors() = []`,
    an https `JUPITER_API_URL`, and a seal key pair that derives, round-trips and rejects a foreign key.
11. FOMO indexer (`src/worker/fomo/`, design section 4.2): a no-op without `HELIUS_API_KEY` or with
    `FOMO_INDEXER=off`. Startup: `probeCaps()` → `syncSeed()` → tracked refresh → SOL price backfill → loops. Stream:
    tS mode S1 `transactionSubscribe{accountInclude: tracked (followed > seed > user > discovered), accountRequired:
    [relayer]}` when caps.ts, else `logsSubscribe` per wallet (≤ 240; followed / watched wallets first; a failed
    subscribe is retried with backoff and the wallet reads partial until it succeeds; noisy wallets are dropped like
    overflow). The restart gap-fill runs from the durable resume point (Kv `fomo:stream:lastMsgAt`) once the stream
    has subscribed; P1 gap-fills share 20 % of the daily cap. Tracked refresh (every 30 s): "followed" = wallets of
    FUNDED agents (active / paused) only; followed non-seed wallets become tracked up to half of `FOMO_MAX_TRACKED`
    (and 1/8 of it per UTC day); a user wallet nobody funded follows any more and that never ranked is demoted at
    once; infrastructure rows are swept to `excluded` at startup. Then ingest, backfill (gTFA when available, never
    before 2026-01-06), sampler, promote/demote, stats, prices, identity (paid plans), solprice, retention (tracked
    wallets' closed groups only once their stats are current; excluded at 31 days, candidates at 45), status (Kv
    `fomo:indexer`). Every Helius call goes through `src/lib/helius.ts` with its priority.
