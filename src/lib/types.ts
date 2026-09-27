// Shared DTOs: the JSON contract between API routes (src/app/api) and the UI.
// Dates are ISO strings. SOL amounts are numbers in SOL. Raw token amounts are strings.
// Import from client and server code alike — this file must stay dependency-free.

export type Mode = "paper" | "live";
export type AgentStatus = "awaiting_deposit" | "active" | "paused" | "stopped";
export type SizingMode = "mirror" | "fixed" | "proportional";
export type Side = "buy" | "sell";
export type CopyStatus = "pending" | "filled" | "failed" | "skipped";
export type CommandType = "withdraw" | "close_all";
export type CommandStatus = "pending" | "running" | "done" | "failed";

/** Rolling windows we rank over. The API still accepts "all" and maps it to "30d". */
export type LeaderboardWindow = "24h" | "7d" | "30d";
/** "fomo" = seed wallet or a FOMO trade seen on-chain; "custom" = any other wallet. */
export type TraderSource = "fomo" | "custom";
export type Coverage = "full" | "partial";
/** Where an original trade was made: FOMO (rule R) or any other app. */
export type Venue = "fomo" | "other";

export interface AppConfigDTO {
  mode: Mode;
  /** HELIUS_API_KEY set → the worker indexes FOMO trades and ranks traders on-chain. */
  onchainRanking: boolean;
  /** "fomo": agents copy only FOMO buys (sells of held sleeves from any venue). */
  copyVenue: "fomo" | "all";
  /** Worker heartbeat seen in the last 60s. */
  workerOnline: boolean;
  minDepositSol: number;
  paperStartSol: number;
  maxTradersPerAgent: number;
  /** Platform fee in basis points of the realized profit on each winning copy sell (500 = 5%). */
  platformFeeBps: number;
  /** Highest slippage a LIVE agent may use (create and rule changes), in bps. Paper agents allow up to 5000. */
  maxLiveSlippageBps: number;
  /** The project's own X account and token (operator settings, public by design). */
  project: ProjectDTO;
}

/**
 * The project's public links, from PROJECT_X_URL and TOKEN_* (src/lib/project.ts). All optional: with nothing set,
 * xUrl and token are null and the UI shows no token card at all.
 */
export interface ProjectDTO {
  /** The project's X account, always normalized to https://x.com/<handle>. */
  xUrl: string | null;
  /** That handle without "@". */
  xHandle: string | null;
  /** Null only when nothing is configured (no X account, no TOKEN_CA, no TOKEN_SYMBOL). */
  token: ProjectTokenDTO | null;
}

export interface ProjectTokenDTO {
  /** Ticker without "$": 1–12 letters or digits ("COPYFOMO" by default). */
  symbol: string;
  /** Display name (TOKEN_NAME, e.g. "CopyFomo"); null when not set. */
  name: string | null;
  /** Contract (mint) address; null until it is set: the UI says "launching soon". */
  ca: string | null;
  /** "pump.fun" when the CA is a pump.fun mint (ends in "pump"), else "Solana"; null without a CA. */
  venue: "pump.fun" | "Solana" | null;
  /** https only; null without a CA. Defaults: pump.fun (pump mints) or Jupiter, and DexScreener. */
  buyUrl: string | null;
  chartUrl: string | null;
}

export interface TraderDTO {
  /** Solana wallet (never null: there are no demo rows). */
  wallet: string;
  /** FOMO handle without "@", from our seed file or a Helius label only (never from user input). */
  handle: string | null;
  displayName: string | null;
  /** X/Twitter handle without "@" (seed file only). The UI links it when present. */
  xHandle: string | null;
  /** Always null for now (we never hotlink FOMO's images). */
  avatarUrl: string | null;
  source: TraderSource;
  /** Handle confirmed (Helius label or manual) — not FOMO's own badge. */
  verified: boolean;
  rank: number | null;
  /** Realized PnL in the window, USD, net of FOMO fees (FIFO). */
  pnlUsd: number | null;
  pnlSol: number | null;
  unrealizedUsd: number | null;
  volumeUsd: number | null;
  trades: number | null;
  /** 0..1 */
  winRate: number | null;
  lastTradeAt: string | null;
  coverage: Coverage | null;
  /** 0..1, cross-chain share of buy-side USDC (not counted, not copied). */
  xchainShare: number | null;
  /** Symbols (else short mint) of the top mints by |realized|. */
  topTokens: string[];
  /** How many copyfomo agents currently follow this wallet. */
  copiers: number;
}

export interface RankingRulesDTO {
  minTrades: number;
  minVolumeUsd: number;
  minActiveDays: number;
}

export interface LeaderboardDTO {
  window: LeaderboardWindow;
  /** "onchain": ranked by copyfomo from indexed FOMO trades. "seed": no stats yet — curated wallets, unranked. */
  source: "onchain" | "seed";
  /** Newest stats computedAt (seed: now). */
  capturedAt: string;
  /** Stats older than 20 min (the indexer may be offline). */
  stale: boolean;
  universe: { tracked: number; ranked: number };
  rules: RankingRulesDTO;
  traders: TraderDTO[];
}

export interface TraderLookupDTO {
  trader: TraderDTO | null;
  note: "unknown_handle" | "no_fomo_activity" | "check_unavailable" | null;
}

export interface TraderWindowStatsDTO {
  window: LeaderboardWindow;
  rank: number | null;
  eligible: boolean;
  coverage: Coverage;
  coveredFrom: string | null;
  trades: number;
  buys: number;
  sells: number;
  volumeUsd: number;
  realizedPnlUsd: number;
  realizedPnlSol: number | null;
  unrealizedPnlUsd: number | null;
  winRate: number | null;
  mintsTraded: number;
  activeDays: number;
  openPositions: number;
  unmatchedSellUsd: number;
  xchainUsd: number;
  xchainShare: number | null;
  lastTradeAt: string | null;
  computedAt: string;
}

export interface FomoTradeDTO {
  signature: string;
  side: Side;
  mint: string;
  symbol: string | null;
  usd: number;
  amount: number;
  router: string;
  blockTime: string;
  realizedPnlUsd: number | null;
}

export interface TraderDetailDTO {
  trader: TraderDTO;
  stats: TraderWindowStatsDTO[];
  perMint: { mint: string; symbol: string | null; realizedPnlUsd: number; realizedPnlSol: number | null; trades: number }[];
  positions: { mint: string; symbol: string | null; amount: number; costUsd: number; valueUsd: number | null; openedAt: string }[];
  /** Newest 50 FOMO trades. */
  recent: FomoTradeDTO[];
  evidenceSig: string | null;
}

export interface IndexerStatusDTO {
  enabled: boolean;
  mode: "stream" | "logs" | "off";
  connected: boolean;
  lastFomoTradeAt: string | null;
  tracked: number;
  candidates: number;
  /** Rounded %, never raw key/URLs. */
  creditsTodayPct: number;
  throttled: boolean;
  driftWarning: string | null;
}

export interface AgentSummaryDTO {
  id: string;
  slug: string;
  name: string;
  mode: Mode;
  status: AgentStatus;
  sizingMode: SizingMode;
  traders: Pick<TraderDTO, "wallet" | "handle" | "displayName" | "avatarUrl">[];
  /**
   * balance − platform fees owed + value of open positions. Positions without a price count at cost while they
   * are younger than 24 h, then at 0 (see unpricedCount); all of them count at cost while prices are unavailable.
   */
  equitySol: number;
  /** Net of platform fees: Σ sell proceeds − Σ buy spend + open value − Σ fees. */
  pnlSol: number;
  /**
   * pnlSol / net capital put in (equitySol − pnlSol = deposits − withdrawals, less network costs); falls back
   * to pnlSol / Σ buy spend when that is not positive; 0 when nothing was bought yet.
   */
  roiPct: number;
  /** Open positions Jupiter has no price for (valued as described on equitySol). */
  unpricedCount: number;
  /** Cost basis of those unpriced positions, SOL. */
  unpricedCostSol: number;
  /** Prices (or SOL/USD) were unavailable: every open position is valued at cost. Show equity/PnL as estimates. */
  valuationStale: boolean;
  copies: number;
  /** Median copy latency in ms over filled trades, null if none. */
  medianLatencyMs: number | null;
  /** Last 12 filled trades, oldest first, for the mini bar chart on the floor. */
  spark: { side: Side; solAmount: number }[];
  lastTradeAt: string | null;
  createdAt: string;
}

export interface AgentDTO extends AgentSummaryDTO {
  /** The agent wallet. Live: send SOL here to fund it. Paper: never funded for real (deposits are simulated). */
  depositAddress: string;
  /** Computed per request: the viewer's session wallet owns this agent (or, legacy, a valid x-owner-key). */
  isOwner: boolean;
  /** Owner only: the wallet that owns the agent. Absent for other viewers and for legacy owner-key agents. */
  ownerWallet?: string;
  /** Owner only: where withdrawals go (= ownerWallet for wallet-owned agents). Absent for other viewers. */
  payoutAddress?: string;
  fixedSol: number;
  maxPerTradeSol: number;
  minReserveSol: number;
  slippageBps: number;
  copySells: boolean;
  /** SOL in the agent right now (paper: paperSol, live: last observed on-chain balance, incl. fees owed). */
  balanceSol: number;
  balanceAt: string | null;
  /** Platform fees already paid (paper: deducted at the sell; live: swept on-chain). */
  feesPaidSol: number;
  /** Live: fees accrued on winning sells, not yet swept. Part of balanceSol but never spendable or withdrawable. */
  feeOwedSol: number;
  /** What a withdrawal can send now: balanceSol − feeOwedSol − the live rent/fee buffer. */
  withdrawableSol: number;
  /**
   * Estimate for "close all positions first": withdrawableSol + priced positions at 95% (slippage), minus the fee
   * on their estimated profit. Unpriced positions are left out. The worker re-checks the real balance.
   */
  withdrawAfterCloseSol: number;
  /**
   * Owner only, live agents: tokens the agent wallet holds that no position accounts for (airdrops, spam, dust the
   * engine would not adopt), as last reported by the worker. They are never sold or valued automatically.
   */
  untrackedTokens?: { mint: string; raw: string; why: string }[];
}

export interface PositionDTO {
  mint: string;
  symbol: string | null;
  trader: Pick<TraderDTO, "wallet" | "handle" | "displayName">;
  decimals: number;
  rawAmount: string;
  /** rawAmount / 10^decimals */
  amount: number;
  costSol: number;
  /** null when no price is available */
  valueSol: number | null;
  unrealizedSol: number | null;
  realizedSol: number;
  openedAt: string;
}

export interface TraderEventDTO {
  id: string;
  signature: string;
  side: Side;
  mint: string;
  symbol: string | null;
  solAmount: number;
  /** "fomo" when the original trade was made on FOMO (rule R), else "other". */
  venue: Venue;
  blockTime: string;
  trader: Pick<TraderDTO, "wallet" | "handle" | "displayName" | "avatarUrl">;
}

export interface CopyTradeDTO {
  id: string;
  side: Side;
  mint: string;
  symbol: string | null;
  solAmount: number;
  status: CopyStatus;
  reason: string | null;
  signature: string | null;
  latencyMs: number | null;
  /** Platform fee charged on this sell (profit > 0 only); 0 for buys and losing sells. solAmount is gross. */
  feeSol: number;
  createdAt: string;
  /** The original trade this mirrors (null for manual close/withdraw sells). */
  original: TraderEventDTO | null;
}

export interface AgentDetailDTO {
  agent: AgentDTO;
  positions: PositionDTO[];
  trades: CopyTradeDTO[];
}

/**
 * Create an agent owned by the signed-in wallet (session cookie). There is no payout field: withdrawals always
 * go to the wallet you signed in with.
 */
export interface CreateAgentInput {
  name?: string;
  traders: { wallet: string; handle?: string | null; displayName?: string | null; avatarUrl?: string | null }[];
  sizingMode: SizingMode;
  fixedSol?: number;
  maxPerTradeSol?: number;
  slippageBps?: number;
  copySells?: boolean;
  /**
   * SOL to fund the agent with right away. Live: the response carries an unsigned transfer for the wallet to
   * sign. Paper: credited immediately as simulated SOL.
   */
  depositSol: number;
}

export interface CreateAgentResult {
  agent: AgentDTO;
  /** Live: the unsigned deposit transfer for the owner's wallet to sign. null in paper mode (already credited). */
  deposit: DepositTxDTO | null;
}

/** An unsigned SystemProgram transfer owner wallet → agent deposit address (fee payer = owner wallet). */
export interface DepositTxDTO {
  /** base64 serialized VersionedTransaction; deserialize with VersionedTransaction.deserialize, sign, re-serialize. */
  txBase64: string;
  lastValidBlockHeight: number;
  amountSol: number;
}

/** POST /api/agents/[id]/deposit-submit response. */
export interface DepositSubmitResultDTO {
  signature: string;
  /** "confirmed": landed. "submitted": sent but not confirmed yet (the balance loop will pick it up). */
  status: "confirmed" | "submitted";
  agent: AgentDTO;
}

/** GET /api/auth/me, POST /api/auth/verify. */
export interface SessionDTO {
  wallet: string | null;
}

/** POST /api/auth/nonce: the exact text the wallet must sign (signMessage, UTF-8 bytes). */
export interface SignInChallengeDTO {
  message: string;
  nonce: string;
  expiresAt: string;
}

/** GET /api/me/agents. */
export interface MyAgentsDTO {
  agents: AgentSummaryDTO[];
}

/** GET /api/me/balance: the signed-in wallet's SOL balance. */
export interface WalletBalanceDTO {
  sol: number;
}

export interface UpdateAgentInput {
  status?: "active" | "paused";
  sizingMode?: SizingMode;
  fixedSol?: number;
  maxPerTradeSol?: number;
  slippageBps?: number;
  copySells?: boolean;
  /** Replaces the full follow list when present. */
  traders?: CreateAgentInput["traders"];
  /**
   * LIVE agents: wallet confirmation of a risk-raising change (the 428 StepUpRequiredDTO flow). `signature` is the
   * base58 signMessage signature of stepUp.message; resend the SAME body with it.
   */
  confirm?: { nonce: string; signature: string };
}

/** What the owner's wallet must sign to confirm a risk-raising rule change on a live agent. */
export interface StepUpChallengeDTO {
  message: string;
  nonce: string;
  expiresAt: string;
}

/** PATCH /api/agents/[id] → 428: sign `stepUp.message`, then resend the same body with `confirm`. */
export interface StepUpRequiredDTO extends ApiError {
  stepUp: StepUpChallengeDTO;
}

export interface WithdrawInput {
  /** Omit with all=true to withdraw everything above rent/fee. */
  amountSol?: number;
  all?: boolean;
  /** Sell every open position into SOL first. */
  closePositions?: boolean;
}

export interface CommandDTO {
  id: string;
  type: CommandType;
  status: CommandStatus;
  result: string | null;
  createdAt: string;
  doneAt: string | null;
}

/** GET /api/agents/[id]/commands (owner only): open commands first, then the newest finished ones. */
export interface CommandListDTO {
  commands: CommandDTO[];
}

/** 409 from withdraw / close-all while a command of that type is still open: attach to `command` and poll it. */
export interface CommandConflictDTO extends ApiError {
  command: CommandDTO;
}

/** One row of the public feed: an original trade and what (one) agent did about it. */
export interface FeedItemDTO {
  id: string;
  original: TraderEventDTO;
  copy: {
    agentId: string;
    agentName: string;
    agentSlug: string;
    /** The copying agent's mode: paper copies are simulated (priced from a quote, no swap sent). */
    mode: Mode;
    status: CopyStatus;
    solAmount: number;
    latencyMs: number | null;
    reason: string | null;
  } | null;
}

export interface FeedDTO {
  /** true when there is no real activity yet and items are generated for demonstration. */
  demo: boolean;
  items: FeedItemDTO[];
}

export interface FloorDTO {
  demo: boolean;
  agents: AgentSummaryDTO[];
  /**
   * Live deployments count live agents only (paper agents are simulated and would inflate copies / volume);
   * paper deployments count paper agents. `mode` says which.
   */
  stats: {
    mode: Mode;
    agents: number;
    copies: number;
    volumeSol: number;
    medianLatencyMs: number | null;
  };
}

export interface ApiError {
  error: string;
  /** Field-level validation messages, when relevant. */
  fields?: Record<string, string>;
}
