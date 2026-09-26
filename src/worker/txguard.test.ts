// Run: npx tsx --test src/worker/txguard.test.ts
// Finding F1: a hostile swap transaction (Jupiter / PumpPortal) must be refused BEFORE the agent key signs it:
// System assign, token approve / set-authority / transfer of other positions, SOL sent elsewhere, unknown programs,
// and anything whose simulation reassigns the wallet, moves other tokens or delivers too little.
import "@/lib/__testing__/env"; // first: keeps the real .env (keys, RPC URLs) out of this test
import { before, test } from "node:test";
import assert from "node:assert/strict";
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { BLOCKHASH, encodeTokenAccount, FakeChain, SYSTEM, TOKEN, type Effect } from "./testkit";

process.env.DATABASE_URL = "file:./__txguard_test_no_such_dir__/none.db";
const chain = new FakeChain().install();

type Guard = typeof import("./txguard");
let g: Guard;
before(async () => {
  g = await import("./txguard");
});

const SOL = "So11111111111111111111111111111111111111112";
const agent = Keypair.generate().publicKey;
const owner = agent.toBase58();
const attacker = Keypair.generate().publicKey;
const MINT = "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr";
const OTHER_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const pk = (s: string) => new PublicKey(s);

function ataCreate(mint: string, wallet = agent): TransactionInstruction {
  return new TransactionInstruction({
    programId: pk(g.ATA_PROGRAM),
    keys: [
      { pubkey: agent, isSigner: true, isWritable: true },
      { pubkey: pk(g.ataAddress(wallet.toBase58(), mint)), isSigner: false, isWritable: true },
      { pubkey: wallet, isSigner: false, isWritable: false },
      { pubkey: pk(mint), isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: pk(TOKEN), isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),
  });
}
const tokenIx = (data: number[], accounts: PublicKey[], signerIdx = -1) =>
  new TransactionInstruction({
    programId: pk(TOKEN),
    keys: accounts.map((a, i) => ({ pubkey: a, isSigner: i === signerIdx, isWritable: i < 2 })),
    data: Buffer.from(data),
  });
const venueIx = (program: string, extra: PublicKey[] = []) =>
  new TransactionInstruction({
    programId: pk(program),
    keys: [{ pubkey: agent, isSigner: true, isWritable: true }, ...extra.map((p) => ({ pubkey: p, isSigner: false, isWritable: true }))],
    data: Buffer.from([7, 7, 7]),
  });

function jupiterBuyIxs(lamports = 100_000_000): TransactionInstruction[] {
  const wsol = pk(g.ataAddress(owner, SOL));
  return [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000_000 }), // 0.3M lamports
    ataCreate(SOL),
    SystemProgram.transfer({ fromPubkey: agent, toPubkey: wsol, lamports }),
    tokenIx([17], [wsol]),
    ataCreate(MINT),
    venueIx(g.JUPITER_V6_PROGRAM, [pk(g.ataAddress(owner, MINT))]),
    tokenIx([9], [wsol, agent, agent], 2),
  ];
}

function txOf(ixs: TransactionInstruction[]): VersionedTransaction {
  return new VersionedTransaction(new TransactionMessage({ payerKey: agent, recentBlockhash: BLOCKHASH, instructions: ixs }).compileToV0Message());
}

const buySpec = (over: Partial<import("./txguard").GuardSpec> = {}): import("./txguard").GuardSpec => ({
  venue: "jupiter",
  side: "buy",
  owner,
  mint: MINT,
  amount: BigInt(100_000_000),
  minOut: BigInt(4_000),
  maxValueOut: BigInt(100_000_000 + 2_000_000 + 4_000_000),
  maxPriorityFeeLamports: 2_000_000,
  ...over,
});

function staticCheck(ixs: TransactionInstruction[], spec = buySpec()) {
  return g.checkInstructions(g.resolveInstructions(txOf(ixs), []), spec);
}

test("layer 1 accepts a Jupiter-shaped buy and the PumpSwap-shaped PumpPortal build", () => {
  const r = staticCheck(jupiterBuyIxs());
  assert.equal(r.priorityFeeLamports, 300_000);
  const wsol = pk(g.ataAddress(owner, SOL));
  const pumpSwap = [
    ataCreate(SOL),
    SystemProgram.transfer({ fromPubkey: agent, toPubkey: wsol, lamports: 110_000_000 }),
    tokenIx([17], [wsol]),
    ataCreate(MINT),
    venueIx(g.PUMP_AMM_PROGRAM),
    tokenIx([9], [wsol, agent, agent], 2),
    SystemProgram.transfer({ fromPubkey: agent, toPubkey: pk(g.PUMPPORTAL_FEE_WALLET), lamports: 500_000 }),
    ComputeBudgetProgram.setComputeUnitLimit({ units: 250_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 2_000_000 }),
  ];
  const rep = staticCheck(pumpSwap, buySpec({ venue: "pumpportal", maxPriorityFeeLamports: 526_000 }));
  assert.equal(rep.venueFeeLamports, BigInt(500_000));
  staticCheck([ataCreate(MINT), venueIx(g.PUMPPORTAL_ROUTER_PROGRAM)], buySpec({ venue: "pumpportal" }));
});

test("layer 1 refuses the F1 attacks: assign, approve, set-authority, token transfer, SOL out, foreign programs", () => {
  const otherAta = pk(g.ataAddress(owner, OTHER_MINT));
  const attacks: [string, TransactionInstruction][] = [
    ["assign", SystemProgram.assign({ accountPubkey: agent, programId: attacker })],
    ["approve", tokenIx([4, ...Array(8).fill(255)], [otherAta, attacker, agent], 2)],
    ["set authority", tokenIx([6, 2, 1, ...attacker.toBytes()], [otherAta, agent], 1)],
    ["token transfer", tokenIx([3, 1, 0, 0, 0, 0, 0, 0, 0], [otherAta, attacker, agent], 2)],
    ["sol out", SystemProgram.transfer({ fromPubkey: agent, toPubkey: attacker, lamports: 104_000_000 })],
    ["unknown program", venueIx(attacker.toBase58())],
    ["close to attacker", tokenIx([9], [otherAta, attacker, agent], 2)],
    ["ata for someone else", ataCreate(MINT, attacker)],
    ["pump program on the jupiter venue", venueIx(g.PUMP_PROGRAM)],
  ];
  for (const [name, ix] of attacks) {
    assert.throws(() => staticCheck([...jupiterBuyIxs(), ix]), g.GuardError, name);
  }
  // PumpPortal's fee wallet only on its own venue, and only once.
  const fee = SystemProgram.transfer({ fromPubkey: agent, toPubkey: pk(g.PUMPPORTAL_FEE_WALLET), lamports: 1 });
  assert.throws(() => staticCheck([...jupiterBuyIxs(), fee]), g.GuardError);
  assert.throws(() => staticCheck([venueIx(g.PUMP_PROGRAM), fee, fee], buySpec({ venue: "pumpportal" })), g.GuardError);
});

test("layer 1 caps the priority fee", () => {
  const ixs = [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000_000 }), venueIx(g.JUPITER_V6_PROGRAM)];
  assert.throws(() => staticCheck(ixs), /priority fee/);
});

// ── Layer 2 ─────────────────────────────────────────────────────────────────────────────────────

const walletState = (lamports: number, ownerProgram = SYSTEM, data = Buffer.alloc(0)) => ({ lamports, owner: ownerProgram, data });
const tokenState = (mint: string, amount: bigint, extra: { delegate?: string; closeAuthority?: string; owner?: string } = {}) => ({
  lamports: 2_039_280,
  owner: TOKEN,
  data: encodeTokenAccount({ mint, owner: extra.owner ?? owner, amount, delegate: extra.delegate, closeAuthority: extra.closeAuthority }),
});

const OTHER = Keypair.generate().publicKey.toBase58();
const TARGET = Keypair.generate().publicKey.toBase58();
const addresses = [owner, OTHER, TARGET];

test("layer 2 accepts an honest buy and reports what arrives", () => {
  const pre = [walletState(1_000_000_000), tokenState(OTHER_MINT, BigInt(50)), null];
  const post = [walletState(1_000_000_000 - 100_000_000 - 2_039_280 - 305_000), tokenState(OTHER_MINT, BigInt(50)), tokenState(MINT, BigInt(5_000))];
  const r = g.diffSimulation(buySpec(), addresses, pre, post);
  assert.equal(r.tokenDelta, BigInt(5_000));
});

test("layer 2 refuses: wallet reassigned, delegate, other tokens moved, too few tokens, too much SOL, closeAuthority", () => {
  const pre = [walletState(1_000_000_000), tokenState(OTHER_MINT, BigInt(50)), null];
  const good = (): (import("./txguard").AccountState | null)[] => [
    walletState(1_000_000_000 - 102_400_000),
    tokenState(OTHER_MINT, BigInt(50)),
    tokenState(MINT, BigInt(5_000)),
  ];
  const cases: [string, (p: ReturnType<typeof good>) => void][] = [
    ["wallet assigned", (p) => (p[0] = walletState(1_000_000_000 - 5_000, attacker.toBase58()))],
    ["delegate on another position", (p) => (p[1] = tokenState(OTHER_MINT, BigInt(50), { delegate: attacker.toBase58() }))],
    ["other tokens moved", (p) => (p[1] = tokenState(OTHER_MINT, BigInt(0)))],
    ["too few tokens", (p) => (p[2] = tokenState(MINT, BigInt(10)))],
    ["no tokens (plain SOL drain)", (p) => (p[2] = null)],
    ["too much SOL", (p) => (p[0] = walletState(1_000_000_000 - 900_000_000))],
    ["new ATA with a close authority", (p) => (p[2] = tokenState(MINT, BigInt(5_000), { closeAuthority: attacker.toBase58() }))],
    ["new ATA owned by someone else", (p) => (p[2] = tokenState(MINT, BigInt(5_000), { owner: attacker.toBase58() }))],
  ];
  for (const [name, mutate] of cases) {
    const post = good();
    mutate(post);
    assert.throws(() => g.diffSimulation(buySpec(), addresses, pre, post), g.GuardError, name);
  }
});

test("layer 2 sells: sells at most the amount, SOL must not leak", () => {
  const sell = buySpec({ side: "sell", amount: BigInt(1_000), minOut: BigInt(0), maxValueOut: BigInt(3_000_000) });
  const pre = [walletState(10_000_000), tokenState(OTHER_MINT, BigInt(50)), tokenState(MINT, BigInt(5_000))];
  const ok = g.diffSimulation(sell, addresses, pre, [walletState(60_000_000), tokenState(OTHER_MINT, BigInt(50)), tokenState(MINT, BigInt(4_000))]);
  assert.equal(ok.tokenDelta, BigInt(-1_000));
  assert.throws(() => g.diffSimulation(sell, addresses, pre, [walletState(60_000_000), tokenState(OTHER_MINT, BigInt(50)), tokenState(MINT, BigInt(0))]), /would sell/);
  assert.throws(() => g.diffSimulation(sell, addresses, pre, [walletState(1_000_000), tokenState(OTHER_MINT, BigInt(50)), tokenState(MINT, BigInt(4_000))]), /cost/);
});

test("Jupiter quote: slippage must match and the minimum out must follow from it", () => {
  const q = { inAmount: "100", outAmount: "10000", otherAmountThreshold: "9700", slippageBps: 300, swapMode: "ExactIn" };
  assert.equal(g.checkJupiterQuote(q, { slippageBps: 300, inAmount: BigInt(100) }), BigInt(9_700));
  assert.throws(() => g.checkJupiterQuote({ ...q, otherAmountThreshold: "0" }, { slippageBps: 300, inAmount: BigInt(100) }), /minimum out/);
  assert.throws(() => g.checkJupiterQuote({ ...q, slippageBps: 5000 }, { slippageBps: 300, inAmount: BigInt(100) }), /slippage/);
  assert.throws(() => g.checkJupiterQuote({ ...q, inAmount: "99" }, { slippageBps: 300, inAmount: BigInt(100) }), /amount/);
});

test("guardSwapTx end to end: a venue CPI that reassigns the wallet is caught by the simulation", async () => {
  chain.accounts.clear();
  chain.setWallet(owner, 1_000_000_000);
  const other = g.ataAddress(owner, OTHER_MINT);
  chain.setToken(other, { mint: OTHER_MINT, owner, amount: BigInt(50) });
  const target = g.ataAddress(owner, MINT);
  const honest: Effect[] = [
    { kind: "lamports", address: owner, delta: -102_400_000 },
    { kind: "create_token", address: target, fields: { mint: MINT, owner, amount: BigInt(5_000) } },
  ];
  chain.effects = () => honest;
  const tx = txOf(jupiterBuyIxs());
  const r = await g.guardSwapTx(tx, buySpec());
  assert.equal(r.tokenDelta, BigInt(5_000));

  chain.effects = () => [...honest, { kind: "assign", address: owner, owner: attacker.toBase58() }];
  await assert.rejects(g.guardSwapTx(tx, buySpec()), /reassigned/);
  chain.effects = () => [...honest, { kind: "delegate", address: other, delegate: attacker.toBase58() }];
  await assert.rejects(g.guardSwapTx(tx, buySpec()), /delegate/);
  chain.effects = () => honest;
  chain.simErr = { InstructionError: [6, { Custom: 6001 }] };
  await assert.rejects(g.guardSwapTx(tx, buySpec()), /simulation failed/);
  chain.simErr = null;
});
