// The step-up is a gate, not a formality.
//
// Everything here is about one failure mode: a step-up that quietly stops being
// one. It does not break loudly — the prompt simply stops appearing, or appears
// and is not waited for, and the console goes on looking exactly as it did. So
// each property is pinned rather than left to review.
//
// `requirePresence` is exercised against a stubbed `navigator.credentials`,
// which is the only way to assert *that a ceremony ran* rather than that a
// function returned. The real one needs a visible page and a human.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Comments stripped before scanning. The module *discusses* the PRF ceremony
// at length — explaining why it deliberately does not reuse it — and a check
// that matched prose would fail on the very paragraph documenting the refusal,
// teaching the next person to delete the explanation to get green.
const SRC = readFileSync(
  fileURLToPath(new URL("../src/manager/step-up.ts", import.meta.url)),
  "utf8",
)
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

interface GetCall {
  challenge: Uint8Array;
  userVerification: string | undefined;
  extensions: unknown;
}

let calls: GetCall[] = [];
let behaviour: () => unknown = () => ({ id: "cred" });

let savedNavigator: PropertyDescriptor | undefined;
let savedIndexedDB: PropertyDescriptor | undefined;

const define = (name: string, value: unknown) =>
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });

const restore = (name: string, desc: PropertyDescriptor | undefined) => {
  if (desc) Object.defineProperty(globalThis, name, desc);
  else delete (globalThis as Record<string, unknown>)[name];
};

beforeEach(() => {
  calls = [];
  behaviour = () => ({ id: "cred" });
  savedNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  savedIndexedDB = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  // `navigator` is an accessor on the Node global, so a plain assignment
  // throws. Redefining is what a stub needs, and it is restored in afterEach.
  define("navigator", {
    credentials: {
      get: async (opts: { publicKey: Record<string, unknown> }) => {
        calls.push({
          challenge: opts.publicKey.challenge as Uint8Array,
          userVerification: opts.publicKey.userVerification as string | undefined,
          extensions: opts.publicKey.extensions,
        });
        return behaviour();
      },
    },
  });
  // No IndexedDB in Node: the credential lookup misses, which is the
  // not-enrolled path. Presence must still be askable there — see the module's
  // note on why enrolment and presence are different questions.
  define("indexedDB", undefined);
});

afterEach(() => {
  restore("navigator", savedNavigator);
  restore("indexedDB", savedIndexedDB);
});

const load = async () => await import("../src/manager/step-up.ts");

test("a completed assertion resolves, and it actually ran one", async () => {
  const { requirePresence } = await load();
  await requirePresence("ext-id", "abort a backup bundle");
  assert.equal(calls.length, 1, "requirePresence must run a WebAuthn assertion");
});

test("every call runs a fresh assertion — a prior one does not satisfy the next", async () => {
  const { requirePresence } = await load();
  await requirePresence("ext-id", "first");
  await requirePresence("ext-id", "second");
  assert.equal(
    calls.length,
    2,
    "the second call reused the first — a step-up satisfied by an earlier one is not a step-up",
  );
  assert.notDeepEqual(
    Array.from(calls[0]!.challenge),
    Array.from(calls[1]!.challenge),
    "the challenge must be fresh per call, or the ceremony is replayable",
  );
});

test("it demands user verification, not a bare touch", async () => {
  const { requirePresence } = await load();
  await requirePresence("ext-id", "reload services");
  assert.equal(
    calls[0]!.userVerification,
    "required",
    "a step-up that accepts presence alone is satisfiable by anyone at the machine",
  );
});

test("it asks for no PRF output — there is nothing to return and nothing to leak", async () => {
  const { requirePresence } = await load();
  await requirePresence("ext-id", "abort");
  const ext = calls[0]!.extensions as Record<string, unknown> | undefined;
  assert.ok(
    ext === undefined || !("prf" in ext),
    "the presence check must not evaluate PRF: that output is the AES key root, " +
      "and a caller wanting a boolean would end up holding key material",
  );
});

test("a dismissed prompt aborts, and reports as cancelled rather than as a fault", async () => {
  const { requirePresence, StepUpError } = await load();
  behaviour = () => {
    throw new DOMException("The operation either timed out or was not allowed.", "NotAllowedError");
  };
  await assert.rejects(
    () => requirePresence("ext-id", "abort"),
    (e: unknown) => {
      assert.ok(e instanceof StepUpError);
      assert.equal(
        (e as InstanceType<typeof StepUpError>).reason,
        "cancelled",
        "a dismissal is a decision, not an error to shout about",
      );
      return true;
    },
  );
});

test("a null credential is refused rather than read as success", async () => {
  const { requirePresence, StepUpError } = await load();
  behaviour = () => null;
  await assert.rejects(
    () => requirePresence("ext-id", "abort"),
    (e: unknown) => {
      assert.ok(e instanceof StepUpError);
      assert.equal((e as InstanceType<typeof StepUpError>).reason, "no-authenticator");
      return true;
    },
  );
});

// A source-level check, because the defect it guards against is an *absence*
// that no runtime assertion can see: a cache added later would make the tests
// above pass on their first call and stop the prompt appearing on every one
// after. Naming the symbols keeps the refusal legible at the place someone
// would reach for them.
test("the module consults no unlock or session state", async () => {
  for (const forbidden of ["cachedKey", "isUnlocked", "sessionStorage", "runPrfUnlockCeremony"]) {
    assert.ok(
      !SRC.includes(forbidden),
      `step-up.ts references \`${forbidden}\` — a step-up must not be satisfiable by ` +
        `an earlier unlock, and reading session state is how that arrives`,
    );
  }
});
