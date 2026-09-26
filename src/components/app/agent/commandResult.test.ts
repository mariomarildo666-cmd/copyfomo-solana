// A withdrawal that could not sell every position must never read as a plain "Done" (finding F38).

import assert from "node:assert/strict";
import { test } from "node:test";
import { describeResult } from "./commandResult";

const SIG = "5".repeat(88);

test("withdraw with failed sells: nested summaries are shown and flagged as problems", () => {
  const raw = JSON.stringify({
    ok: true,
    mode: "live",
    amountSol: 3.2,
    to: "7LoRpjZ1wS3dG1v3CUKi2mz5eB6sBy1SFFtBNGeBENhz",
    signature: SIG,
    closed: { sold: 3, failed: 2, errors: ["BONK: no route", "WIF: no route"] },
    rent: { closed: 4, failed: 0, reclaimedSol: 0.0081, errors: [] },
  });
  const v = describeResult(raw);
  assert.deepEqual(v.signatures, [SIG]);
  assert.ok(v.lines.includes("amount sol: 3.20 SOL"));
  assert.ok(v.lines.includes("closed sold: 3"), "nested counts are flattened, not dropped");
  assert.ok(v.lines.includes("closed failed: 2"));
  assert.ok(v.lines.includes("rent reclaimed sol: 0.0081 SOL"));
  assert.deepEqual(v.errors, ["closed: BONK: no route", "closed: WIF: no route"]);
  assert.equal(v.problems.length, 1);
  assert.match(v.problems[0], /2 positions could not be sold/);
  assert.ok(!v.lines.some((l) => l.startsWith("ok")), "ok is the status pill's job");
});

test("an explicit stopped:false / positionsLeft is a problem too", () => {
  const v = describeResult(JSON.stringify({ ok: true, amountSol: 1, stopped: false, positionsLeft: 1 }));
  assert.deepEqual(v.problems, ["1 position still open.", "The agent was not stopped: it keeps copying."]);
});

test("a clean withdrawal has no problems", () => {
  const v = describeResult(JSON.stringify({ ok: true, amountSol: 1.5, signature: SIG, closed: { sold: 4, failed: 0, errors: [] }, stopped: true }));
  assert.deepEqual(v.problems, []);
  assert.deepEqual(v.errors, []);
});

test("close_all: 'sold' is a count, not SOL; error strings are listed", () => {
  const v = describeResult(JSON.stringify({ ok: false, error: "2 position(s) could not be sold", sold: 3, failed: 2, errors: ["A: no route", "B: slippage"] }));
  assert.ok(v.lines.includes("sold: 3"), `got ${JSON.stringify(v.lines)}`);
  assert.ok(!v.lines.some((l) => l.includes("SOL") && l.startsWith("sold")));
  assert.deepEqual(v.errors, ["2 position(s) could not be sold", "A: no route", "B: slippage"]);
  assert.match(v.problems[0], /2 positions could not be sold/);
});

test("paper signatures are not linked; plain text results pass through", () => {
  const v = describeResult(JSON.stringify({ ok: true, mode: "paper", signature: `paper_${"a".repeat(70)}` }));
  assert.deepEqual(v.signatures, []);
  assert.deepEqual(describeResult("worker crashed").lines, ["worker crashed"]);
  assert.deepEqual(describeResult(null).lines, []);
});

test("a sent-but-unconfirmed transfer is 'confirming', not an error; a clamped amount is a problem", () => {
  const pending = describeResult(JSON.stringify({ ok: false, pending: true, error: "transfer sent; confirmation pending", signature: "5".repeat(88), amountSol: 1 }));
  assert.equal(pending.pendingOnChain, true);
  assert.deepEqual(pending.errors, []);
  assert.equal(pending.signatures.length, 1);
  const clamped = describeResult(JSON.stringify({ ok: true, mode: "paper", amountSol: 0.7, requestedSol: 1, clamped: true }));
  assert.equal(clamped.pendingOnChain, false);
  assert.ok(clamped.problems.some((p) => /instead of the 1.00 SOL asked/.test(p)), clamped.problems.join(" | "));
});
