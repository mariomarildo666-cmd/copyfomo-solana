// Run: npx tsx --test src/worker/txmeta.test.ts
// Findings F2 / F8: fills come from the transaction's own metadata — tokens from the agent's token balances,
// cost / proceeds from the agent's SOL value change (fees included, reclaimable token-account rent excluded).
import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { analyzeAgentTx, type TxResponseLike } from "./txmeta";

const agent = Keypair.generate().publicKey;
const owner = agent.toBase58();
const MINT = "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr";
const OTHER = Keypair.generate().publicKey.toBase58();
const RENT = 2_039_280;

function tx(meta: Partial<NonNullable<TxResponseLike["meta"]>>, payer = agent): TxResponseLike {
  return {
    slot: 42,
    transaction: { message: { staticAccountKeys: [payer, Keypair.generate().publicKey, Keypair.generate().publicKey] } },
    meta: { err: null, fee: 5_000, preBalances: [], postBalances: [], preTokenBalances: [], postTokenBalances: [], ...meta },
  };
}
const tb = (accountIndex: number, amount: string, mint = MINT, o = owner) => ({
  accountIndex,
  mint,
  owner: o,
  uiTokenAmount: { amount, decimals: 6 },
});

test("buy into a new token account: cost = SOL out incl. fees, excl. the account's rent", () => {
  const spent = 100_000_000;
  const priority = 300_000;
  const t = tx({
    preBalances: [1_000_000_000, 0, 5],
    postBalances: [1_000_000_000 - spent - priority - 5_000 - RENT, RENT, 5],
    preTokenBalances: [],
    postTokenBalances: [tb(1, "5000")],
  });
  const e = analyzeAgentTx(t, owner, MINT)!;
  assert.equal(e.tokenDelta, BigInt(5_000));
  assert.equal(e.valueDeltaLamports, BigInt(-(spent + priority + 5_000)));
  assert.equal(e.decimals, 6);
  assert.equal(e.slot, 42);
});

test("sell that closes a pre-existing WSOL account: its lamports are the agent's own, not proceeds", () => {
  const t = tx({
    preBalances: [10_000_000, RENT + 7, RENT],
    postBalances: [10_000_000 + 50_000_000 + RENT + 7 - 5_000, 0, RENT],
    preTokenBalances: [tb(1, "7", "So11111111111111111111111111111111111111112"), tb(2, "4000")],
    postTokenBalances: [tb(2, "0")],
  });
  const e = analyzeAgentTx(t, owner, MINT)!;
  assert.equal(e.tokenDelta, BigInt(-4_000));
  assert.equal(e.tokenAfter, BigInt(0));
  assert.equal(e.valueDeltaLamports, BigInt(50_000_000 - 5_000));
});

test("other owners' balances in the same tx are ignored", () => {
  const t = tx({
    preBalances: [1_000, 9, 9],
    postBalances: [1_000, 9, 9],
    preTokenBalances: [tb(1, "100", MINT, OTHER)],
    postTokenBalances: [tb(1, "0", MINT, OTHER), tb(2, "100")],
  });
  assert.equal(analyzeAgentTx(t, owner, MINT)!.tokenDelta, BigInt(100));
});

test("unattributable: another fee payer, no meta, or balances without owners", () => {
  assert.equal(analyzeAgentTx(tx({}, Keypair.generate().publicKey), owner, MINT), null);
  assert.equal(analyzeAgentTx({ ...tx({}), meta: null }, owner, MINT), null);
  const ownerless = { accountIndex: 1, mint: MINT, uiTokenAmount: { amount: "5", decimals: 6 } };
  assert.equal(analyzeAgentTx(tx({ postTokenBalances: [ownerless] }), owner, MINT), null);
});
