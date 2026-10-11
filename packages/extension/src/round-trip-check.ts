// A self-test line from one timed request over one transport.
//
// Kept free of `chrome` so the wording is testable. The wording carries the
// diagnosis: an answer — even a refusal — proves the path both ways, and a
// failure says what the channel saw, including the TSP channel's "no frame
// arrived" (the reply was lost before the wallet) versus "declined" (it came
// and was refused here).

import type { DiagnosticCheck } from "./bridge-protocol.js";

export type ProbeOutcome =
  | { kind: "answered"; ms: number; refusal?: { code: string; message: string } }
  | { kind: "failed"; ms: number; code?: string; message: string }
  | { kind: "skipped"; reason: string };

const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

export function roundTripCheck(transport: string, outcome: ProbeOutcome): DiagnosticCheck {
  const id = `vta.roundtrip.${transport.toLowerCase()}`;
  const label = `Agent answers over ${transport}`;
  if (outcome.kind === "skipped") {
    return { id, label, status: "skip", detail: outcome.reason };
  }
  if (outcome.kind === "answered") {
    if (outcome.refusal) {
      // The transport works; the agent said no. A pass for this check, with
      // the refusal in plain sight, because it is the next thing to fix.
      return {
        id,
        label,
        status: "pass",
        detail:
          `The agent answered in ${secs(outcome.ms)}, refusing the request: ${outcome.refusal.message}. ` +
          `The path works both ways; the refusal is about this wallet's authority at the agent.`,
        code: outcome.refusal.code,
      };
    }
    return { id, label, status: "pass", detail: `The agent answered in ${secs(outcome.ms)}.` };
  }
  return {
    id,
    label,
    status: "fail",
    detail: `No answer after ${secs(outcome.ms)}: ${outcome.message}`,
    ...(outcome.code ? { code: outcome.code } : {}),
    remediation:
      transport === "REST"
        ? "Check the agent's REST endpoint and this wallet's sign-in to it."
        : "The request left this wallet. Check the agent's log for the reply it sent " +
          "(`failed to send TSP reply`, or the reply's route) and the mediator's traffic " +
          "for this wallet's account.",
  };
}
