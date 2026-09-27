# copyfomo

Copy the top traders on [FOMO](https://fomo.family) (or any Solana wallet), 1:1, the moment their trades land on-chain.

Connect your Solana wallet (Phantom, Solflare, Backpack… any Wallet Standard wallet) and sign in with a message. Pick
one or more traders from the FOMO leaderboard or paste any wallet, set the copy rules, choose how much SOL to put in,
and create the agent: your wallet pops up once to sign the deposit, and the agent starts copying. The leaderboard is
**computed by copyfomo from public Solana data**: FOMO trades are detected on-chain (FOMO's gas relayer plus its trade
marker, "rule R") through your Helius key, and ranked by realized PnL. copyfomo uses no FOMO API and is **not
affiliated with FOMO** (fomo.family); its numbers will differ from FOMO's in-app numbers. Cross-chain FOMO trades
(Relay deposits to Base, BNB…) are detected but never counted in PnL and never copied.

copyfomo creates a **copy agent**: a fresh Solana wallet (its **deposit address**) owned by the wallet you signed in
with. A worker process mirrors every buy and sell of the traders you picked through Jupiter swaps (PumpPortal for
pump.fun tokens Jupiter can't route). **Withdrawals only ever go back to the wallet you signed in with.**

**Fee: 5% of the profit on each winning trade.** When a copied sell closes at a profit, copyfomo keeps
`PLATFORM_FEE_BPS` (500 = 5%) of that sell's realized profit. Losing sells, buys, deposits and withdrawals pay nothing.
PnL on the dashboard is shown after the fee.

> Copy-trading memecoins is risky. Copies land after the original, usually at a worse price, and tokens can go to
> zero. Start in paper mode.

## How it fits together

Two processes share one database:

```
┌──────────── Next.js (web) ────────────┐        ┌────────────── worker (npm run worker) ───────────────┐
│ pages (UI)  →  /api/* route handlers  │        │ watcher: transactionSubscribe | logsSubscribe + poll │
│   - wallet sign-in, session cookie    │  DB    │ parser : tx → TraderEvent (buy/sell, mint, SOL size, │
│   - seals new agent keys (PUBLIC key) │◄──────►│          venue fomo|other via rule R)                │
│   - builds + relays deposit transfers │ SQLite │ engine : TraderEvent → sizing → CopyTrade (+5% fee)  │
│     (validated: exactly owner→agent)  │        │ exec   : paper (Jupiter quote) | live (guarded swap) │
│   - enqueues Command rows             │        │ cmds   : withdraw / close_all; fee sweep; balances   │
│   - never holds agent private keys    │        │ fomo/  : on-chain FOMO indexer (Helius): stream,     │
└───────────────────────────────────────┘        │          backfill, discovery, stats → leaderboard    │
                                                  └──────────────────────────────────────────────────────┘
```

- **Web** (`src/app`, `src/components`): landing page, the floor, the feed, the FOMO leaderboard picker, the create
  wizard (Traders → Rules → Fund → Review), the agent dashboard, plus the JSON API in `src/app/api`. The browser
  never gets an RPC URL: the server builds the unsigned deposit transfer, the wallet signs it, and the server relays
  it after checking it is exactly that transfer.
- **Worker** (`src/worker`): watches trader wallets over WebSocket (with polling backfill), parses each transaction
  into a buy or sell, sizes a copy for every active agent following that trader, fills it, takes the platform fee on
  winning sells, and runs owner commands (withdraw, close all positions). With `HELIUS_API_KEY` set it also runs the
  **FOMO indexer** (`src/worker/fomo`): it streams the tracked wallets' FOMO trades, backfills 37 days of history,
  discovers new active FOMO wallets by sampling FOMO's marker address, and computes the 24h / 7d / 30d leaderboard
  (FIFO realized PnL in USDC, after FOMO's fees).
- **Shared lib** (`src/lib`): Prisma, sealing crypto, wallet sign-in (`session.ts`), agent ownership (`auth.ts`),
  deposits (`deposit.ts`), fees (`fees.ts`), Solana, Jupiter, the metered Helius client, FOMO detection
  (`fomo-chain.ts`), stats (`fomo-stats.ts`), DTO mapping. `src/lib/types.ts` is the API contract.
- **Seed** (`src/data/fomo-seed.json`): 60 curated FOMO wallets with display names, FOMO handles (where known) and X
  handles, each with its `source` provenance. A handle is marked verified only when a Helius identity label confirms
  it. Labels never come from user input.

[ARCHITECTURE.md](ARCHITECTURE.md) has the full contract: module signatures, the API table, validation and status
rules, and the engine rules.

## Quick start (paper mode)

Requires Node 22.9+ (developed on Node 24) and a browser with a Solana wallet extension to sign in.

```bash
npm install                 # also runs prisma generate
cp .env.example .env
npm run keys:gen            # WALLET_SEAL_PUBLIC_KEY + SESSION_SECRET → .env, WALLET_SEAL_PRIVATE_KEY → .env.worker
npm run db:push             # creates / updates prisma/dev.db (SQLite; additive, keeps existing data)

npm run dev                 # web on http://localhost:3000 (npm run dev -- -p 3001 for another port)
npm run worker              # copy engine, in a second terminal (loads .env, then .env.worker)
```

`npm run keys:gen` never prints a private value. Never paste the private key into `.env`: the web process refuses to
run in live mode (and fails at boot in any mode, `src/instrumentation.ts`) when `WALLET_SEAL_PRIVATE_KEY` is in its
environment.

Open `/create`, connect your wallet and sign the sign-in message (no transaction, no cost). Pick a trader (or paste any
wallet), set the rules, choose the amount (presets 0.5 / 1 / 2 / 5 SOL; in paper mode it is **simulated** SOL, credited
at once) and create the agent. It switches on and copies the next trade the trader makes. `/agents` lists the agents of
the wallet you are signed in with, on any device. Top up later from the dashboard ("Add simulated SOL" in paper mode).

Set `HELIUS_API_KEY` (and `HELIUS_PLAN` to your Helius plan) so the worker can index FOMO trades. The worker probes
which Helius features the key has (`transactionSubscribe`, `getTransactionsForAddress`, batch identity) and falls back
gracefully. Until stats exist, the leaderboard lists the seed wallets unranked ("warming up"); they can still be
copied. Without a key the leaderboard stays in that seed mode. Pasting any real wallet always works. With no agents or
trades yet, the floor and the feed show generated demo rows labelled "demonstration".

By default (`COPY_VENUE=fomo`) agents copy only buys the trader made **on FOMO**; sells are copied from any venue
while the agent holds that token, so agents can always exit. Other buys are recorded as skipped ("not a FOMO trade").

### Checks

```bash
npx prisma generate && npm run db:push
npx next typegen       # route types for RouteContext / PageProps
npm run typecheck      # tsc --noEmit
npm run lint
npm test               # node:test via tsx: rule R fixtures, FIFO stats, fees, sign-in, deposits, tx guard, engine…
npm run build
BASE_URL=http://localhost:3001 npx tsx scripts/smoke-api.ts   # end-to-end API run against a running paper server
```

The smoke script signs in with throwaway generated wallets and creates one paper agent named `smoke.test` in the
database it targets.

## Funding, fees and withdrawals

- **One-click deposit (live).** Creating a live agent (or "Top up" on its dashboard) returns an unsigned
  `SystemProgram.transfer` from your wallet to the agent's deposit address (fee payer = your wallet, recent blockhash
  from our RPC). Your wallet signs it (`signTransaction`), and `POST /api/agents/[id]/deposit-submit` relays it only
  after proving it is **exactly** that transfer: one signer (your wallet, valid signature), no lookup tables, only
  ComputeBudget + one System transfer of exactly the requested lamports to this agent, nothing else. The endpoint can
  never relay anything else. A deposit whose confirmation times out is recorded as `submitted` and settled from the
  chain by the worker. The first deposit must bring the agent to `MIN_DEPOSIT_SOL`. Sending SOL to the deposit
  address from any wallet still works (the balance loop picks it up).
- **Paper mode** never moves real SOL: the amount is credited as simulated `paperSol`, the UI says "simulated"
  everywhere and never presents the deposit address as something to fund.
- **The fee.** For every FILLED copy sell (copied sells, close-all and withdrawal liquidation sells) whose realized
  profit `proceeds − cost basis of the part sold` is positive, `fee = profit × PLATFORM_FEE_BPS / 10000`, stored on
  `CopyTrade.feeSol`. Paper: deducted from `paperSol` and added to `Agent.feesPaidSol`. Live: added to
  `Agent.feeOwedSol`; the worker sweeps owed fees to `PLATFORM_FEE_WALLET` (a `FeeSweep` row per transfer) once they
  reach `FEE_SWEEP_MIN_SOL`, and **always before a withdrawal**. Owed fees are never spendable or withdrawable.
- **Withdrawals** go only to the wallet that owns the agent. Live order: optional close-all → reclaim empty token
  account rent → forced fee sweep → transfer of at most `balance − fees owed − reserve` (reserve = enough SOL to sell
  open positions while any are held, else 0.002 SOL; an empty wallet with nothing owed is drained to 0).
  "Everything + close all positions" stops the agent only when every position was sold and the wallet holds no tokens;
  otherwise it keeps running to copy the exits.

## Paper vs live

| | `COPYFOMO_MODE=paper` (default) | `COPYFOMO_MODE=live` |
|---|---|---|
| Funding | simulated `Agent.paperSol`, credited at create / "Add simulated SOL" | one-click wallet transfer to the deposit address (or any manual transfer) |
| Fills | priced with real Jupiter quotes, never sent | Jupiter swap signed by the agent wallet after the tx guard (PumpPortal fallback for unrouted pump.fun mints) |
| Fee on winning sells | deducted from `paperSol` at the sell | accrued in `feeOwedSol`, swept on-chain to `PLATFORM_FEE_WALLET` |
| Withdraw | decrements `paperSol` (simulated) | SOL transfer to the signed-in owner wallet, after the fee sweep |
| Worker needs | nothing secret | `WALLET_SEAL_PRIVATE_KEY` (in `.env.worker`), `PLATFORM_FEE_WALLET`, `JUPITER_API_KEY` + `https://api.jup.ag` |

An agent's mode is stamped at creation and never changes. A paper-mode worker ignores live agents. **Live mode refuses
to start** (clear FATAL message) without `PLATFORM_FEE_WALLET`, without `JUPITER_API_KEY` / with the retiring lite-api
URL, with a non-https `JUPITER_API_URL`, or when the seal key pair does not match.

## Environment

| Variable | Used by | Default | Notes |
|---|---|---|---|
| `COPYFOMO_MODE` | web, worker | `paper` | `paper` or `live` |
| `DATABASE_URL` | web, worker | – | `file:./dev.db` for SQLite, a Postgres URL in production |
| `SOLANA_RPC_URL` | web, worker | public mainnet | Use a paid RPC (Helius, Triton, QuickNode) for real traffic. Never sent to browsers |
| `SOLANA_WS_URL` | worker | derived from RPC URL | WebSocket endpoint for `logsSubscribe` |
| `JUPITER_API_URL` | web, worker | `https://lite-api.jup.ag` | Live mode requires `https://api.jup.ag` with a key (lite-api is being retired) |
| `JUPITER_API_KEY` | web, worker | – | Sent as `x-api-key`. Required in live mode |
| `JUPITER_RPS`, `JUPITER_BURST` | web, worker | per URL (lite 10/20, keyed 1/10, keyless 0.5/5) | One process-wide token bucket; exits get priority |
| `MAX_PRIORITY_FEE_LAMPORTS` | worker | `2000000` | Absolute priority fee cap per swap |
| `PRIORITY_FEE_MAX_BPS`, `PRIORITY_FEE_FLOOR_LAMPORTS` | worker | `500`, `50000` | A swap pays at most this share of its SOL size in priority fee (sells twice), never below the floor |
| `MIN_LIVE_TRADE_SOL` | worker | `0.01` | Live copy buys below this are skipped (paper keeps 0.001) |
| `HELIUS_API_KEY` | web, worker | – | Enables the on-chain FOMO indexer and pasted-wallet checks. Never logged or sent to clients |
| `HELIUS_PLAN` | web, worker | `free` | `free` / `developer` / `business`: sets the budgets below. Features are probed at startup |
| `FOMO_INDEXER` | web, worker | `on` | `off` disables the indexer even with a key |
| `FOMO_MAX_TRACKED` | worker | plan (80 / 2,000 / 10,000) | Wallets indexed and ranked. Followed (non-seed) wallets are capped at half of it, and at 1/8 of it newly per day |
| `FOMO_BACKFILL_DAYS` | worker | plan (7, or 37 with gTFA / 37 / 37) | History fetched per new tracked wallet; never before 2026-01-06 |
| `HELIUS_DAILY_CREDIT_CAP` | web, worker | plan (30k / 300k / 3M) | 70 % pauses discovery and identity, 85 % pauses backfill; copying never pauses |
| `FOMO_DISCOVERY` | worker | plan (`sample` / `sample` / `stream`) | `off` / `sample` / `stream` |
| `FOMO_RELAYERS`, `FOMO_MARKERS` | web, worker | FOMO's current relayer / marker | Hotfix overrides if FOMO changes its on-chain fingerprint |
| `COPY_VENUE` | web, worker | `fomo` | `fomo`: copy FOMO buys only (sells of held tokens from any venue). `all`: every detected swap |
| `SOL_PRICE_BACKFILL` | worker | `binance` | Hourly SOL/USD history for PnL in SOL; `off` to skip |
| `WALLET_SEAL_PUBLIC_KEY` | web, worker | – | Required to create agents. From `npm run keys:gen`. Must pair with the worker's private key (the worker logs and publishes its public key; the web refuses live funding otherwise) |
| `WALLET_SEAL_PRIVATE_KEY` | **worker only** (`.env.worker`) | – | Required in live mode. Never on the web host; the web refuses to start with it in its environment |
| `SESSION_SECRET` | web | – | HMAC key of the wallet sign-in cookie: 32 random bytes, base64url (`keys:gen` writes it). Rotating it signs everyone out |
| `PLATFORM_FEE_BPS` | web, worker | `500` | Share of the realized profit on each winning copy sell (0..2000; 500 = 5%) |
| `PLATFORM_FEE_WALLET` | worker | – | Base58 wallet the live fees are swept to. **Required in live mode.** Give it ≥ ~0.001 SOL: a 0-lamport recipient rejects sweeps below its rent-exempt minimum |
| `FEE_SWEEP_MIN_SOL` | worker | `0.01` | Owed live fees are swept once they reach this (and always before a withdrawal) |
| `TRUSTED_IP_SOURCE`, `TRUSTED_PROXY_HOPS` | web | `xff`, `1` | Where per-IP rate limits read the client IP: `xff` = the entry `TRUSTED_PROXY_HOPS` from the RIGHT of X-Forwarded-For (never the client-controlled leftmost), or a header your proxy overwrites: `x-real-ip`, `cf-connecting-ip`, `x-vercel-forwarded-for`, `fly-client-ip`; `none` |
| `MIN_DEPOSIT_SOL` | web, worker | `0.05` | Balance that flips an agent from `awaiting_deposit` to `active`; the first deposit must reach it |
| `PAPER_START_SOL` | web | `5` | Suggested paper deposit |
| `MAX_TRADERS_PER_AGENT` | web | `10` | |
| `HARD_MAX_PER_TRADE_SOL` | web, worker | `25` | Ceiling on any single copy buy |
| `WORKER_POLL_MS` | worker | `60000` | Backfill poll interval (WebSocket is the fast path; 4 s would cost 21,600 Helius credits/day per wallet) |
| `WORKER_MAX_EVENT_AGE_MS` | worker | `90000` | **Buys** older than this are never copied; sells are copied up to 6 h old |
| `WORKER_SWAP_EXTRA_PROGRAMS` | worker | – | Operator hotfix: extra program ids the live swap guard allows (never System / Token / ATA / ComputeBudget) |
| `LOG_LEVEL` | worker | `info` | `debug` / `info` / `warn` / `error` |
| `WORKER_EXIT_AFTER_MS` | worker | – | Graceful shutdown after N ms (CI, or Windows where you can't send SIGINT) |
| `PROJECT_X_URL` | web | – | The project's X account: `https://x.com/<handle>`, `https://twitter.com/<handle>` or `@handle` (shown as `https://x.com/<handle>`) |
| `TOKEN_SYMBOL` | web | `COPYFOMO` | The project token's ticker without `$` (1–12 letters or digits) |
| `TOKEN_NAME` | web | — | Display name shown next to the ticker, e.g. `CopyFomo` (1–32 letters, digits, spaces, dots, dashes) |
| `TOKEN_CA` | web | – | The token's mint (contract) address, base58. Unset: the token card reads "$SYMBOL · launching soon" |
| `TOKEN_BUY_URL`, `TOKEN_CHART_URL` | web | pump.fun or Jupiter, DexScreener | https only, used once `TOKEN_CA` is set. Buy defaults to `pump.fun/coin/<CA>` for pump.fun mints (ending in `pump`), else `jup.ag/swap/SOL-<CA>`; the chart to `dexscreener.com/solana/<CA>` |
| `NEXT_PUBLIC_SITE_URL` | – | – | Reserved, not read by any code yet |

The project links (`PROJECT_X_URL`, `TOKEN_*`) are public: the sidebar shows a token card ("$SYMBOL on pump.fun", the
contract address with a copy button, Buy / Chart / X), the home hero and footer show the address and the X link, and
phones get the card at the end of every other page. With none of them set there is no card. A malformed value is a
config error in the web, like any other setting; the worker ignores them (it only logs one). A web restart applies a
change, no rebuild.

Next.js loads `.env.local` and `.env.production` **over** `.env`; the worker reads `.env` then `.env.worker`. Keep the
seal public key the same everywhere: it must be exactly the one the worker logs at startup
(`seal key pair ok sealPublicKey=…`) and publishes in its heartbeat.

## Security model

- **Wallet sign-in.** `POST /api/auth/nonce` returns a Sign-In-With-Solana style message bound to the wallet and the
  site's domain (single-use nonce, 10 minutes). The wallet signs it (`signMessage`, no transaction, no cost);
  `POST /api/auth/verify` rebuilds the exact message, checks the ed25519 signature and sets a stateless HMAC-signed
  session cookie (HttpOnly, SameSite=Lax, 7 days; `Secure` and the `__Host-` prefix in production). Every
  state-changing route also rejects cross-site requests (Sec-Fetch-Site / Origin / Referer). Legacy agents created
  with an owner key still accept `x-owner-key`; wallet-owned agents never do.
- **The signed-in wallet owns the agent.** `Agent.ownerWallet` = the session wallet and `payoutAddress` = the same
  wallet, fixed. There is no payout field and no API to change it. Owner-only fields (`ownerWallet`,
  `payoutAddress`, untracked tokens) never appear in public responses. Live agents only accept an owner wallet that
  is a plain System account, and the worker re-checks the destination before every transfer.
- **Custodial agent wallets, split keys, bound to their owner.** The web process generates each agent key (node:crypto
  ed25519, raw bytes wiped) and seals it with `WALLET_SEAL_PUBLIC_KEY` (x25519 + HKDF-SHA256 + AES-256-GCM). New
  agents use v2 blobs whose AES-GCM associated data is `deposit address | owner wallet`: rewriting the owner or payout
  in the database makes the key unopenable instead of redirecting withdrawals. Only the worker holds
  `WALLET_SEAL_PRIVATE_KEY`; it opens a secret per operation into a node:crypto key object, checks it derives the
  deposit address, and zeroes every plaintext copy. The web refuses to create or fund a live agent unless a fresh live
  worker heartbeat publishes the same seal public key, and never activates an agent whose key the worker could not
  open. Rotating the seal keys makes existing agents unreadable, so back up the pair.
- **Risky changes need the wallet.** On a live agent, adding a wallet to copy, changing sizing, or raising the size,
  max per trade or slippage (capped at 15%) needs a fresh `signMessage` of the exact change by the owner wallet; a
  stolen session cookie alone can't raise risk. Lowering risk, pausing and paper agents never need it.
- **Web never moves agent funds.** Withdraw and close-all are queued as `Command` rows. The worker re-checks real
  balances, sweeps owed fees first and records a JSON result. The only transaction the web relays is the owner's own
  deposit, after exact validation.
- **Guarded engine.** Every live swap passes the tx guard before the agent key signs: a per-venue program /
  instruction allowlist (Jupiter v6, pump.fun, PumpSwap, PumpPortal's router) plus a simulation diff of the wallet
  and every agent token account (no owner / delegate / authority changes, other mints untouched, bounded SOL outflow,
  at least the quoted minimum out). A signed swap is journaled before broadcast and settled from the chain (never
  blindly retried); exits that failed while nothing landed are retried with rising slippage for 10 minutes. A copy is
  skipped with a recorded reason rather than guessed: a missing price, a stale buy, an ambiguous transaction, an
  unknown sell fraction, too much price impact or insufficient balance.
- **Traders are wallets, not infrastructure.** FOMO's relayer / marker, routers, mints, programs, off-curve addresses,
  agent wallets and excluded wallets can't be followed; the worker filters the same addresses from its watch set and
  the indexer, and a per-wallet notification breaker drops wallets that flood the streams.
- **API hardening.** zod validation on every body and query, JSON-only bodies (415 otherwise), a 32 KB streamed body
  cap, `no-store` on every response, a CSP and `X-Frame-Options: DENY`, and per-IP / per-wallet rate limits (agent
  creation, sign-in, lookups, profiles, deposits, follow-list edits). The rate limits are in memory and read the client
  IP from `TRUSTED_IP_SOURCE`: configure it to match your proxy (nginx and Cloudflare do not overwrite an incoming
  X-Forwarded-For by default; `xff` therefore takes the entry your own proxy appended, counted from the right).

## Deploying

Run **web and worker as two processes** against the same database:

```bash
# web host: needs WALLET_SEAL_PUBLIC_KEY + SESSION_SECRET, NOT the private key
npm ci && npm run build && npm start

# worker host: needs WALLET_SEAL_PRIVATE_KEY in .env.worker (live mode); exactly ONE worker per database
npm ci && npm run worker        # reads .env then .env.worker if present; real env vars take precedence
```

- **Keep the private key off the web host.** On a single machine run web and worker as different OS users and make
  `.env.worker` unreadable by the web user. Purge `.next/cache` before packaging (Turbopack snapshots the environment);
  `.dockerignore` already excludes `.env*`, `.next` and local databases.
- **Use Postgres in production.** Set `provider = "postgresql"` in `prisma/schema.prisma`, point `DATABASE_URL` at
  it and run `npx prisma db push` (or adopt `prisma migrate`). SQLite only works when both processes share one
  machine and one file.
- **Ship `tools/bots` with the web app.** The robot avatars (`GET /api/bot/[seed]`) are drawn at request time by the
  pixel-robot generator in `tools/bots`, loaded from the working directory. `next start` from the repo root (and the
  Docker context) has it; a Next.js `standalone` or serverless build must copy that folder next to the server.
- **Run one worker.** At startup the worker fails only work that never reached the chain; signed-but-unsettled swaps,
  withdrawals, fee sweeps and deposits are settled from the chain by its reconciler. A second worker on the same
  database would corrupt that bookkeeping. Shutdown (SIGINT / SIGTERM / SIGHUP / SIGBREAK) waits up to ~165 s for
  sends already in flight.
- **Live checklist.** `COPYFOMO_MODE=live` on both processes, `PLATFORM_FEE_WALLET` funded with ≥ ~0.001 SOL,
  `JUPITER_API_URL=https://api.jup.ag` + `JUPITER_API_KEY`, the same `WALLET_SEAL_PUBLIC_KEY` on both hosts, and a
  tiny real deposit test with each wallet you support (some wallets add their own instructions when signing; the relay
  then refuses and the UI suggests a manual transfer to the deposit address instead).
- **Keep the clock synced.** Latency figures compare local time with chain block time, and the worker warns when the
  clock is behind.
- **Run a single web instance, or add a shared store.** The rate limiter, the sign-in nonce check and the per-agent
  command lock rely on this process (nonces are in the DB, the rest in memory). More than one web instance needs
  Redis or a DB-level guard for the rate limits and the command lock.
- **Serve over HTTPS** behind a proxy, set `TRUSTED_IP_SOURCE` / `TRUSTED_PROXY_HOPS` to match it, and cap request
  bodies there too (nginx `client_max_body_size 64k;`, Caddy `request_body { max_size 64KB }`).
