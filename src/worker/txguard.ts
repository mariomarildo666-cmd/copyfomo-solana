// Guard for swap transactions built by a third party (Jupiter, PumpPortal) before the agent key signs them
// (finding F1). A hostile or compromised response must not be able to take the wallet, its tokens or its SOL.
//
// Layer 1, static (checkInstructions): every TOP-LEVEL instruction must be on a per-venue allowlist. The agent's
// signature is only ever handed to programs we trust to use it as documented:
//   - ComputeBudget (priority fee ≤ the cap we asked for);
//   - System: Transfer only — into the agent's own WSOL account (wrapping), or on PumpPortal one fee transfer to
//     its pinned fee wallet (capped); never Assign / Allocate / CreateAccount / transfers elsewhere;
//   - Associated Token Account: create / createIdempotent for the agent (payer and owner = agent) of the traded
//     mint or WSOL;
//   - SPL Token / Token-2022: SyncNative on the agent's WSOL account, CloseAccount back to the agent; never
//     Approve / SetAuthority / Transfer / Burn;
//   - the venue: Jupiter v6, or pump.fun / PumpSwap / PumpPortal's router.
// Layer 2, simulation diff (diffSimulation): simulate with the agent wallet and EVERY agent token account (both
// token programs, plus the target and WSOL ATAs) and compare with their current state: the wallet stays a plain
// System account with no data, no delegate / owner / close authority changes anywhere, no other token moves, the
// traded token moves in the expected direction (buys: at least the minimum out), and the SOL value (wallet + its
// WSOL) drops by no more than the trade allows. This also covers what a routed program does through CPI.
// Program ids are static keys in every message format, so layer 1 needs no lookup-table resolution for them;
// accounts inside instructions are resolved through the message's address lookup tables.

import {
  PublicKey,
  type AccountInfo,
  type AddressLookupTableAccount,
  type Connection,
  type VersionedTransaction,
} from "@solana/web3.js";
import { z } from "zod";
import { connection, SOL_MINT } from "@/lib/solana";
import { TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from "./rent";

export const SYSTEM_PROGRAM = "11111111111111111111111111111111";
export const COMPUTE_BUDGET_PROGRAM = "ComputeBudget111111111111111111111111111111";
export const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
export const JUPITER_V6_PROGRAM = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
export const PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
export const PUMP_AMM_PROGRAM = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
/** PumpPortal's bonding-curve router (seen in its trade-local builds, 2026-09). */
export const PUMPPORTAL_ROUTER_PROGRAM = "FAdo9NCw1ssek6Z6yeWzWjhLVsr8uiCwcWNUnKgzTnHe";
/** PumpPortal's fee wallet (its PumpSwap builds add one SOL transfer here, ~0.5% of the order). */
export const PUMPPORTAL_FEE_WALLET = "7FeFBYbewCqXG7LP6gC8Fnqzk7hmQFMtntXVRqnXi4g6";

const VENUE_PROGRAMS: Record<GuardVenue, readonly string[]> = {
  jupiter: [JUPITER_V6_PROGRAM],
  pumpportal: [PUMP_PROGRAM, PUMP_AMM_PROGRAM, PUMPPORTAL_ROUTER_PROGRAM],
};

/** Hotfix hatch when a venue ships a new program id: WORKER_SWAP_EXTRA_PROGRAMS=<id>,<id> (operator config). */
function extraPrograms(): Set<string> {
  const raw = (process.env.WORKER_SWAP_EXTRA_PROGRAMS ?? "").trim();
  const out = new Set<string>();
  for (const id of raw.split(/[\s,]+/).filter(Boolean)) {
    try {
      out.add(new PublicKey(id).toBase58());
    } catch {
      // ignored: a malformed id never widens the allowlist
    }
  }
  for (const banned of [SYSTEM_PROGRAM, TOKEN_PROGRAM, TOKEN_2022_PROGRAM, ATA_PROGRAM, COMPUTE_BUDGET_PROGRAM]) out.delete(banned);
  return out;
}

/** Venue fee transfers may take at most this share of the order (PumpPortal charges ~0.5–1%). */
const VENUE_FEE_MAX_BPS = BigInt(200);
const VENUE_FEE_SLACK_LAMPORTS = BigInt(10_000);
/** getMultipleAccountsInfo / simulate account list limit. */
const MAX_GUARDED_ACCOUNTS = 100;
const DEFAULT_CU_PER_IX = 200_000;
const MAX_CU = 1_400_000;

export type GuardVenue = "jupiter" | "pumpportal";

export class GuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GuardError";
  }
}

export interface GuardSpec {
  venue: GuardVenue;
  side: "buy" | "sell";
  /** Agent wallet (fee payer, the only signer). */
  owner: string;
  /** The traded token. */
  mint: string;
  /** Buys: lamports the order spends (Jupiter: quote inAmount; PumpPortal: order size). Sells: raw tokens to sell. */
  amount: bigint;
  /** Buys: fewest raw tokens that must arrive in the simulation (Jupiter: otherAmountThreshold). Sells: unused. */
  minOut: bigint;
  /** Most lamports of SOL value (wallet + its WSOL) the tx may cost. Buys: amount + fees + rent. Sells: fees + rent. */
  maxValueOut: bigint;
  /** Ceiling on the compute-budget priority fee, lamports. */
  maxPriorityFeeLamports: number;
}

export interface ResolvedIx {
  programId: string;
  accounts: string[];
  data: Uint8Array;
}

const pk = (s: string) => new PublicKey(s);

/** Associated token account of `owner` for `mint` under `tokenProgram`. */
export function ataAddress(owner: string, mint: string, tokenProgram: string = TOKEN_PROGRAM): string {
  return PublicKey.findProgramAddressSync([pk(owner).toBuffer(), pk(tokenProgram).toBuffer(), pk(mint).toBuffer()], pk(ATA_PROGRAM))[0].toBase58();
}

function u32(data: Uint8Array, at: number): number {
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength).readUInt32LE(at);
}
function u64(data: Uint8Array, at: number): bigint {
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength).readBigUInt64LE(at);
}
const short = (a: string | undefined) => (a ? `${a.slice(0, 6)}…` : "?");

// ── Layer 1: top-level instruction allowlist ────────────────────────────────────────────────────────

export interface InstructionReport {
  /** SOL sent to the venue's fee wallet (PumpPortal), lamports. */
  venueFeeLamports: bigint;
  priorityFeeLamports: number;
}

/** Throws GuardError on the first instruction outside the venue's allowlist. */
export function checkInstructions(ixs: readonly ResolvedIx[], spec: GuardSpec): InstructionReport {
  const owner = spec.owner;
  const wsolAta = ataAddress(owner, SOL_MINT, TOKEN_PROGRAM);
  const venue = new Set([...VENUE_PROGRAMS[spec.venue], ...extraPrograms()]);
  let cuLimit: number | null = null;
  let cuPrice: bigint | null = null;
  let nonBudget = 0;
  let venueFee = BigInt(0);
  let venueFeeTransfers = 0;

  ixs.forEach((ix, n) => {
    const where = `instruction ${n + 1}`;
    const d = ix.data;
    const a = ix.accounts;
    if (ix.programId !== COMPUTE_BUDGET_PROGRAM) nonBudget++;
    switch (ix.programId) {
      case COMPUTE_BUDGET_PROGRAM: {
        const kind = d[0];
        if (kind === 2 && d.length === 5 && cuLimit === null) cuLimit = u32(d, 1);
        else if (kind === 3 && d.length === 9 && cuPrice === null) cuPrice = u64(d, 1);
        else if ((kind === 1 || kind === 4) && d.length === 5) {
          // request heap frame / loaded-accounts data size limit: harmless
        } else throw new GuardError(`${where}: unexpected compute-budget instruction`);
        return;
      }
      case SYSTEM_PROGRAM: {
        if (d.length !== 12 || u32(d, 0) !== 2) throw new GuardError(`${where}: system instruction other than a transfer`);
        if (a[0] !== owner) throw new GuardError(`${where}: transfer from an account other than the agent`);
        const to = a[1];
        if (to === wsolAta) return; // wrapping SOL into the agent's own WSOL account
        if (spec.venue === "pumpportal" && to === PUMPPORTAL_FEE_WALLET && venueFeeTransfers === 0) {
          venueFeeTransfers++;
          venueFee += u64(d, 4);
          return;
        }
        throw new GuardError(`${where}: SOL transfer to ${short(to)} is not allowed`);
      }
      case ATA_PROGRAM: {
        if (!(d.length === 0 || (d.length === 1 && (d[0] === 0 || d[0] === 1)))) throw new GuardError(`${where}: unexpected token-account instruction`);
        if (a[0] !== owner || a[2] !== owner) throw new GuardError(`${where}: token account created for someone else`);
        if (a[3] !== spec.mint && a[3] !== SOL_MINT) throw new GuardError(`${where}: token account for an unrelated mint ${short(a[3])}`);
        return;
      }
      case TOKEN_PROGRAM:
      case TOKEN_2022_PROGRAM: {
        if (d[0] === 17 && d.length === 1) {
          if (a[0] !== wsolAta) throw new GuardError(`${where}: sync of a non-agent WSOL account`);
          return;
        }
        if (d[0] === 9 && d.length === 1) {
          if (a[1] !== owner || a[2] !== owner) throw new GuardError(`${where}: token account closed to someone else`);
          return;
        }
        throw new GuardError(`${where}: token instruction ${d[0] ?? "?"} is not allowed (approve / authority / transfer)`);
      }
      default:
        if (!venue.has(ix.programId)) throw new GuardError(`${where}: program ${short(ix.programId)} is not allowed for ${spec.venue}`);
    }
  });

  const limit = BigInt(cuLimit ?? Math.min(DEFAULT_CU_PER_IX * Math.max(nonBudget, 1), MAX_CU));
  const price: bigint = cuPrice ?? BigInt(0);
  const priority = Number((limit * price + BigInt(999_999)) / BigInt(1_000_000));
  if (priority > spec.maxPriorityFeeLamports + 1) {
    throw new GuardError(`priority fee ${priority} lamports exceeds the ${spec.maxPriorityFeeLamports} cap`);
  }
  return { venueFeeLamports: venueFee, priorityFeeLamports: priority };
}

// ── Layer 2: simulation diff ────────────────────────────────────────────────────────────────────────

export interface AccountState {
  lamports: number;
  /** Owning program (base58). */
  owner: string;
  data: Buffer;
}

export interface DecodedTokenAccount {
  mint: string;
  owner: string;
  amount: bigint;
  delegate: string | null;
  /** 0 uninitialized, 1 initialized, 2 frozen */
  state: number;
  closeAuthority: string | null;
}

/** SPL Token / Token-2022 account base layout (165 bytes; Token-2022 extensions follow). null when too short. */
export function decodeTokenAccount(data: Uint8Array): DecodedTokenAccount | null {
  if (data.length < 165) return null;
  const b = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const key = (at: number) => new PublicKey(b.subarray(at, at + 32)).toBase58();
  return {
    mint: key(0),
    owner: key(32),
    amount: b.readBigUInt64LE(64),
    delegate: b.readUInt32LE(72) === 1 ? key(76) : null,
    state: b[108]!,
    closeAuthority: b.readUInt32LE(129) === 1 ? key(133) : null,
  };
}

export interface SimulationReport {
  /** Traded token change of the agent (buys > 0, sells < 0), raw. */
  tokenDelta: bigint;
  /** SOL value change of the agent: wallet + its WSOL accounts (lamports). */
  valueDelta: bigint;
}

const TOKEN_PROGRAMS = new Set([TOKEN_PROGRAM, TOKEN_2022_PROGRAM]);

/**
 * Compare the agent's accounts before (`pre`) and after (`post`) the simulated tx. `addresses[0]` is the agent
 * wallet; the rest are its token accounts (existing or derived). Throws GuardError listing the first violation.
 */
export function diffSimulation(
  spec: GuardSpec,
  addresses: readonly string[],
  pre: readonly (AccountState | null)[],
  post: readonly (AccountState | null)[],
  venueFeeLamports: bigint = BigInt(0),
): SimulationReport {
  const fail = (why: string): never => {
    throw new GuardError(`simulation: ${why}`);
  };
  const walletPre = pre[0];
  const walletPost = post[0];
  if (!walletPre || !walletPost) fail("agent wallet missing");
  if (walletPost!.owner !== SYSTEM_PROGRAM || walletPost!.data.length !== 0) fail("the agent wallet would be reassigned or given data");
  let valueDelta = BigInt(walletPost!.lamports) - BigInt(walletPre!.lamports);
  let tokenDelta = BigInt(0);

  for (let i = 1; i < addresses.length; i++) {
    const before = pre[i] ?? null;
    const after = post[i] ?? null;
    if (!before && !after) continue;
    const where = short(addresses[i]);
    if (before && !TOKEN_PROGRAMS.has(before.owner)) continue; // not a token account (can't be: listed by owner / derived)
    const decBefore = before ? decodeTokenAccount(before.data) : null;
    if (after && !TOKEN_PROGRAMS.has(after.owner)) fail(`token account ${where} would be reassigned`);
    const decAfter = after ? decodeTokenAccount(after.data) : null;
    if (before && !decBefore) continue; // unparseable pre-state: nothing we could compare
    if (after && !decAfter) fail(`token account ${where} would become unreadable`);
    const mint = (decAfter ?? decBefore)!.mint;

    if (decAfter) {
      if (decAfter.owner !== spec.owner) fail(`token account ${where} would change owner`);
      if (decAfter.delegate !== null && decAfter.delegate !== decBefore?.delegate) fail(`token account ${where} would get a delegate`);
      if (decAfter.closeAuthority !== (decBefore ? decBefore.closeAuthority : null)) fail(`token account ${where} would change its close authority`);
      if (decAfter.state === 2 && decBefore?.state !== 2) fail(`token account ${where} would be frozen`);
      if (decBefore && decAfter.mint !== decBefore.mint) fail(`token account ${where} would change mint`);
    }

    if (mint === SOL_MINT) {
      // WSOL is SOL: count its lamports as the agent's value (it may be created, synced and closed).
      valueDelta += BigInt(after?.lamports ?? 0) - BigInt(before?.lamports ?? 0);
      continue;
    }
    if (mint === spec.mint) {
      if (!after && !(spec.side === "sell" && decBefore)) fail(`the ${where} account of the traded token would be closed`);
      tokenDelta += (decAfter?.amount ?? BigInt(0)) - (decBefore?.amount ?? BigInt(0));
      continue;
    }
    // Any other token: must be untouched.
    if (!before || !after) fail(`token account ${where} (${short(mint)}) would be ${before ? "closed" : "created"}`);
    if (!before!.data.equals(after!.data) || before!.lamports !== after!.lamports) fail(`the agent's ${short(mint)} tokens would move`);
  }

  if (spec.side === "buy") {
    if (tokenDelta <= BigInt(0)) fail("no tokens would arrive");
    if (tokenDelta < spec.minOut) fail(`only ${tokenDelta} tokens would arrive (minimum ${spec.minOut})`);
    if (-valueDelta > spec.maxValueOut) fail(`would cost ${-valueDelta} lamports (limit ${spec.maxValueOut})`);
    if (venueFeeLamports > (spec.amount * VENUE_FEE_MAX_BPS) / BigInt(10_000) + VENUE_FEE_SLACK_LAMPORTS) fail("venue fee too high");
  } else {
    const sold = -tokenDelta;
    if (sold <= BigInt(0)) fail("no tokens would be sold");
    if (sold > spec.amount) fail(`would sell ${sold} tokens (asked ${spec.amount})`);
    if (valueDelta < -spec.maxValueOut) fail(`would cost ${-valueDelta} lamports on a sell (limit ${spec.maxValueOut})`);
    const gross = valueDelta + venueFeeLamports;
    if (venueFeeLamports > (gross > BigInt(0) ? (gross * VENUE_FEE_MAX_BPS) / BigInt(10_000) : BigInt(0)) + VENUE_FEE_SLACK_LAMPORTS) fail("venue fee too high");
  }
  return { tokenDelta, valueDelta };
}

// ── Jupiter quote sanity (the quote is echoed back verbatim when building) ─────────────────────────

const rawQuoteSchema = z
  .object({
    inAmount: z.string().regex(/^\d+$/),
    outAmount: z.string().regex(/^\d+$/),
    otherAmountThreshold: z.string().regex(/^\d+$/),
    slippageBps: z.number().int(),
    swapMode: z.string(),
  })
  .passthrough();

/**
 * The quote we are about to sign must carry the slippage we asked for and a minimum-out consistent with it.
 * Returns otherAmountThreshold (the on-chain minimum out).
 */
export function checkJupiterQuote(raw: unknown, expected: { slippageBps: number; inAmount: bigint }): bigint {
  const q = rawQuoteSchema.safeParse(raw);
  if (!q.success) throw new GuardError("jupiter quote: unexpected shape");
  if (q.data.swapMode !== "ExactIn" || BigInt(q.data.inAmount) !== expected.inAmount) throw new GuardError("jupiter quote: amount mismatch");
  if (q.data.slippageBps !== expected.slippageBps) throw new GuardError(`jupiter quote: slippage ${q.data.slippageBps} bps, asked ${expected.slippageBps}`);
  const out = BigInt(q.data.outAmount);
  const threshold = BigInt(q.data.otherAmountThreshold);
  const floor = (out * BigInt(10_000 - expected.slippageBps)) / BigInt(10_000);
  if (threshold < floor || threshold > out) throw new GuardError("jupiter quote: minimum out does not match the slippage");
  return threshold;
}

// ── Orchestration ───────────────────────────────────────────────────────────────────────────────────

const lutCache = new Map<string, AddressLookupTableAccount>();

async function lookupTables(tx: VersionedTransaction, conn: Connection): Promise<AddressLookupTableAccount[]> {
  if (tx.version === "legacy") return [];
  const out: AddressLookupTableAccount[] = [];
  for (const l of tx.message.addressTableLookups) {
    const key = l.accountKey.toBase58();
    const need = Math.max(-1, ...l.writableIndexes, ...l.readonlyIndexes);
    let table = lutCache.get(key);
    // Entries of an address lookup table never change once written; it only grows. Refetch when too short.
    if (!table || table.state.addresses.length <= need) {
      const res = await conn.getAddressLookupTable(l.accountKey, { commitment: "confirmed" });
      if (!res.value) throw new GuardError(`address lookup table ${short(key)} not found`);
      table = res.value;
      if (lutCache.size > 500) lutCache.clear();
      lutCache.set(key, table);
    }
    out.push(table);
  }
  return out;
}

/** Top-level instructions with every account resolved to base58 (through lookup tables when needed). */
export function resolveInstructions(tx: VersionedTransaction, luts: AddressLookupTableAccount[]): ResolvedIx[] {
  const keys = tx.version === "legacy" ? tx.message.getAccountKeys() : tx.message.getAccountKeys({ addressLookupTableAccounts: luts });
  const at = (i: number): string => {
    const k = keys.get(i);
    if (!k) throw new GuardError(`account index ${i} does not resolve`);
    return k.toBase58();
  };
  return tx.message.compiledInstructions.map((ix) => ({
    programId: at(ix.programIdIndex),
    accounts: ix.accountKeyIndexes.map(at),
    data: ix.data,
  }));
}

function toState(info: AccountInfo<Buffer> | null): AccountState | null {
  return info ? { lamports: info.lamports, owner: info.owner.toBase58(), data: Buffer.from(info.data) } : null;
}

/**
 * Run both layers on `tx`. Resolves with the simulated effect (buys: tokens that would arrive) or throws
 * GuardError. Costs: 2 token-account listings + 1 multi-account read + 1 simulation (+ lookup tables, cached).
 */
export async function guardSwapTx(tx: VersionedTransaction, spec: GuardSpec, conn: Connection = connection()): Promise<SimulationReport> {
  const payer = tx.message.staticAccountKeys[0];
  if (!payer || payer.toBase58() !== spec.owner) throw new GuardError("fee payer is not the agent wallet");
  if (tx.message.header.numRequiredSignatures !== 1) throw new GuardError("transaction requires extra signers");

  const report = checkInstructions(resolveInstructions(tx, await lookupTables(tx, conn)), spec);

  const ownerPk = pk(spec.owner);
  const [legacy, t22] = await Promise.all([
    conn.getTokenAccountsByOwner(ownerPk, { programId: pk(TOKEN_PROGRAM) }, "confirmed"),
    conn.getTokenAccountsByOwner(ownerPk, { programId: pk(TOKEN_2022_PROGRAM) }, "confirmed"),
  ]);
  const addresses = [
    ...new Set([
      spec.owner,
      ...[...legacy.value, ...t22.value].map((r) => r.pubkey.toBase58()),
      ataAddress(spec.owner, spec.mint, TOKEN_PROGRAM),
      ataAddress(spec.owner, spec.mint, TOKEN_2022_PROGRAM),
      ataAddress(spec.owner, SOL_MINT, TOKEN_PROGRAM),
    ]),
  ];
  if (addresses.length > MAX_GUARDED_ACCOUNTS) throw new GuardError(`too many token accounts to verify (${addresses.length - 1})`);

  const [preInfos, sim] = await Promise.all([
    conn.getMultipleAccountsInfo(addresses.map(pk), "confirmed"),
    conn.simulateTransaction(tx, {
      sigVerify: false,
      replaceRecentBlockhash: true,
      commitment: "confirmed",
      accounts: { encoding: "base64", addresses },
    }),
  ]);
  if (sim.value.err) throw new GuardError(`simulation failed (${JSON.stringify(sim.value.err).slice(0, 120)})`);
  const postRaw = sim.value.accounts;
  if (!postRaw || postRaw.length !== addresses.length) throw new GuardError("simulation did not return the agent accounts");
  const post = postRaw.map((a) => (a ? { lamports: a.lamports, owner: a.owner, data: Buffer.from(a.data[0] ?? "", "base64") } : null));
  return diffSimulation(spec, addresses, preInfos.map(toState), post, report.venueFeeLamports);
}
