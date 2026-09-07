// What a web page may ask the wallet to run.
//
// The case that matters is not "an unknown task is refused" — it is that a
// *known, working, consent-prompted* task is refused, because the prompt it
// would get cannot say what it would give away.

import { test } from "node:test";
import assert from "node:assert/strict";

import { pageTaskRefusal } from "../src/page-task-policy.ts";

const P = "https://trusttasks.org/spec/persona/";

// `preview` is the dangerous one and reads as the safe one. It is documented as
// "signs nothing and sends nothing" — true of the VTA, and irrelevant here,
// because `requestTask` hands the VTA's reply to the page. The reply contains
// the holder's claim values.
test("a page cannot preview a disclosure, whatever the task says about itself", () => {
  const why = pageTaskRefusal(`${P}disclosure/preview/1.0`);
  assert.notEqual(why, null);
  assert.match(why, /disclosure flow/);
});

test("a page cannot present a disclosure", () => {
  assert.notEqual(pageTaskRefusal(`${P}disclosure/present/1.0`), null);
});

// The same shape aimed at other people: the holder's record of what their peers
// disclosed to them.
test("a page cannot read the holder's contacts", () => {
  for (const verb of ["get", "list", "put", "delete"]) {
    assert.notEqual(
      pageTaskRefusal(`${P}contact/${verb}/1.0`),
      null,
      `contact/${verb} should be refused`,
    );
  }
});

// The whole family, so a task added later is refused by default rather than
// admitted by omission — which is the direction this guard must fail in.
test("the refusal covers the family, not a list of known members", () => {
  assert.notEqual(pageTaskRefusal(`${P}some/future/task/9.9`), null);
});

// And it must not become a blanket ban: the wallet's other page-facing tasks
// are the reason `requestTask` exists.
test("tasks outside the family are still a page's to request", () => {
  for (const uri of [
    "https://trusttasks.org/spec/vault/list/0.3",
    "https://trusttasks.org/spec/auth/authenticate/0.1",
    "https://trusttasks.org/spec/vta/app-state/get/1.0",
  ]) {
    assert.equal(pageTaskRefusal(uri), null, `${uri} should be permitted`);
  }
});

// A refusal that does not say what to do instead gets worked around, and the
// workaround is usually worse than the thing refused.
test("the refusal names the route that exists instead", () => {
  const why = pageTaskRefusal(`${P}disclosure/present/1.0`);
  assert.match(why, /shows the holder/);
  assert.match(why, /returns the presentation rather than the underlying values/);
});
