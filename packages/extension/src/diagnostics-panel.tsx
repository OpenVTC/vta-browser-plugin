/// <reference types="chrome" />

// The connection self-test, as a panel.
//
// This exists because the failure it was built for could not be diagnosed
// from inside the wallet at all: a mediator refusing the extension's origin
// produced two `console.warn`s on a page no ordinary user opens, and finding
// the cause meant running `curl` against a server the user did not operate.
// Worse, `curl` cannot reproduce it — a terminal sends no `Origin` header, so
// the endpoint answers perfectly and the operator concludes nothing is wrong.
//
// The wallet is the only place that can ask the question truthfully, so it
// asks, and produces text for the person who can act on the answer.

import { useState } from "react";
import {
  RUNTIME_RUN_DIAGNOSTICS,
  type DiagnosticCheck,
  type DiagnosticsReport,
  type RuntimeRunDiagnosticsResponse,
} from "./bridge-protocol.js";
import { formatReport, overallStatus, verdict } from "./diagnostics-report.js";
import { c, t } from "./theme.js";
import { Button, Panel, Pill } from "./ui.js";
import type { PillTone } from "./theme.js";

const TONE: Record<DiagnosticCheck["status"], PillTone> = {
  pass: "ok",
  fail: "danger",
  warn: "warn",
  skip: "off",
};

export function DiagnosticsPanel({ vtaDid }: { vtaDid: string | undefined }) {
  const [report, setReport] = useState<DiagnosticsReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function run() {
    if (!vtaDid) return;
    setBusy(true);
    setError(null);
    setCopied(false);
    try {
      const res = (await chrome.runtime.sendMessage({
        type: RUNTIME_RUN_DIAGNOSTICS,
        vtaDid,
      })) as RuntimeRunDiagnosticsResponse;
      if (res.ok) setReport(res.result);
      else setError(res.error);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!report) return;
    try {
      await navigator.clipboard.writeText(formatReport(report));
      setCopied(true);
    } catch {
      // Clipboard can be refused; the text is on screen and selectable, so
      // there is nothing to recover from and an error here would be noise.
    }
  }

  return (
    <Panel
      title="Connection self-test"
      description="Checks the chain this wallet depends on, from the wallet's own origin — which is the only place the answer is true."
    >
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <Button onClick={run} disabled={busy || !vtaDid} kind="primary">
          {busy ? "Running…" : "Run checks"}
        </Button>
        {report && (
          <Button onClick={copy} kind="quiet">
            {copied ? "Copied" : "Copy report"}
          </Button>
        )}
        {!vtaDid && (
          <span style={{ fontSize: t.sm, color: c.muted }}>Connect a trust agent first.</span>
        )}
      </div>

      {error && (
        <div style={{ fontSize: t.sm, color: c.danger }}>{error}</div>
      )}

      {report && (
        <>
          <div style={{ fontSize: t.sm, color: c.muted }}>
            {verdict(report)}{" "}
            {overallStatus(report.checks) === "fail" && (
              <>
                Most of these are fixed by whoever runs the service, not from this
                browser — use <strong style={{ color: c.text }}>Copy report</strong> and send it
                to them.
              </>
            )}
          </div>

          <div style={{ display: "grid", gap: 8 }}>
            {report.checks.map((check) => (
              <div
                key={check.id}
                style={{
                  display: "grid",
                  gap: 4,
                  padding: "8px 10px",
                  border: `1px solid ${c.line}`,
                  borderRadius: 8,
                }}
              >
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <Pill tone={TONE[check.status]}>{check.status}</Pill>
                  <span style={{ fontSize: t.sm, color: c.text }}>{check.label}</span>
                </div>
                <div style={{ fontSize: t.sm, color: c.muted }}>{check.detail}</div>
                {check.remediation && (
                  <div style={{ fontSize: t.sm, color: c.muted }}>
                    <strong style={{ color: c.text }}>Fix:</strong> {check.remediation}
                  </div>
                )}
                {check.code && (
                  <div style={{ fontSize: t.xs, color: c.faint, fontFamily: "ui-monospace, monospace" }}>
                    {check.code}
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* The origin, on its own, because it is the one string an operator
              has to copy exactly and the one most often retyped wrong. */}
          <div style={{ fontSize: t.xs, color: c.muted }}>
            This wallet&apos;s origin:{" "}
            <code style={{ color: c.text }}>{report.extensionOrigin}</code>
          </div>
        </>
      )}
    </Panel>
  );
}
