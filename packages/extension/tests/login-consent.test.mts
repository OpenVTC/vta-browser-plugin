// A sign-in that binds a session key is always asked, and the prompt says so.

import { test } from "node:test";
import assert from "node:assert/strict";
import { h, render } from "./harness/dom.mjs";
import { promptMayRemember, trustMaySkipPrompt } from "../src/login-consent.js";
import { SessionKeyNotice } from "../src/session-key-notice.js";

const KEY = "did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH";

test("a remembered site signs in without a prompt when nothing else is asked", () => {
  assert.equal(trustMaySkipPrompt({}), true);
  assert.equal(promptMayRemember({}), true);
});

test("a session key is always asked, and offers nothing to remember", () => {
  assert.equal(trustMaySkipPrompt({ sessionKey: KEY }), false);
  assert.equal(promptMayRemember({ sessionKey: KEY }), false);
});

test("a changed relying party or address is still always asked", () => {
  assert.equal(trustMaySkipPrompt({ changedFromRpDid: "did:web:old.example" }), false);
  assert.equal(trustMaySkipPrompt({ changedFromBaseUrl: "https://old.example/api" }), false);
});

test("the prompt tells the user the site gets a session key, and what it cannot do", async () => {
  const ui = await render(h(SessionKeyNotice, { sessionKey: KEY }));
  const text = ui.text();
  assert.match(text, /This site will get a session key/);
  assert.match(text, /without asking the wallet again/);
  assert.match(text, /cannot approve a step-up/);
  assert.ok(text.includes(KEY), "the key itself is shown");
  await ui.unmount();
});
