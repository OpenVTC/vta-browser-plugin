// What the console says about values kept for a pinned face.

import { test } from "node:test";
import assert from "node:assert/strict";
import { keptVersions, keptWords, purgeConsequence } from "../src/manager/kept-versions.ts";

const attr = (retained?: unknown) =>
  ({ attributeId: "01A", type: "name.legal", version: 9, ...(retained ? { retainedVersions: retained } : {}) }) as never;
const FACES = [{ profileId: "01B", name: "Bank" }, { profileId: "01T", name: "Tax office" }];

test("an agent that keeps nothing, or predates the member, says nothing", () => {
  assert.deepEqual(keptVersions(attr(), FACES), []);
  assert.equal(keptWords([]), null);
});

test("kept versions are named by the faces that are the reason", () => {
  const kept = keptVersions(attr([{ version: 3, pinnedBy: ["01B", "01T"] }]), FACES);
  assert.deepEqual(kept, [{ version: 3, faces: ["Bank", "Tax office"] }]);
  assert.equal(
    keptWords(kept),
    "An earlier value is still kept, because Bank and Tax office are pinned to it.",
  );
});

test("purging says the faces show nothing — not the new value", () => {
  // The misreading this exists to prevent: "remove the old name" heard as
  // "update the bank".
  const words = purgeConsequence([{ version: 3, faces: ["Bank"] }]);
  assert.match(words, /Bank will show nothing/);
  assert.match(words, /not the current value/);
  assert.match(words, /already shown the old value keeps it/);
});

test("a face the console does not hold is still counted", () => {
  const kept = keptVersions(attr([{ version: 3, pinnedBy: ["01Z"] }]), FACES);
  assert.deepEqual(kept[0].faces, ["a face"]);
});
