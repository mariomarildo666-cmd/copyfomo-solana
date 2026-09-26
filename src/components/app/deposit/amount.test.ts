// Amount checks run before any wallet popup; fee copy and wallet error wording the owner reads.

import assert from "node:assert/strict";
import { test } from "node:test";
import { feeExplainer, feeLine, feePct } from "../fees";
import { isUserRejection, walletErrorMessage } from "@/components/wallet/walletErrors";
import { copyMode, tickerParts } from "@/components/landing/model";
import { activationLine } from "../create/StepReview";
import { checkDepositAmount, checkWithdrawAmount, MIN_TOPUP_SOL, parseSol } from "./amount";

test("parseSol accepts plain decimals (comma too), nothing else", () => {
  assert.equal(parseSol("1.5"), 1.5);
  assert.equal(parseSol("1,5"), 1.5);
  assert.equal(parseSol(" .25 "), 0.25);
  assert.equal(parseSol("2."), 2);
  assert.equal(parseSol("1e3"), null);
  assert.equal(parseSol("-1"), null);
  assert.equal(parseSol("abc"), null);
  assert.equal(parseSol(""), null);
});

test("first deposit: at least the activation minimum, at most the per-deposit cap", () => {
  const base = { mode: "live" as const, minSol: 0.05, walletSol: null };
  assert.deepEqual(checkDepositAmount({ ...base, raw: "1" }), { amount: 1, error: null });
  assert.match(checkDepositAmount({ ...base, raw: "0.01" }).error ?? "", /At least 0\.05 SOL/);
  assert.match(checkDepositAmount({ ...base, raw: "1001" }).error ?? "", /At most 1,000 SOL/);
  assert.match(checkDepositAmount({ ...base, raw: "0" }).error ?? "", /Enter an amount/);
  assert.match(checkDepositAmount({ ...base, raw: "0.0000000001" }).error ?? "", /9 decimals/);
  // Paper: simulated, capped lower, never compared with the wallet.
  assert.match(checkDepositAmount({ mode: "paper", minSol: 0.05, walletSol: 0, raw: "101" }).error ?? "", /At most 100 SOL/);
  assert.deepEqual(checkDepositAmount({ mode: "paper", minSol: 0.05, walletSol: 0, raw: "5" }), { amount: 5, error: null });
});

test("live: never ask the wallet for more than it holds (minus the network fee)", () => {
  const r = checkDepositAmount({ mode: "live", minSol: MIN_TOPUP_SOL, walletSol: 1, raw: "1" });
  assert.equal(r.amount, null);
  assert.match(r.error ?? "", /Your wallet holds 1\.00 SOL/);
  assert.equal(checkDepositAmount({ mode: "live", minSol: MIN_TOPUP_SOL, walletSol: 1, raw: "0.99" }).amount, 0.99);
});

test("withdraw amount: minimum and the server-computed ceiling", () => {
  assert.deepEqual(checkWithdrawAmount("0.5", 1, false), { amount: 0.5, error: null });
  assert.match(checkWithdrawAmount("0.00005", 1, false).error ?? "", /At least 0\.0001 SOL/);
  assert.match(checkWithdrawAmount("2", 1, true).error ?? "", /max 1\.00 SOL after selling positions/);
  assert.match(checkWithdrawAmount("", 1, false).error ?? "", /above 0/);
});

test("fee copy: 5% of profit on each winning trade", () => {
  assert.equal(feePct(500), "5%");
  assert.equal(feePct(250), "2.5%");
  assert.equal(feeLine(500), "5% of profit on each winning trade");
  assert.equal(feeLine(0), "No platform fee");
  assert.match(feeExplainer(500), /5% of the profit on each winning copy sell/);
  assert.doesNotMatch(feeExplainer(500), /no platform fee/i);
});

test("activation copy never tells paper users to fund the deposit address", () => {
  assert.match(activationLine("paper", 0.05), /simulated paper SOL/);
  assert.doesNotMatch(activationLine("paper", 0.05), /deposit address/);
  assert.match(activationLine("live", 0.05), /deposit lands/);
});

test("wallet errors: rejections read as a choice, not a failure", () => {
  const rejected = Object.assign(new Error("User rejected the request."), { name: "WalletSignTransactionError" });
  assert.ok(isUserRejection(rejected));
  assert.ok(isUserRejection({ code: 4001, message: "x" }));
  assert.ok(isUserRejection(Object.assign(new Error("wrapped"), { error: { code: 4001 } })));
  assert.equal(walletErrorMessage(rejected, "transaction"), "You declined the transfer in your wallet. No SOL moved.");
  assert.equal(walletErrorMessage(rejected, "sign"), "Sign-in declined in your wallet. Nothing was sent.");
  const locked = Object.assign(new Error("Wallet is locked"), { name: "WalletSignTransactionError" });
  assert.equal(isUserRejection(locked), false);
  assert.match(walletErrorMessage(locked, "transaction"), /couldn't sign the transfer: Wallet is locked/);
});

test("feed: paper fills are labelled, never shown with a 'real' latency", () => {
  const item = {
    id: "1",
    original: {
      id: "e",
      signature: "s",
      side: "buy" as const,
      mint: "M",
      symbol: "PIXL",
      solAmount: 1,
      venue: "fomo" as const,
      blockTime: new Date(0).toISOString(),
      trader: { wallet: "W", handle: null, displayName: null, avatarUrl: null },
    },
    copy: {
      agentId: "a",
      agentName: "x.copy",
      agentSlug: "x",
      mode: "paper" as const,
      status: "filled" as const,
      solAmount: 0.5,
      latencyMs: 81,
      reason: null,
    },
  };
  // The copy's own mode wins (a paper copy on a live deployment is still simulated).
  assert.equal(copyMode(item.copy, "live"), "paper");
  assert.equal(copyMode({ ...item.copy, mode: "live" }, "paper"), "live");
  // Older payloads without `mode`: a paper deployment only fills paper agents; a live one can't tell.
  const legacy = { ...item.copy, mode: undefined } as unknown as typeof item.copy;
  assert.equal(copyMode(legacy, "paper"), "paper");
  assert.equal(copyMode(legacy, "live"), null);
  assert.match(tickerParts(item, "live")?.detail ?? "", /paper \(simulated\)/);
  assert.match(tickerParts({ ...item, copy: { ...item.copy, mode: "live" } }, "live")?.detail ?? "", /81ms/);
});
