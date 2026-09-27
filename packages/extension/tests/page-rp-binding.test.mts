// A page may use the holder key only toward the relying party its origin is
// pinned to.
//
// `signTrustTask` and `stepUpVta` both take the relying party from the page.
// Without a binding, a page the user approved could have a document signed for
// a different RP, or steer a step-up approval at one. The binding is login's
// origin → RP DID pin (plus the REST login's base URL): these pin that the
// refusals key off it, that the lookup is by exact origin, and that nothing but
// an approved login seeds it.
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
      pageStepUpBindingRefusal(origin, pin, { rpDid: RP, baseUrl: BASE })!,
      /no relying party pinned/,
      origin,
    );
  }
});

// ── stepUpVta ───────────────────────────────────────────────────────────────

test("step-up at the pinned RP DID and base URL is allowed", async () => {
  await pinned();
  const pin = await readOriginPin(ORIGIN);
  assert.equal(pageStepUpBindingRefusal(ORIGIN, pin, { rpDid: RP, baseUrl: BASE }), null);
  // Same base, spelled with a trailing slash and an upper-case host.
  assert.equal(
    pageStepUpBindingRefusal(ORIGIN, pin, { rpDid: RP, baseUrl: "https://API.rp.example/v1/" }),
    null,
  );
});

test("step-up naming another RP DID is refused", async () => {
  await pinned();
  const why = pageStepUpBindingRefusal(ORIGIN, await readOriginPin(ORIGIN), {
    rpDid: OTHER_RP,
    baseUrl: BASE,
  });
  assert.ok(why!.includes(OTHER_RP) && why!.includes(RP), why!);
});

test("step-up against another base URL is refused", async () => {
  await pinned();
  const pin = await readOriginPin(ORIGIN);
  for (const baseUrl of [
    "https://attacker.example/v1",
    "https://api.rp.example/v2",
    "https://api.rp.example.attacker.com/v1",
    "http://api.rp.example/v1",
    "https://user@api.rp.example/v1",
    "https://api.rp.example/v1?x=1",
    "not a url",
  ]) {
    const why = pageStepUpBindingRefusal(ORIGIN, pin, { rpDid: RP, baseUrl });
    assert.match(why ?? "", /pinned to/, baseUrl);
  }
});

test("step-up is refused when the pin was seeded by a login that named no base URL", async () => {
  reset();
  await pinOrigin(ORIGIN, RP); // a DIDComm login
  const why = pageStepUpBindingRefusal(ORIGIN, await readOriginPin(ORIGIN), {
    rpDid: RP,
    baseUrl: BASE,
  });
  assert.match(why!, /no relying-party base URL pinned/);
});

test("an origin with no pin cannot step up", async () => {
  reset();
  const why = pageStepUpBindingRefusal(ORIGIN, await readOriginPin(ORIGIN), {
    rpDid: RP,
    baseUrl: BASE,
  });
  assert.match(why!, /no relying party pinned/);
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
