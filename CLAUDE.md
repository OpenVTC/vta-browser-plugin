# CLAUDE.md — PNM Browser Plugin

The MV3 browser-extension wallet: holds the user's DIDs/credentials, runs the
mediator inbound session (offscreen document), and renders consent/step-up
approvals for VTA-gated operations. Two facts dominate all design here:
**MV3 tears down workers at any moment as normal operation**, and **consent
prompts are security controls** — one silently lost prompt is a gated action
that never got its human check (guide rule R7.2).

## Cross-service networking & integration discipline

Read the ecosystem doc set in `../design-docs/` before changing VTA/mediator
interaction code:

- **`vti-stack-development-guide.md`** — binding rules (R-numbers below);
  paste its pre-merge checklist into PRs.
- **`vti-networking-remediation-plan.md`** — deliverable **D8** covers this
  repo (with vti-didcomm-js and pnm-relay).
- **`vti-architectural-direction.md`** — design-level rationale.

Rules that bite hardest here:

- **R3.7 — match errors on stable machine-readable codes, never on strings,
  and parse error *bodies* before throwing on status.** Any condition this
  wallet must detect needs a stable field agreed with the Rust side —
  coordinate contract changes, don't guess shapes (R3.6). A `Response` body
  reads **once**: if you have already parsed it, build the error with
  `errorFromBody(doc, status, statusText)`, never by handing the spent
  `Response` back to `errorFromResponse` — that throws into a swallowing
  `catch` and silently degrades to a status-only guess.
- **R1.6 + MV3 — persist before ack.** Anything that acknowledges a mediator
  message must durably store it first; assume the worker/offscreen document
  dies on the next line. **Currently violated, and not fixable from this repo
  alone** — see "Known open defect" below.
- **R1.5 — reconnect must re-arm on failure, with exponential backoff.** Cap
  the *delay*, never the attempt count, and re-arm on **every** failure
  including first-connect: an `onClose`-driven retry cannot cover a session
  that never opened, because no open means no close. Use
  `ReconnectScheduler` (`packages/core/src/inbound/reconnect.ts`) rather than
  a fresh `setTimeout` loop.
- **R1.2 — every outbound fetch gets a timeout.** Apply it at the point
  `fetch` is *injected* (`withFetchTimeout`), not at the call site. Every
  network helper here takes an optional `fetch` for testability, so a literal
  `grep "fetch("` finds almost nothing — the real calls are spelled `f(...)`,
  `fetchFn(...)`, `this.fetchImpl(...)`.
- **R4.1 — shared code with pnm-relay and vti-didcomm-js is a liability until
  extracted**: the relay never received this repo's body-first error-parsing
  fix. Land contract/transport fixes in all three or extract the shared core.

## Known open defect — R1.6 persist-before-ack

`@openvtc/vti-didcomm-js` acks an inbound frame **before** dispatching it to
`onMessage` (`_dispatchFrame` in `mediator-transport.js`), and the ack tells
the mediator to delete its queued copy. The wallet then persists only the
message **id** (`inbound/dedup.ts`), never the body.

So if the offscreen document or service worker dies between the ack and the
user's decision, a `task-consent/request` is gone for good: the mediator
deleted it, nothing stored the challenge or `payloadDigest`, and the id now
suppresses any replay as a duplicate. The VTA waits for a decision that will
never come and the task lapses on its TTL.

Fixing it needs either a persist hook in `vti-didcomm-js` or disabling its
auto-ack and driving `acknowledgeMessages` explicitly after a durable write —
a contract change affecting pnm-relay too (R4.1). Don't paper over it here.

## Repo mechanics worth knowing before you start

- **Build `core` before typechecking anything that depends on it.** Each
  workspace typechecks against its dependencies' emitted, gitignored `dist`,
  so a stale `dist` produces phantom "cannot find module" / "no exported
  member" errors in source that is perfectly correct. `tsc -b` walks the
  project references and builds them in order.
- **Lint is `tsc -b`, never `tsc -b --noEmit`** — the latter is invalid when a
  referenced composite project must emit (TS6310) and fails outright.
- **Never add a cross-workspace import without the matching `references`
  entry** in that package's tsconfig, or `tsc -b` cannot know the build order.
- **CI** (`.github/workflows/ci.yml`) runs lint → build → test on Node 24
  (the `engines` floor) and 26 from a cold checkout, and asserts the MV3 invariant that
  `dist/background.js` stays a single bundle with **no dynamic `import()`** —
  a service worker cannot load one, and losing Rollup's `codeSplitting: false`
  would break the worker at runtime behind a green build.
- **Stub `Response` objects with a real `Response`**, not an `{ ok, json }`
  literal. A hand-rolled stub only implements whatever the code happened to
  call when it was written, and stops representing a Response the moment the
  code reads the body a different way.
- **Node unrefs the timer behind `AbortSignal.timeout`**, so a test awaiting
  one needs something else holding the event loop open or the process exits
  first — it passes locally and fails in CI as "Promise resolution is still
  pending".
