// Run: npx tsx --test src/worker/watchset.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { isValidSolanaAddress } from "@/lib/solana";
import { balanceRefreshDue, FAST_POLL_MS, FAST_POLL_WINDOW_MS, pollDelayMs } from "./schedule";
import { transactionSubscribeParams } from "./txstream";
import { composeWatchSet, walletSetKey } from "./watchset";

const A = "Beqv6dzTcjV2eodo8RRXCiCcnSYrS1vkQKhfqwHXqeit";
const B = "EC2f5DnHzuNRit1ExqghSifDbp1wgrzktsRRZCtU92MJ";
const C = "CpKuhcFHogvrq7Fx3enu57xTRkh1WyzER1TVVBimC5mo";

test("watch set = followed traders ∪ traders an agent still holds a sleeve from", () => {
  const followed = [
    { id: "t1", wallet: A, lastSignature: "sigA" },
    { id: "t2", wallet: B, lastSignature: null },
  ];
  const held = [
    { id: "t2", wallet: B, lastSignature: null }, // followed and held
    { id: "t3", wallet: C, lastSignature: "sigC" }, // unfollowed, sleeve still open → must stay watched
  ];
  const set = composeWatchSet(followed, held, isValidSolanaAddress);
  assert.deepEqual([...set.keys()], [A, B, C]);
  assert.deepEqual(set.get(A), { id: "t1", wallet: A, lastSignature: "sigA", followed: true, holding: false });
  assert.deepEqual(set.get(B), { id: "t2", wallet: B, lastSignature: null, followed: true, holding: true });
  assert.deepEqual(set.get(C), { id: "t3", wallet: C, lastSignature: "sigC", followed: false, holding: true });
});

test("watch set: empty inputs, duplicates and invalid wallets", () => {
  assert.equal(composeWatchSet([], [], isValidSolanaAddress).size, 0);
  const set = composeWatchSet(
    [
      { id: "t1", wallet: A, lastSignature: null },
      { id: "t1", wallet: A, lastSignature: null },
      { id: "bad", wallet: "not-a-wallet", lastSignature: null },
    ],
    [{ id: "bad2", wallet: "", lastSignature: null }],
    isValidSolanaAddress,
  );
  assert.deepEqual([...set.keys()], [A]);
  // held-only traders are watched even with no follower at all
  const heldOnly = composeWatchSet([], [{ id: "t3", wallet: C, lastSignature: null }], isValidSolanaAddress);
  assert.equal(heldOnly.get(C)?.followed, false);
  assert.equal(heldOnly.get(C)?.holding, true);
});

test("walletSetKey is order-independent and deduplicated", () => {
  assert.equal(walletSetKey([B, A, B]), walletSetKey([A, B]));
  assert.notEqual(walletSetKey([A]), walletSetKey([A, B]));
  assert.equal(walletSetKey([]), "");
});

test("stream filter: accountInclude = watched wallets, no accountRequired (sells on any venue), accounts details, v1", () => {
  const [filter, options] = transactionSubscribeParams([A, B]) as [Record<string, unknown>, Record<string, unknown>];
  assert.deepEqual(filter, { accountInclude: [A, B], failed: false, vote: false });
  assert.equal("accountRequired" in filter, false);
  assert.equal(options.commitment, "confirmed");
  assert.equal(options.encoding, "jsonParsed");
  assert.equal(options.transactionDetails, "accounts");
  assert.equal(options.maxSupportedTransactionVersion, 1);
});

test("poll cadence: WORKER_POLL_MS normally, 5 s during the 2-minute window after a reconnect", () => {
  const now = 1_000_000;
  assert.equal(pollDelayMs(now, 0, 60_000), 60_000);
  assert.equal(pollDelayMs(now, now + FAST_POLL_WINDOW_MS, 60_000), FAST_POLL_MS);
  assert.equal(pollDelayMs(now + FAST_POLL_WINDOW_MS, now + FAST_POLL_WINDOW_MS, 60_000), 60_000);
  assert.equal(FAST_POLL_MS, 5_000);
  assert.equal(FAST_POLL_WINDOW_MS, 120_000);
  // a base faster than 5 s is kept; a broken base falls back to 60 s
  assert.equal(pollDelayMs(now, now + 1, 2_000), 2_000);
  assert.equal(pollDelayMs(now, 0, Number.NaN), 60_000);
});

test("balance cadence: awaiting_deposit 30 s, active/paused 300 s, never for stopped", () => {
  const now = 10_000_000;
  assert.equal(balanceRefreshDue("awaiting_deposit", null, now), true);
  assert.equal(balanceRefreshDue("awaiting_deposit", new Date(now - 29_000), now), false);
  assert.equal(balanceRefreshDue("awaiting_deposit", new Date(now - 30_000), now), true);
  assert.equal(balanceRefreshDue("active", new Date(now - 299_000), now), false);
  assert.equal(balanceRefreshDue("active", now - 300_000, now), true);
  assert.equal(balanceRefreshDue("paused", new Date(now - 301_000), now), true);
  assert.equal(balanceRefreshDue("stopped", null, now), false);
  assert.equal(balanceRefreshDue("weird", null, now), false);
});
