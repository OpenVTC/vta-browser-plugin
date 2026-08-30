// The self-test report as text — see src/diagnostics-report.ts.
//
// The report is the artefact the whole feature produces: it gets pasted to
// whoever runs the failing service, who has no access to the browser it came
// from. So what is tested here is that it survives that trip — the origin,
// the failing check's own words, and the fix all present in plain text.

import test from "node:test";
import assert from "node:assert/strict";
import {
  formatReport,
  overallStatus,
  verdict,
} from "../src/diagnostics-report.ts";
import type { DiagnosticsReport } from "../src/bridge-protocol.ts";

const REPORT: DiagnosticsReport = {
  vtaDid: "did:webvh:abc:agent.example",
  extensionOrigin: "chrome-extension://dbjgfkjlgfamanmbiihldgncpjeknphl",
  generatedAt: "2026-08-30T06:57:00.000Z",
  checks: [
    {
      id: "vta.resolve",
      label: "Trust agent DID resolves",
      status: "pass",
      detail: "Advertises TSP, DIDComm, REST.",
    },
    {
      id: "mediator.TSP+DIDComm.origin",
      label: "TSP+DIDComm mediator accepts this wallet's origin",
      status: "fail",
      detail: "The mediator at https://mediator.example is up and answering, but refused this request.",
      code: "mediator/origin-not-allowed",
      remediation: "Add the origin to `[security] cors_allow_origin` and restart.",
    },
  ],
};

test("the origin an operator must allowlist is in the text", () => {
  // The single most-retyped string in the whole exchange. If it survives
  // nothing else, it has to survive this.
  assert.match(formatReport(REPORT), /chrome-extension:\/\/dbjgfkjlgfamanmbiihldgncpjeknphl/);
});

test("a failing check carries its own words, its code and its fix", () => {
  const text = formatReport(REPORT);
  assert.match(text, /\[FAIL\] TSP\+DIDComm mediator accepts this wallet's origin/);
  assert.match(text, /up and answering, but refused this request/);
  assert.match(text, /code: mediator\/origin-not-allowed/);
  assert.match(text, /fix: Add the origin to/);
});

test("passing checks are kept, not filtered out", () => {
  // The checks that passed are what tell the recipient the fault is theirs
  // and not, say, DNS — a report of only failures is missing its own context.
  assert.match(formatReport(REPORT), /\[PASS\] Trust agent DID resolves/);
});

test("one failure decides the verdict", () => {
  assert.equal(overallStatus(REPORT.checks), "fail");
  assert.match(verdict(REPORT), /broken/);
});

test("a skipped transport is not a fault", () => {
  // A VTA that advertises no mediator legitimately skips those checks; a
  // report that called that a failure would send someone chasing nothing.
  const checks = [
    { id: "a", label: "a", status: "pass" as const, detail: "" },
    { id: "b", label: "b", status: "skip" as const, detail: "" },
  ];
  assert.equal(overallStatus(checks), "pass");
});

test("warn outranks pass but not fail", () => {
  assert.equal(
    overallStatus([
      { id: "a", label: "a", status: "pass", detail: "" },
      { id: "b", label: "b", status: "warn", detail: "" },
    ]),
    "warn",
  );
  assert.equal(
    overallStatus([
      { id: "a", label: "a", status: "warn", detail: "" },
      { id: "b", label: "b", status: "fail", detail: "" },
    ]),
    "fail",
  );
});

test("an empty report does not claim everything passed", () => {
  assert.equal(overallStatus([]), "skip");
});
