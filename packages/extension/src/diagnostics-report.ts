// Rendering a self-test result as text someone can paste.
//
// Separated from the panel that shows it, and free of React and `chrome`, for
// the same reason `transports.ts` is: this is the artefact the whole feature
// exists to produce. The person who can fix a mediator's CORS allowlist is
// usually not the person looking at the wallet, so the report has to survive
// being copied into a chat window and read by someone with no access to the
// browser it came from — which means it must carry the origin, the hosts, and
// the failing check's own words, not a screenshot's worth of context.

import type { DiagnosticCheck, DiagnosticsReport, DiagnosticStatus } from "./bridge-protocol.js";

const MARK: Record<DiagnosticStatus, string> = {
  pass: "PASS",
  fail: "FAIL",
  warn: "WARN",
  skip: "SKIP",
};

/** Worst status in the report, for a one-line verdict. `skip` never counts as
 *  a problem — a transport the agent does not advertise is not a fault. */
export function overallStatus(checks: readonly DiagnosticCheck[]): DiagnosticStatus {
  if (checks.some((c) => c.status === "fail")) return "fail";
  if (checks.some((c) => c.status === "warn")) return "warn";
  if (checks.some((c) => c.status === "pass")) return "pass";
  return "skip";
}

/** A one-sentence verdict, written for whoever receives the paste. */
export function verdict(report: DiagnosticsReport): string {
  switch (overallStatus(report.checks)) {
    case "fail":
      return "Something in the chain is broken — the failing checks below say which link and what to change.";
    case "warn":
      return "Reachable, but not everything this wallet needs is running.";
    case "pass":
      return "Every check passed.";
    default:
      return "Nothing to check.";
  }
}

/**
 * The report as plain text.
 *
 * Deliberately not Markdown-heavy: it gets pasted into chat clients, terminals
 * and issue trackers that each render it differently, and a report whose
 * meaning depends on being rendered is one that arrives mangled.
 */
export function formatReport(report: DiagnosticsReport): string {
  const lines: string[] = [];
  lines.push("VTA wallet connection self-test");
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Trust agent: ${report.vtaDid}`);
  // The single most useful line for the recipient: the string they allowlist.
  lines.push(`Wallet origin: ${report.extensionOrigin}`);
  lines.push("");
  lines.push(verdict(report));
  lines.push("");

  for (const check of report.checks) {
    lines.push(`[${MARK[check.status]}] ${check.label}`);
    lines.push(`       ${check.detail}`);
    if (check.code) lines.push(`       code: ${check.code}`);
    if (check.remediation) lines.push(`       fix: ${check.remediation}`);
  }

  return lines.join("\n");
}
