// The wallet's inboxes — see src/config.ts, doOnboardConnect, and the adopt /
// follow passes in background.ts.
//
// Background, because the shape here is the product of three findings and
// reads as over-built without them:
//
//  1. The inbox setting fell back to a hardcoded mediator DID on a domain no
//     deployment in use here runs, and onboarding never wrote one — so wallets
//     sent inbound traffic through a third party's demo host while Setup said
//     the relay came from their agent.
//  2. `setSettings` merged the DEFAULTED settings and wrote them back, so any
//     unrelated write froze that default into a stored value nobody chose —
//     which is why provenance, not just presence, decides whether to adopt.
//  3. There was ONE inbox for the whole wallet. A v4 holder is a `did:key`
//     with no service endpoint and the wallet publishes its relay to nobody,
//     so an executor can only push through the mediator it already knows —
//     its own. Whichever agent the single value named was reachable, and every
//     other agent's pushes were silently lost.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { inboxToAdopt } from "../src/config.ts";
import { parseAgentMediatorDids } from "../src/active-vta.ts";

const AGENT = "did:webvh:QmAgentMediator:agent.example:mediator";
const OTHER = "did:webvh:QmOtherMediator:other.example:mediator";
const VTA_A = "did:webvh:QmAgentOne:one.example:vta";
const VTA_B = "did:webvh:QmAgentTwo:two.example:vta";

// ─── Which relay to adopt, per agent ───

test("adopts the agent's relay when that agent has none", () => {
  assert.equal(inboxToAdopt({}, AGENT), AGENT);
});

test("leaves a relay the operator chose", () => {
  // The operator running two relays picked this one on purpose.
  assert.equal(inboxToAdopt({ did: OTHER, source: "operator" }, AGENT), undefined);
});

test("adopts over a stored relay nobody is on record choosing", () => {
  // The case that defeated the first migration. By value it is
  // indistinguishable from a deliberate choice; by provenance it is not.
  const DEMO = "did:webvh:QmDemoRelay:demo.example:mediator";
  assert.equal(inboxToAdopt({ did: DEMO }, AGENT), AGENT);
});

test("the blank-filling adoption happens once, not on every boot", () => {
  // Moving an agent-sourced relay when the agent moves it is
  // `followAgentInbox`'s job — it re-resolves the DID document, where this
  // function only reads a cached connection.
  assert.equal(inboxToAdopt({ did: AGENT, source: "agent" }, OTHER), undefined);
});

test("an agent advertising no relay gets none invented for it", () => {
  // Absent is reported by the self-test as "this agent cannot reach you".
  // Substituting anything here is what caused the original defect.
  assert.equal(inboxToAdopt({}, undefined), undefined);
  assert.equal(inboxToAdopt({ did: "" }, undefined), undefined);
});

// ─── Reading each agent's advertised relay off the persisted connections ───
//
// Wallets onboarded before the inbox map ran on the removed hardcoded relay.
// Re-onboarding to acquire one mints a fresh holder DID and invalidates every
// RP ACL, so the answer is read off what is already on disk instead.

const envelope = (connections: unknown) => JSON.stringify({ state: { connections }, version: 3 });

test("every agent's relay is read, not just the active one", () => {
  // The multi-VTA fix in one assertion: a wallet onboarded at two agents on
  // two relays must listen at both.
  const raw = envelope({
    activeVtaDid: VTA_A,
    vtas: { [VTA_A]: { mediatorDid: AGENT }, [VTA_B]: { mediatorDid: OTHER } },
  });
  assert.deepEqual(parseAgentMediatorDids(raw), { [VTA_A]: AGENT, [VTA_B]: OTHER });
});

test("an agent advertising no relay is absent, not present-and-empty", () => {
  // Absent means "nothing to adopt". Present-and-empty would reach the session
  // opener as a relay DID that is the empty string.
  const raw = envelope({
    activeVtaDid: VTA_A,
    vtas: { [VTA_A]: {}, [VTA_B]: { mediatorDid: OTHER } },
  });
  assert.deepEqual(parseAgentMediatorDids(raw), { [VTA_B]: OTHER });
});

test("unreadable or absent storage yields nothing rather than guessing", () => {
  assert.deepEqual(parseAgentMediatorDids(undefined), {});
  assert.deepEqual(parseAgentMediatorDids("not json"), {});
  assert.deepEqual(parseAgentMediatorDids(envelope(undefined)), {});
  // A non-string relay (a half-written record) must read as absent.
  assert.deepEqual(
    parseAgentMediatorDids(envelope({ vtas: { [VTA_A]: { mediatorDid: 42 } } })),
    {},
  );
});

// ─── No relay may be baked into the source again ───

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
