// The management console's relay must not be reachable from a web page.
//
// `RUNTIME_MANAGER_TASK` runs admin tasks — granting authority at an agent,
// revoking it, destroying contexts — and, unlike the page-facing relay, it does
// not stop to ask a human first. Two things keep a page away from it, and
// neither fails loudly on its own:
//
//  1. It must be absent from `PAGE_FACING_RUNTIME_TYPES`. Membership there is
//     not a permission grant, but it is the list that says "a page originates
//     this", and adding it would be the first step of treating it that way.
//  2. It must be absent from `content.ts`'s dispatch table, which is the only
//     bridge a page has. The content script inlines its constants by hand (it
//     bundles as a classic script and cannot import), so nothing but a test
//     notices a new entry.
//
// And the background must gate on the sender being an extension page: every
// content script carries this extension's id, so `sender.id` cannot separate
// them and `sender.url` is what does.
//
// Reads the sources rather than importing them, the way
// `page-facing-surface.test.mts` does — `content.ts` touches `chrome` at module
// scope and `background.ts` registers listeners on import.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const src = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../src/${name}`, import.meta.url)), "utf8");

const protocol = src("bridge-protocol.ts");
const content = src("content.ts");
const background = src("background.ts");

/** The literal wire value, so the assertions below check the string a message
 *  actually carries rather than the identifier naming it. */
const MANAGER_TYPE = "vta-wallet/manager-task";

test("the console's wire type is what bridge-protocol declares", () => {
  assert.match(
    protocol,
    new RegExp(`export const RUNTIME_MANAGER_TASK =\\s*"${MANAGER_TYPE}"`),
    "RUNTIME_MANAGER_TASK's value changed — every assertion here reads the literal, " +
      "and the console and background must agree on it",
  );
});

test("the console's relay is not page-facing", () => {
  const m = /export const PAGE_FACING_RUNTIME_TYPES = \[([^\]]*)\]/.exec(protocol);
  assert.ok(m, "PAGE_FACING_RUNTIME_TYPES not found — this test is reading the wrong shape");
  const members = m[1]!
    .split(",")
    .map((s) => s.replace(/\/\/.*$/gm, "").trim())
    .filter(Boolean);
  assert.ok(
    !members.includes("RUNTIME_MANAGER_TASK"),
    "RUNTIME_MANAGER_TASK is listed as page-facing. That list is for messages a web page " +
      "originates; the console's relay runs admin tasks without a per-call human check, " +
      "and no page may originate one.",
  );
});

test("the content script cannot route to the console's relay", () => {
  assert.ok(
    !content.includes(MANAGER_TYPE),
    `content.ts mentions ${MANAGER_TYPE}. The content script is the only bridge a web page ` +
      "has; a route to the console's relay there hands an arbitrary page the operator's " +
      "authority.",
  );
});

test("the background gates the console's relay on an extension-page sender", () => {
  // The gate's substance, not its spelling: `sender.id` is true for a content
  // script too, so the check that matters is against the extension's own URL.
  assert.match(
    background,
    /function isExtensionPageSender\([\s\S]{0,400}?chrome\.runtime\.getURL\(""\)[\s\S]{0,200}?sender\.url[\s\S]{0,80}?startsWith/,
    "isExtensionPageSender no longer compares sender.url against chrome.runtime.getURL(\"\"). " +
      "sender.id is shared with every content script and cannot make this distinction.",
  );

  // …and that the gate is actually applied to this message type, before the
  // handler runs. An unguarded branch is the failure this whole file exists for.
  const branch =
    /RUNTIME_MANAGER_TASK\)\s*\{([\s\S]*?)handleManagerTask/.exec(background);
  assert.ok(branch, "no dispatch branch for RUNTIME_MANAGER_TASK found in background.ts");
  assert.match(
    branch[1]!,
    /if \(!isExtensionPageSender\(sender\)\)/,
    "the RUNTIME_MANAGER_TASK branch reaches handleManagerTask without checking " +
      "isExtensionPageSender first",
  );
});

test("the console's relay does not carry a page origin", () => {
  // `RuntimeRequestTaskRequest` has an `origin` member because a page proposed
  // the task and the browser's attested origin has to travel with it. The
  // console's request must NOT: there is no page, and a member here would be a
  // value the background could read instead of stamping its own.
  const m = /export interface RuntimeManagerTaskRequest \{([\s\S]*?)\}/.exec(protocol);
  assert.ok(m, "RuntimeManagerTaskRequest not found");
  assert.ok(
    !/\borigin\b/.test(m[1]!),
    "RuntimeManagerTaskRequest carries an `origin`. The console has no page origin to " +
      "report; the background stamps the extension's own, and a member here is a claim " +
      "waiting to be trusted.",
  );
});
