// Who still holds a value you have since changed.
//
// The rules that carry the feature: `unknown` is never current; `removed` is
// not `changed`; and only the latest disclosure to a relationship decides
// whether that relationship is outdated.

import { test } from "node:test";
import assert from "node:assert/strict";
import { currencyOf, outdatedHolders, currencyWords } from "../src/manager/disclosure-currency.ts";

const record = (extra: Record<string, unknown>) =>
  ({
    disclosureId: "01D",
    contextId: "ctx",
    verifierDid: "did:v",
    personaDid: "did:p",
    claimTypes: ["name.display"],
    disclosedAt: "2026-09-01T00:00:00Z",
    ...extra,
  }) as never;

test("an agent that says nothing leaves every claim unknown, never current", () => {
  assert.deepEqual(currencyOf(record({ claimTypes: ["a", "b"] })), [
    { claimType: "a", currency: "unknown" },
    { claimType: "b", currency: "unknown" },
  ]);
  // A value this build does not recognise is not promoted to current either.
  assert.deepEqual(currencyOf(record({ claimCurrency: ["stale"] })), [
    { claimType: "name.display", currency: "unknown" },
  ]);
});

test("only changed claims make the re-present list — removed ones do not", () => {
  const list = outdatedHolders([
    record({ claimTypes: ["name.display", "phone.mobile"], claimCurrency: ["changed", "removed"] }),
  ]);
  assert.equal(list.length, 1);
  assert.deepEqual(list[0].claimTypes, ["name.display"], "a removed claim has nothing newer to send");
  assert.equal(outdatedHolders([record({ claimCurrency: ["removed"] })]).length, 0);
  assert.equal(outdatedHolders([record({ claimCurrency: ["current"] })]).length, 0);
});

test("the latest disclosure to a relationship decides it", () => {
  // Re-sent the new value after an older disclosure: not outdated, though the
  // older record still reads `changed`.
  const older = record({ disclosureId: "01A", disclosedAt: "2026-09-01T00:00:00Z", claimCurrency: ["changed"] });
  const newer = record({ disclosureId: "01B", disclosedAt: "2026-09-10T00:00:00Z", claimCurrency: ["current"] });
  assert.equal(outdatedHolders([older, newer]).length, 0);
  assert.equal(outdatedHolders([newer, older]).length, 0, "order of the history must not matter");

  // The same verifier in another context is another relationship.
  const elsewhere = record({ contextId: "ctx-2", claimCurrency: ["changed"] });
  assert.deepEqual(
    outdatedHolders([older, newer, elsewhere]).map((o) => o.contextId),
    ["ctx-2"],
  );
});

test("current needs no words; the others each say what they mean", () => {
  assert.equal(currencyWords("current"), null);
  assert.match(currencyWords("changed")!, /older value/);
  assert.match(currencyWords("removed")!, /keep what they got/);
  assert.match(currencyWords("unknown")!, /cannot say/);
});

test("an edit says where it landed, and says nothing when the agent did not", async () => {
  const { editReachWords } = await import("../src/manager/disclosure-currency.ts");
  assert.equal(editReachWords({}), null, "an older agent claims nothing either way");
  assert.equal(
    editReachWords({
      refreshed: [
        { profileId: "01A", contextId: "ctx-1" },
        { profileId: "01A", contextId: "ctx-2" },
        { profileId: "01B", contextId: "ctx-2" },
      ],
      heldByPin: [{ profileId: "01C" }],
    }),
    "Now shown in 3 places across 2 contexts. 1 face pins the earlier value and keeps showing it — that is what pinning is for.",
  );
});
