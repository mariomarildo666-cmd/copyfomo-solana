// Run: npx tsx --test src/worker/rent.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { SOL_MINT } from "@/lib/solana";
import {
  closableTokenAccounts,
  closeAccountInstruction,
  parseTokenAccount,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
  type TokenAccountInfo,
} from "./rent";

const OWNER = Keypair.generate().publicKey.toBase58();
const STRANGER = Keypair.generate().publicKey.toBase58();
const MINT = "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr";
const RENT = 2_039_280;

function acct(p: Partial<TokenAccountInfo> = {}): TokenAccountInfo {
  return {
    address: Keypair.generate().publicKey.toBase58(),
    programId: TOKEN_PROGRAM,
    mint: MINT,
    owner: OWNER,
    amountRaw: BigInt(0),
    lamports: RENT,
    state: "initialized",
    closeAuthority: null,
    isNative: false,
    withheldFees: false,
    transferHook: false,
    decimals: 6,
    ...p,
  };
}

test("closable: only empty, initialized accounts the agent owns and may close", () => {
  const ok = acct();
  const ok2022 = acct({ programId: TOKEN_2022_PROGRAM });
  const ownClose = acct({ closeAuthority: OWNER });
  const wsol = acct({ mint: SOL_MINT, isNative: true, amountRaw: BigInt(5_000_000), lamports: RENT + 5_000_000 });
  const rejected = [
    acct({ amountRaw: BigInt(1) }), // still holds tokens
    acct({ owner: STRANGER }),
    acct({ state: "frozen" }),
    acct({ closeAuthority: STRANGER }),
    acct({ programId: TOKEN_2022_PROGRAM, withheldFees: true }),
    acct({ programId: "11111111111111111111111111111111" }),
    acct({ mint: MINT, isNative: true, amountRaw: BigInt(3) }), // "native" flag on a non-WSOL mint: not trusted
  ];
  const got = closableTokenAccounts([ok, ...rejected, ok2022, ownClose, wsol], OWNER);
  assert.deepEqual(got.map((a) => a.address), [ok.address, ok2022.address, ownClose.address, wsol.address]);
});

test("parseTokenAccount reads jsonParsed rows (incl. Token-2022 withheld fees)", () => {
  const address = Keypair.generate().publicKey.toBase58();
  const base = { mint: MINT, owner: OWNER, state: "initialized", isNative: false, tokenAmount: { amount: "0", decimals: 6, uiAmount: 0 } };
  const legacy = parseTokenAccount(address, TOKEN_PROGRAM, RENT, { program: "spl-token", parsed: { type: "account", info: base } });
  assert.ok(legacy);
  assert.equal(legacy.amountRaw, BigInt(0));
  assert.equal(legacy.withheldFees, false);
  assert.equal(legacy.closeAuthority, null);

  const withFees = parseTokenAccount(address, TOKEN_2022_PROGRAM, RENT, {
    parsed: { info: { ...base, extensions: [{ extension: "transferFeeAmount", state: { withheldAmount: 12 } }] } },
  });
  assert.equal(withFees?.withheldFees, true);
  const noFees = parseTokenAccount(address, TOKEN_2022_PROGRAM, RENT, {
    parsed: { info: { ...base, closeAuthority: STRANGER, extensions: [{ extension: "transferFeeAmount", state: { withheldAmount: 0 } }] } },
  });
  assert.equal(noFees?.withheldFees, false);
  assert.equal(noFees?.closeAuthority, STRANGER);

  assert.equal(parseTokenAccount(address, TOKEN_PROGRAM, RENT, { parsed: { info: { ...base, tokenAmount: { amount: "1.5" } } } }), null);
  assert.equal(parseTokenAccount(address, TOKEN_PROGRAM, RENT, "base64-bytes"), null);
});

test("CloseAccount instruction: index 9, rent goes back to the agent, agent signs", () => {
  const account = Keypair.generate().publicKey.toBase58();
  for (const programId of [TOKEN_PROGRAM, TOKEN_2022_PROGRAM]) {
    const ix = closeAccountInstruction(programId, account, OWNER);
    assert.equal(ix.programId.toBase58(), programId);
    assert.deepEqual([...ix.data], [9]);
    assert.deepEqual(
      ix.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]),
      [
        [account, false, true],
        [OWNER, false, true],
        [OWNER, true, false],
      ],
    );
  }
});
