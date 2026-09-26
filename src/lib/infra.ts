// Infrastructure addresses that are never a trader (finding F13), shared by the web (trader guard on create /
// PATCH) and the worker (defense in depth: the watch set, the indexer's tracked set and a startup sweep filter the
// same addresses, so rows created before the web guard existed can't stream a large share of Solana's traffic).
//   - a static denylist: FOMO relayer / marker / routers / Relay depository / fee accounts, our platform fee wallet,
//     SOL / USDC / USDT and other well-known mints, system / token / loader / sysvar / DEX programs;
//   - off-curve addresses (PDAs): nobody can sign for them, so they never trade.
// Pure (no I/O). Never import worker code here.

import { PublicKey } from "@solana/web3.js";
import { config } from "./config";
import { FOMO_FEE_USDC_ATA, FOMO_FEE_WALLET, FOMO_MARKERS, FOMO_RELAYERS, FOMO_ROUTERS, RELAY_DEPOSITORY } from "./fomo-chain";
import { SOL_MINT, USDC_MINT, USDT_MINT } from "./solana";

export const SYSTEM_PROGRAM = "11111111111111111111111111111111";

/** Well-known programs and sysvars: never a wallet. */
export const KNOWN_PROGRAMS: readonly string[] = Object.freeze([
  SYSTEM_PROGRAM,
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", // SPL Token
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", // Token-2022
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", // Associated Token Account
  "ComputeBudget111111111111111111111111111111",
  "AddressLookupTab1e1111111111111111111111111",
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr", // Memo v2
  "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo", // Memo v1
  "Vote111111111111111111111111111111111111111",
  "Stake11111111111111111111111111111111111111",
  "Config1111111111111111111111111111111111111",
  "BPFLoader1111111111111111111111111111111111",
  "BPFLoader2111111111111111111111111111111111",
  "BPFLoaderUpgradeab1e11111111111111111111111",
  "NativeLoader1111111111111111111111111111111",
  "Ed25519SigVerify111111111111111111111111111",
  "KeccakSecp256k11111111111111111111111111111",
  "SysvarRent111111111111111111111111111111111",
  "SysvarC1ock11111111111111111111111111111111",
  "Sysvar1nstructions1111111111111111111111111",
  "SysvarRecentB1ockHashes11111111111111111111",
  "SysvarS1otHashes111111111111111111111111111",
  "SysvarStakeHistory1111111111111111111111111",
  "SysvarEpochSchedu1e111111111111111111111111",
  "SysvarFees111111111111111111111111111111111",
  "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s", // Metaplex token metadata
  "JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB", // Jupiter v4
  "jupoNjAxXgZ4rjzxzPMP4oxduvQsQtZzyknqvzYNrNu", // Jupiter limit orders
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P", // pump.fun
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA", // PumpSwap AMM
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8", // Raydium AMM v4
  "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1", // Raydium AMM v4 authority
  "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK", // Raydium CLMM
  "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C", // Raydium CPMM
  "LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj", // Raydium LaunchLab
  "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc", // Orca Whirlpools
  "9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP", // Orca v2
  "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo", // Meteora DLMM
  "Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB", // Meteora pools
  "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG", // Meteora DAMM v2
  "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN", // Meteora dynamic bonding curve
  "PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY", // Phoenix
  "opnb2LAfJYbRMAHHvqjCwQxanZn7ReEHp1k81EohpZb", // OpenBook v2
  "srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX", // OpenBook / Serum
]);

/** Well-known mints: never a wallet (other mints are caught by the account check). */
export const KNOWN_MINTS: readonly string[] = Object.freeze([
  SOL_MINT,
  USDC_MINT,
  USDT_MINT,
  "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So", // mSOL
  "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn", // JitoSOL
  "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", // BONK
  "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN", // JUP
]);

/** address → why it can't be followed. */
function buildDenylist(): ReadonlyMap<string, string> {
  const m = new Map<string, string>();
  const add = (list: Iterable<string>, why: string) => {
    for (const a of list) if (a && !m.has(a)) m.set(a, why);
  };
  add(FOMO_RELAYERS, "that's FOMO's gas relayer, not a trader — pick the trader's own wallet");
  add(FOMO_MARKERS, "that's FOMO's trade marker account, not a trader");
  add(Object.keys(FOMO_ROUTERS), "that's a swap router program, not a trader");
  add([RELAY_DEPOSITORY], "that's the Relay bridge depository, not a trader");
  add([FOMO_FEE_WALLET, FOMO_FEE_USDC_ATA], "that's FOMO's fee account, not a trader");
  add(config.platformFeeWallet ? [config.platformFeeWallet] : [], "that's copyfomo's fee wallet, not a trader");
  add(KNOWN_MINTS, "that's a token mint, not a wallet");
  add(KNOWN_PROGRAMS, "that's a Solana program, not a wallet");
  return m;
}

let denylist: ReadonlyMap<string, string> | null = null;

/** Why `wallet` can never be followed (static rules only: denylist + off-curve), or null. No I/O. */
export function staticTraderRejection(wallet: string): string | null {
  denylist ??= buildDenylist();
  const listed = denylist.get(wallet);
  if (listed) return listed;
  let key: PublicKey;
  try {
    key = new PublicKey(wallet);
  } catch {
    return "not a valid Solana address";
  }
  if (!PublicKey.isOnCurve(key.toBytes())) {
    return "that's a program-owned address (no one can trade from it) — paste the trader's wallet";
  }
  return null;
}

/** True for addresses that can never be a trader: the static denylist, invalid or off-curve addresses. No I/O. */
export function isInfrastructureAddress(address: string): boolean {
  return staticTraderRejection(address) !== null;
}

/** Test hook: rebuild the denylist (e.g. after changing PLATFORM_FEE_WALLET in a test). */
export function _resetInfraDenylist(): void {
  denylist = null;
}

// ── Existing accounts ───────────────────────────────────────────────────────────────────────────────

export interface AccountSnapshot {
  owner: string;
  executable: boolean;
  /** Data length in bytes when the RPC reports it, else null. */
  space: number | null;
}

/** Why an existing account can't be a trader wallet (owned by a program / executable), or null. */
export function accountRejection(acct: AccountSnapshot | null): string | null {
  if (acct === null) return null; // never used yet: fine (a fresh wallet)
  if (acct.executable) return "that's a program, not a wallet";
  if (acct.owner !== SYSTEM_PROGRAM) {
    if (acct.owner === "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" || acct.owner === "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb") {
      return "that's a token mint or token account, not a wallet — paste the trader's wallet address";
    }
    return "that account belongs to a program, not a wallet — paste the trader's wallet address";
  }
  return null;
}
