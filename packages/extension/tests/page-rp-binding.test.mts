// A page may use the holder key only toward the relying party its origin is
// pinned to.
//
// `signTrustTask` and `approveSessionStepUp` both take the relying party from
// the page. Without a binding, a page the user approved could have a document
// signed for a different RP, or steer a step-up approval at one. The binding is
// login's origin → RP DID pin: these pin that the refusals key off it, that the
// lookup is by exact origin, and that nothing but an approved login seeds it.
//
// `chrome` is installed before the dynamic import because `origin-pin.ts`
// reaches `chrome.storage.local`.

import { strict as assert } from "node:assert";
import { test } from "node:test";

const area: Record<string, unknown> = {};
Object.defineProperty(globalThis, "chrome", {
  value: {
    storage: {
      local: {
        get: async (k: string) => ({ [k]: area[k] }),
        set: async (v: Record<string, unknown>) => {
          Object.assign(area, v);
        },
        remove: async (k: string) => {
          delete area[k];
        },
      },
    },
  },
  writable: true,
  configurable: true,
});

const { checkOriginPin, pinOrigin, readOriginPin } = await import("../src/origin-pin.ts");
const { normalizeBaseUrl, pageSignBindingRefusal, pageStepUpBindingRefusal } = await import(
  "../src/page-task-policy.ts"
);

const ORIGIN = "https://rp.example";
const RP = "did:webvh:QmExampleScid:rp.example";
const OTHER_RP = "did:webvh:QmOtherScid:attacker.example";
const BASE = "https://api.rp.example/v1";

function reset() {
  for (const k of Object.keys(area)) delete area[k];
}

async function pinned() {
  reset();
  await pinOrigin(ORIGIN, RP, BASE);
}

// ── signTrustTask ───────────────────────────────────────────────────────────

test("a page can have a document signed for the RP its origin is pinned to", async () => {
  await pinned();
  assert.equal(pageSignBindingRefusal(ORIGIN, await readOriginPin(ORIGIN), RP), null);
});

test("a document addressed to another RP is refused, naming both", async () => {
  await pinned();
  const why = pageSignBindingRefusal(ORIGIN, await readOriginPin(ORIGIN), OTHER_RP);
  assert.notEqual(why, null);
  assert.ok(why!.includes(OTHER_RP) && why!.includes(RP), why!);
});

test("an origin with no pin gets no signature, and asking does not pin it", async () => {
  reset();
  const why = pageSignBindingRefusal(ORIGIN, await readOriginPin(ORIGIN), RP);
  assert.match(why!, /no relying party pinned/);
  assert.match(why!, /Sign in from this site first/);
  assert.equal(await readOriginPin(ORIGIN), undefined);
});

// The pin is keyed by the exact browser-attested origin. Each of these is a
// different origin, and inherits nothing from the pinned one.
const NOT_THE_PINNED_ORIGIN = [
  "https://evil.rp.example", // subdomain
  "https://rp.example.attacker.com", // pinned host as a label prefix
  "https://rp-example.com", // lookalike
  "https://rp.examp1e", // homoglyph-ish lookalike
  "http://rp.example", // scheme downgrade
  "https://rp.example:8443", // another port
];

test("a subdomain, lookalike, or another scheme or port has no pin of its own", async () => {
  await pinned();
  for (const origin of NOT_THE_PINNED_ORIGIN) {
    const pin = await readOriginPin(origin);
    assert.equal(pin, undefined, origin);
    assert.match(pageSignBindingRefusal(origin, pin, RP)!, /no relying party pinned/, origin);
    assert.match(
      pageStepUpBindingRefusal(origin, pin, RP)!,
      /no relying party pinned/,
      origin,
    );
  }
});

// ── approveSessionStepUp ────────────────────────────────────────────────────

test("a step-up approval for the pinned RP DID is allowed", async () => {
  await pinned();
  assert.equal(pageStepUpBindingRefusal(ORIGIN, await readOriginPin(ORIGIN), RP), null);
});

test("a step-up approval naming another RP DID is refused", async () => {
  await pinned();
  const why = pageStepUpBindingRefusal(ORIGIN, await readOriginPin(ORIGIN), OTHER_RP);
  assert.ok(why!.includes(OTHER_RP) && why!.includes(RP), why!);
});

test("a step-up approval needs no base URL: the wallet contacts no one for it", async () => {
  reset();
  await pinOrigin(ORIGIN, RP); // a DIDComm login, which names no base URL
  assert.equal(pageStepUpBindingRefusal(ORIGIN, await readOriginPin(ORIGIN), RP), null);
});

test("a step-up approval with no RP DID is refused", async () => {
  await pinned();
  const pin = await readOriginPin(ORIGIN);
  for (const rpDid of [undefined, "", 42, "https://rp.example"]) {
    assert.match(pageStepUpBindingRefusal(ORIGIN, pin, rpDid) ?? "", /needs the relying party's DID/);
  }
});

test("an origin with no pin cannot step up", async () => {
  reset();
  const why = pageStepUpBindingRefusal(ORIGIN, await readOriginPin(ORIGIN), RP);
  assert.match(why!, /no relying party pinned/);
  assert.equal(await readOriginPin(ORIGIN), undefined);
});

// ── How login maintains the pin ─────────────────────────────────────────────

test("a login that names another base URL is flagged as a change", async () => {
  await pinned();
  const same = await checkOriginPin(ORIGIN, RP, `${BASE}/`);
  assert.equal(same.baseUrlChanged, false);
  const moved = await checkOriginPin(ORIGIN, RP, "https://attacker.example/v1");
  assert.equal(moved.baseUrlChanged, true);
  assert.equal(moved.pinnedBaseUrl, BASE);
  assert.equal(moved.rpDidChanged, false);
});

test("a login without a base URL keeps the pinned one for the same RP, and drops it for another", async () => {
  await pinned();
  await pinOrigin(ORIGIN, RP);
  assert.deepEqual(await readOriginPin(ORIGIN), { rpDid: RP, baseUrl: BASE });
  await pinOrigin(ORIGIN, OTHER_RP);
  assert.deepEqual(await readOriginPin(ORIGIN), { rpDid: OTHER_RP });
});

test("base URLs normalize to one spelling, and refuse what is not a plain base", () => {
  assert.equal(normalizeBaseUrl("https://API.rp.example:443/v1//"), BASE);
  assert.equal(normalizeBaseUrl("https://api.rp.example"), "https://api.rp.example");
  assert.equal(normalizeBaseUrl("ftp://api.rp.example"), null);
  assert.equal(normalizeBaseUrl("https://a:b@api.rp.example"), null);
  assert.equal(normalizeBaseUrl("https://api.rp.example/#x"), null);
  assert.equal(normalizeBaseUrl("nope"), null);
});
