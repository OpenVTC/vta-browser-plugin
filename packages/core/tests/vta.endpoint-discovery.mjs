import { test } from "node:test";
import assert from "node:assert/strict";

import {
  TRUST_TASK_HTTPS_SERVICE_TYPE,
  TRUST_TASK_PATH,
  trustTaskBaseFromDocument,
  trustTaskUrl,
} from "../dist/vta/endpoint.js";

const doc = (service) => ({ id: "did:webvh:example", service });

test("the base is taken from the service type, never from the id fragment", () => {
  // The fragment is an arbitrary label the DID controller picks. Matching it
  // would make interop depend on a naming convention nobody agreed — the OWF
  // reference impl and Affinidi already disagree on the equivalent TSP label.
  // Both of these documents are conformant and must resolve identically.
  const affinidiStyle = doc([
    { id: "did:webvh:example#tt", type: TRUST_TASK_HTTPS_SERVICE_TYPE, serviceEndpoint: "https://vta.example" },
  ]);
  const verboseStyle = doc([
    { id: "did:webvh:example#trust-task-https", type: TRUST_TASK_HTTPS_SERVICE_TYPE, serviceEndpoint: "https://vta.example" },
  ]);
  assert.equal(trustTaskBaseFromDocument(affinidiStyle), "https://vta.example");
  assert.equal(trustTaskBaseFromDocument(verboseStyle), "https://vta.example");
});

test("a VTARest entry is NOT a Trust-Task endpoint", () => {
  // The whole reason for a dedicated type. "Is a VTA's REST API" and "accepts
  // Trust Tasks over HTTPS" are different claims that coincide only because
  // every Trust-Task server we currently run happens to be a VTA. Treating
  // one as the other posts Trust Tasks somewhere that never agreed to take
  // them — so an unrelated REST advertisement must not satisfy discovery.
  const d = doc([
    { id: "did:webvh:example#vta-rest", type: "VTARest", serviceEndpoint: "https://vta.example" },
  ]);
  assert.equal(trustTaskBaseFromDocument(d), undefined);
});

test("no entry is not an error — out-of-band configuration stays conformant", () => {
  // Binding 0.2 §6.3. A caller holding a configured base should use it; a
  // throw here would turn the supported path into a failure.
  assert.equal(trustTaskBaseFromDocument(doc([])), undefined);
  assert.equal(trustTaskBaseFromDocument({ id: "did:webvh:example" }), undefined);
  assert.equal(trustTaskBaseFromDocument(null), undefined);
  assert.equal(trustTaskBaseFromDocument("not a document"), undefined);
});

test("a trailing slash is ignored rather than producing an empty path segment", () => {
  // §6.1 says so explicitly, because `https://vta.example/` + `/trust-tasks`
  // is `//trust-tasks` — a different path, and one that routes nowhere.
  const d = doc([
    { type: TRUST_TASK_HTTPS_SERVICE_TYPE, serviceEndpoint: "https://vta.example/" },
  ]);
  assert.equal(trustTaskBaseFromDocument(d), "https://vta.example");
  assert.equal(trustTaskUrl("https://vta.example/"), "https://vta.example/trust-tasks");
});

test("a base with a path prefix keeps it — the base is not just an origin", () => {
  // The divergence this whole contract exists to settle. An advertisement of
  // `https://host/api` means the dispatcher is at `https://host/api/trust-tasks`,
  // NOT at `https://host/trust-tasks`.
  const d = doc([
    { type: TRUST_TASK_HTTPS_SERVICE_TYPE, serviceEndpoint: "https://vta.example/api" },
  ]);
  assert.equal(trustTaskBaseFromDocument(d), "https://vta.example/api");
  assert.equal(trustTaskUrl("https://vta.example/api"), "https://vta.example/api/trust-tasks");
});

test("a non-https endpoint is rejected, not quietly used", () => {
  // The binding is named HTTPS and requires TLS in front of the receiver.
  // This channel is the only one that carries a bearer token, and TLS is why
  // that is safe — silently accepting http: would downgrade exactly the
  // property the bearer depends on.
  const d = doc([
    { type: TRUST_TASK_HTTPS_SERVICE_TYPE, serviceEndpoint: "http://vta.example" },
  ]);
  assert.throws(() => trustTaskBaseFromDocument(d), /must be https:/);
});

test("DID Core's alternative shapes are accepted: array type, map endpoint", () => {
  // DID Core permits `type` as an array and `serviceEndpoint` as a map. The
  // DIDComm entries in this codebase already use the map form, so assuming
  // the string form the binding's examples happen to show would reject
  // documents that are perfectly valid.
  const arrayType = doc([
    { type: ["SomethingElse", TRUST_TASK_HTTPS_SERVICE_TYPE], serviceEndpoint: "https://vta.example" },
  ]);
  const mapEndpoint = doc([
    { type: TRUST_TASK_HTTPS_SERVICE_TYPE, serviceEndpoint: { uri: "https://vta.example" } },
  ]);
  const arrayEndpoint = doc([
    { type: TRUST_TASK_HTTPS_SERVICE_TYPE, serviceEndpoint: ["https://vta.example"] },
  ]);
  for (const d of [arrayType, mapEndpoint, arrayEndpoint]) {
    assert.equal(trustTaskBaseFromDocument(d), "https://vta.example");
  }
});

test("the first usable entry wins and a malformed one does not mask it", () => {
  const d = doc([
    { type: TRUST_TASK_HTTPS_SERVICE_TYPE },                                  // no endpoint
    { type: TRUST_TASK_HTTPS_SERVICE_TYPE, serviceEndpoint: "not a url" },     // unparseable
    { type: TRUST_TASK_HTTPS_SERVICE_TYPE, serviceEndpoint: "https://real.example" },
  ]);
  assert.equal(trustTaskBaseFromDocument(d), "https://real.example");
});

test("the suffix lives in exactly one place", () => {
  // The `/api/trust-tasks` divergence happened because two implementations
  // each spelled the suffix themselves. Anything composing a dispatcher URL
  // goes through `trustTaskUrl`, so there is one definition to move.
  assert.equal(TRUST_TASK_PATH, "/trust-tasks");
  assert.equal(trustTaskUrl("https://vta.example"), `https://vta.example${TRUST_TASK_PATH}`);
});
