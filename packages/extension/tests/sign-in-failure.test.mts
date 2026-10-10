// The "Details" line and the console line for a failed sign-in say the same
// thing, and nothing but a stage, a party and a stable code.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { failureDetails, failureLogFields, safeCode } from "../src/sign-in-failure.ts";

const FAILED = {
  kind: "failed" as const,
  code: "sign-in/failed",
  message: "This code can't be used. Refresh the code on the website and try again.",
  stage: "prove" as const,
  party: "community" as const,
  cause: "numberMismatch",
};

test("details list the code, its cause, the step and who refused", () => {
  const rows = Object.fromEntries(failureDetails(FAILED));
  assert.equal(rows.Code, "sign-in/failed");
  assert.equal(rows.Cause, "numberMismatch");
  assert.match(rows.Step!, /^prove/);
  assert.equal(rows["Refused by"], "the community");
});

test("a bare failure shows only its code", () => {
  assert.deepEqual(failureDetails({ kind: "failed", code: "alreadyClaimed", message: "m" }), [["Code", "alreadyClaimed"]]);
});

test("the console line carries the step and the same fields, and never the message", () => {
  const fields = failureLogFields("prove", FAILED);
  assert.deepEqual(fields, { step: "prove", code: "sign-in/failed", cause: "numberMismatch", stage: "prove", party: "community" });
  assert.equal(JSON.stringify(fields).includes("Refresh"), false);
});

test("only code-shaped strings pass as a code", () => {
  assert.equal(safeCode("oobDeviceDisabled"), "oobDeviceDisabled");
  assert.equal(safeCode("auth/oob/reply-invalid"), "auth/oob/reply-invalid");
  assert.equal(safeCode("the VTA changed the document"), undefined);
  assert.equal(safeCode("https://x.example/?token=abc"), undefined);
  assert.equal(safeCode({ code: "x" }), undefined);
  assert.equal(safeCode("x".repeat(200)), undefined);
});

test("the background logs every failed step through the one formatter", () => {
  // The background is a service worker and is not rendered here; this pins
  // that its console line is built from `failureLogFields` and nothing else.
  const src = readFileSync(new URL("../src/background.ts", import.meta.url), "utf8");
  assert.match(src, /console\.warn\("\[pnm sign-in\] step failed", failureLogFields\(msg\.step, res\.result\)\)/);
});
