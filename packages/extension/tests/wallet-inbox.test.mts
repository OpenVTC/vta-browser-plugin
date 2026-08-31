// The wallet's inbox mediator — see src/config.ts and doOnboardConnect.
//
// Background: the inbox setting used to fall back to a hardcoded mediator DID
// on a domain no deployment in use here runs. The only writer was the advanced
// routing field in Setup, so every wallet whose operator never opened it sent
// its inbound traffic through a third party's demo host — while Setup told
// them the inbox had been "set up automatically from your agent". These pin
// both halves of the fix: onboarding actually adopts the agent's relay, and no
// mediator is baked into the source again.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { inboxToAdopt } from "../src/config.ts";
import { parseAgentMediatorDid } from "../src/active-vta.ts";

const AGENT = "did:webvh:QmAgentMediator:agent.example:mediator";
const OTHER = "did:webvh:QmOtherMediator:other.example:mediator";

test("adopts the agent's relay when the wallet has none", () => {
  assert.equal(inboxToAdopt({}, AGENT), AGENT);
});

test("leaves an inbox the operator chose", () => {
  // The operator running two relays picked this one on purpose.
  assert.equal(inboxToAdopt({ did: OTHER, source: "operator" }, AGENT), undefined);
});

test("a second onboarding does not move an address others already route to", () => {
  assert.equal(inboxToAdopt({ did: AGENT, source: "agent" }, OTHER), undefined);
});

test("an agent advertising no mediator leaves the inbox unset, not invented", () => {
  // Unset is reported by the self-test as "nothing can reach this wallet".
  // Substituting anything here is what caused the original defect.
  assert.equal(inboxToAdopt({}, undefined), undefined);
  assert.equal(inboxToAdopt({ did: "" }, undefined), undefined);
});

test("adopts over a stored inbox nobody is on record choosing", () => {
  // The case that defeated the first migration. `setSettings` merged the
  // DEFAULTED settings and wrote them back, so any unrelated write — the
  // passkey lock, the TSP toggle — persisted the old hardcoded demo mediator
  // as though it had been picked. By value it is indistinguishable from a
  // deliberate choice; by provenance it is not.
  const DEMO = "did:webvh:QmDemoRelay:demo.example:mediator";
  assert.equal(inboxToAdopt({ did: DEMO }, AGENT), AGENT);
});

test("the adoption happens once, not on every boot", () => {
  // Stamped `agent` on the way in, so the next boot leaves it alone even
  // though the active agent may since have changed.
  assert.equal(inboxToAdopt({ did: AGENT, source: "agent" }, AGENT), undefined);
});

// ─── No mediator may be baked into the source again ───

const SRC = fileURLToPath(new URL("../src/", import.meta.url));

/** A DID string literal carrying a real identifier body — as opposed to the
 *  prefixes (`"did:webvh:"`) and placeholders (`"did:webvh:…"`) the UI and the
 *  display helpers legitimately hold. A real identifier has a run of at least
 *  eight alphanumerics after the method. */
const HARDCODED_DID = /"did:[a-z0-9]+:[^"]*[A-Za-z0-9]{8}[^"]*"/;

test("no hardcoded DID is shipped in src — a wallet's relay is configuration", () => {
  const offenders: string[] = [];
  for (const name of readdirSync(SRC)) {
    if (!name.endsWith(".ts") && !name.endsWith(".tsx")) continue;
    const lines = readFileSync(SRC + name, "utf8").split("\n");
    lines.forEach((line, i) => {
      // Comments describe history and examples; only code counts.
      const code = line.trim();
      if (code.startsWith("//") || code.startsWith("*") || code.startsWith("/*")) return;
      if (HARDCODED_DID.test(line)) offenders.push(`${name}:${i + 1}: ${code}`);
    });
  }
  assert.deepEqual(
    offenders,
    [],
    "a DID literal in src is someone's mediator, agent or key becoming everyone's default:\n" +
      offenders.join("\n"),
  );
});

// ─── Backfill for wallets onboarded before onboarding wrote an inbox ───
//
// These ran on the removed hardcoded relay. Re-onboarding to acquire one
// mints a fresh holder DID and invalidates every RP ACL, so the answer is
// read off the connection already on disk instead.

const envelope = (connections: unknown) => JSON.stringify({ state: { connections }, version: 3 });

test("backfill prefers the active agent's mediator", () => {
  const raw = envelope({
    activeVtaDid: "did:webvh:QmActiveAgent:agent.example:vta",
    vtas: {
      "did:webvh:QmActiveAgent:agent.example:vta": { mediatorDid: AGENT },
      "did:webvh:QmOtherAgent:other.example:vta": { mediatorDid: OTHER },
    },
  });
  assert.equal(parseAgentMediatorDid(raw), AGENT);
});

test("backfill falls back to any agent that advertises one", () => {
  // A single-agent wallet whose active pointer was never set still backfills.
  const raw = envelope({
    activeVtaDid: null,
    vtas: { "did:webvh:QmOnlyAgent:only.example:vta": { mediatorDid: OTHER } },
  });
  assert.equal(parseAgentMediatorDid(raw), OTHER);
});

test("backfill skips an active agent that advertises none", () => {
  const raw = envelope({
    activeVtaDid: "did:webvh:QmRestOnly:rest.example:vta",
    vtas: {
      "did:webvh:QmRestOnly:rest.example:vta": {},
      "did:webvh:QmOtherAgent:other.example:vta": { mediatorDid: OTHER },
    },
  });
  assert.equal(parseAgentMediatorDid(raw), OTHER);
});

test("a REST-only wallet backfills nothing rather than guessing", () => {
  const raw = envelope({ activeVtaDid: null, vtas: { "did:webvh:QmRestOnly:r.example:vta": {} } });
  assert.equal(parseAgentMediatorDid(raw), undefined);
});

test("unreadable or absent storage backfills nothing", () => {
  assert.equal(parseAgentMediatorDid(undefined), undefined);
  assert.equal(parseAgentMediatorDid("not json"), undefined);
  assert.equal(parseAgentMediatorDid(envelope(undefined)), undefined);
  // A non-string mediator (a half-written record) must read as absent.
  assert.equal(parseAgentMediatorDid(envelope({ vtas: { a: { mediatorDid: 42 } } })), undefined);
});
