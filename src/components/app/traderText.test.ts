// Pure text helpers behind the trader UI: names, lookup notes, what gets copied, and the leaderboard query.

import assert from "node:assert/strict";
import { test } from "node:test";
import { tradersQuery } from "@/app/api/_lib/schemas";
import { copiesLine } from "./create/StepReview";
import { fomoProfileUrl, traderHref, traderName, xProfileUrl } from "./TraderIdentity";
import { lookupMissText, lookupNoteText } from "./TraderLookup";

const W = "7LoRpjZ1wS3dG1v3CUKi2mz5eB6sBy1SFFtBNGeBENhz";

test("traderName: display name, else @handle, else 'Wallet 7LoR…BENhz'", () => {
  assert.equal(traderName({ wallet: W, handle: "RZDxbt", displayName: "RZD" }), "RZD");
  assert.equal(traderName({ wallet: W, handle: "RZDxbt", displayName: null }), "@RZDxbt");
  assert.equal(traderName({ wallet: W, handle: null, displayName: null }), "Wallet 7LoR…BENhz");
});

test("outbound links are encoded and point where they say", () => {
  assert.equal(fomoProfileUrl("sad.crissy"), "https://fomo.family/profile/sad.crissy");
  assert.equal(xProfileUrl("a b"), "https://x.com/a%20b");
  assert.equal(traderHref(W), `/traders/${W}`);
});

test("lookup notes: honest caveats, venue-aware", () => {
  assert.equal(lookupNoteText(null, "fomo"), null);
  assert.match(lookupNoteText("no_fomo_activity", "fomo") ?? "", /Agents copy FOMO buys only/);
  assert.doesNotMatch(lookupNoteText("no_fomo_activity", "all") ?? "", /FOMO buys only/);
  assert.equal(lookupNoteText("check_unavailable", "fomo"), "Couldn't check this wallet right now — you can still add it.");
  assert.equal(lookupNoteText("unknown_handle", "fomo"), null);
});

test("lookup miss: handles resolve only from our list", () => {
  assert.equal(
    lookupMissText("@someone"),
    "We don't have a wallet for @someone. We only resolve handles for wallets on our list — paste their Solana wallet instead.",
  );
  assert.equal(lookupMissText("someone"), lookupMissText("@someone"));
  assert.match(lookupMissText("not a wallet!"), /isn't a Solana wallet or a handle we know/);
});

test("review line says what is (not) copied", () => {
  const one = copiesLine(1, "fomo");
  assert.match(one, /^Copies this trader's FOMO buys on Solana and their sells of tokens your agent holds\./);
  assert.match(one, /Cross-chain FOMO trades \(Base, BNB, Robinhood Chain…\) and trades made in other apps are not copied\./);
  assert.match(copiesLine(2, "fomo"), /^Copies these traders'/);
  assert.match(copiesLine(1, "all"), /in FOMO or any other app/);
});

test("leaderboard query: 24h/7d/30d, 'all' → 30d, limit clamped", () => {
  assert.deepEqual(tradersQuery.parse({}), { window: "24h", limit: 50 });
  assert.deepEqual(tradersQuery.parse({ window: "all" }), { window: "30d", limit: 50 });
  assert.deepEqual(tradersQuery.parse({ window: "7d", limit: "999" }), { window: "7d", limit: 150 });
  assert.equal(tradersQuery.safeParse({ window: "1y" }).success, false);
});
