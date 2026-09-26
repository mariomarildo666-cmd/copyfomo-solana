// Run: npx tsx --test src/lib/solana.test.ts
// getTokenBalanceRaw must never invent decimals (finding F9). Connection methods are stubbed: no network.
import "./__testing__/env"; // first: keeps the real .env (keys, RPC URLs) out of this test
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { Connection, Keypair } from "@solana/web3.js";

process.env.DATABASE_URL = "file:./__solana_test_no_such_dir__/none.db";
process.env.SOLANA_RPC_URL = "http://127.0.0.1:1"; // never reached: every call below is stubbed

const proto = Connection.prototype as unknown as Record<string, unknown>;
const saved = {
  getParsedTokenAccountsByOwner: proto.getParsedTokenAccountsByOwner,
  getParsedAccountInfo: proto.getParsedAccountInfo,
};
after(() => Object.assign(proto, saved));

function tokenAccount(mint: string, amount: string, decimals: number) {
  return { account: { data: { parsed: { info: { mint, tokenAmount: { amount, decimals } } } } } };
}

test("unknown decimals are null — never 0 — when the mint lookup fails and no account exists yet", async () => {
  const { getTokenBalanceRaw } = await import("./solana");
  const owner = Keypair.generate().publicKey.toBase58();
  const mint = Keypair.generate().publicKey.toBase58();
  proto.getParsedTokenAccountsByOwner = async () => ({ value: [] });
  proto.getParsedAccountInfo = async () => {
    throw new Error("HTTP 500");
  };
  assert.deepEqual(await getTokenBalanceRaw(owner, mint), { raw: BigInt(0), decimals: null });
});

test("decimals come from the token account when one exists, and are cached for the mint", async () => {
  const { getTokenBalanceRaw } = await import("./solana");
  const owner = Keypair.generate().publicKey.toBase58();
  const mint = Keypair.generate().publicKey.toBase58();
  let lookups = 0;
  proto.getParsedAccountInfo = async () => {
    lookups++;
    throw new Error("HTTP 500");
  };
  proto.getParsedTokenAccountsByOwner = async (_o: unknown, filter: { programId: { toBase58(): string } }) =>
    filter.programId.toBase58().startsWith("Tokenkeg")
      ? { value: [tokenAccount(mint, "5000000000", 6), tokenAccount(Keypair.generate().publicKey.toBase58(), "1", 9)] }
      : { value: [] };
  assert.deepEqual(await getTokenBalanceRaw(owner, mint), { raw: BigInt(5_000_000_000), decimals: 6 });

  // Later the account is gone and the mint lookup still fails: the cached decimals are used, not 0.
  proto.getParsedTokenAccountsByOwner = async () => ({ value: [] });
  const before = lookups;
  assert.deepEqual(await getTokenBalanceRaw(owner, mint), { raw: BigInt(0), decimals: 6 });
  assert.equal(lookups, before, "cached: no second mint lookup");
});

test("decimals come from the mint account when the owner holds nothing", async () => {
  const { getTokenBalanceRaw } = await import("./solana");
  const owner = Keypair.generate().publicKey.toBase58();
  const mint = Keypair.generate().publicKey.toBase58();
  proto.getParsedTokenAccountsByOwner = async () => ({ value: [] });
  proto.getParsedAccountInfo = async () => ({ value: { data: { parsed: { info: { decimals: 9 } } } } });
  assert.deepEqual(await getTokenBalanceRaw(owner, mint), { raw: BigInt(0), decimals: 9 });
});
