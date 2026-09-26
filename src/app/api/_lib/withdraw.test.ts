// Run: npx tsx --test src/app/api/_lib/withdraw.test.ts
// Withdraw requests: fee-aware ceiling, and "close positions first" only with "everything" (finding F37).
import "../../../lib/__testing__/env"; // first: keeps the real .env (keys, RPC URLs) out of this test
import { before, test } from "node:test";
import assert from "node:assert/strict";

type W = typeof import("./withdraw");
let w: W;
let HttpError: typeof import("@/lib/http").HttpError;

before(async () => {
  w = await import("./withdraw");
  ({ HttpError } = await import("@/lib/http"));
});

function isHttp(status: number, field?: string) {
  return (err: unknown) => {
    assert.ok(err instanceof HttpError, `expected HttpError, got ${String(err)}`);
    assert.equal(err.status, status);
    if (field) assert.ok(err.fields?.[field], `expected fields.${field}`);
    return true;
  };
}

const live = { withdrawableSol: 1.498, reserveSol: 0.002, feeOwedSol: 0.5, hasPositions: false };

test("F37: a set amount with 'close positions first' is refused while positions are held (nothing gets sold)", () => {
  assert.throws(() => w.planWithdraw({ ...live, hasPositions: true }, { amountSol: 1, closePositions: true }), isHttp(400, "closePositions"));
  // Everything + close positions is the supported way to sell first.
  assert.deepEqual(w.planWithdraw({ ...live, hasPositions: true }, { all: true, closePositions: true }), { all: true, closePositions: true });
  // Without positions close-first is a no-op: the amount goes through, and the worker is told not to sell.
  assert.deepEqual(w.planWithdraw(live, { amountSol: 1, closePositions: true }), { amountSol: 1, closePositions: false });
});

test("the ceiling is withdrawableSol (balance − fees owed − live buffer), never the raw balance", () => {
  // balance 2.0, owed 0.5, buffer 0.002 → 1.498 withdrawable
  assert.deepEqual(w.planWithdraw(live, { amountSol: 1.498 }), { amountSol: 1.498, closePositions: false });
  assert.throws(
    () => w.planWithdraw(live, { amountSol: 1.6 }),
    (err: unknown) => {
      assert.ok(err instanceof HttpError && err.status === 400);
      assert.match(err.message, /at most 1\.498 SOL/);
      assert.match(err.message, /platform fees owed/);
      assert.ok(err.fields?.amountSol);
      return true;
    },
  );
});

test("everything: refused when nothing is withdrawable and nothing will be sold", () => {
  assert.throws(() => w.planWithdraw({ ...live, withdrawableSol: 0 }, { all: true }), isHttp(400));
  assert.deepEqual(w.planWithdraw({ ...live, withdrawableSol: 0, hasPositions: true }, { all: true, closePositions: true }), {
    all: true,
    closePositions: true,
  });
  assert.deepEqual(w.planWithdraw(live, { all: true }), { all: true, closePositions: false });
});

test("amounts are whole lamports; missing amount is a 400", () => {
  assert.deepEqual(w.planWithdraw({ ...live, withdrawableSol: 5 }, { amountSol: 0.1234567891234 }), { amountSol: 0.123456789, closePositions: false });
  assert.throws(() => w.planWithdraw(live, {}), isHttp(400, "amountSol"));
});
