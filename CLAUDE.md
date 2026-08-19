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
- **`packages/core` is layered, and the layering is enforced.** Modules import
  downwards only — `util`/`http` → `did`/`didcomm`/`webauthn` → `siop` →
  `vta`/`trust-tasks` → `store`/`vault`/`device`/`provision`/`rp-login`/
  `onboarding` → `inbound` — with no cycles and no sideways imports.
  `tests/package.module-boundaries.mjs` fails the build on a violation and
  names the file; its `KNOWN_EXCEPTIONS` list may only shrink (a stale entry
  also fails). Every module directory is a published entry point, so
  `tests/package.entry-points.mjs` imports each one in plain Node with no DOM —
  core is heading for its own repo as a general-purpose library, and a browser
  global reaching a shared module is the failure that only shows up after
  someone `npm i`s it into a server. If a shared helper is needed one layer up,
  move it down rather than adding an exception.
- **CI** (`.github/workflows/ci.yml`) runs lint → build → test on Node 24
  (the `engines` floor) and 26 from a cold checkout, and asserts the MV3 invariant that
  `dist/background.js` stays a single bundle with **no dynamic `import()`** —
  a service worker cannot load one, and losing Rollup's `codeSplitting: false`
  would break the worker at runtime behind a green build.
- **The wallet writes nothing into the browser on a site's behalf.** No
  `cookies` permission, no `chrome.cookies` call anywhere in the shipped
  bundle — CI asserts both. The legacy password-site login that needed them
  (VTA performs the login, wallet injects the returned cookie jar) was removed
  rather than defended; `doVaultProxyLogin` in `src/offscreen.ts` now drops any
  cookie jar a VTA returns before it crosses the bridge. `vault/proxy-login`
  survives for the SIOP `id_token` path only, which installs nothing.
- **`packages/extension/manifest.json` is a template, not the manifest.** It
  carries no `version` (that comes from the package's `package.json`, the one
  source of truth) and no `key`. The real manifest is assembled into `dist/`
  by a vite plugin — assembly lives in `scripts/manifest.mjs`. `dist/`'s copy
  gets `key` so unpacked installs hold a stable ID; the Web Store zip
  (`npm run package`) omits it, because a new item's upload is rejected if it
  carries one. Changing the pinned key changes `chrome.runtime.id`, which is
  the WebAuthn PRF rpId (`src/holder.ts`) — it orphans every wrapped secret.
- **Host permissions are optional and requested just-in-time.** The manifest
  has `optional_host_permissions`, not `host_permissions`, so nothing is
  granted at install. `chrome.permissions.request` needs a live user gesture
  and throws in a service worker, so the background only *checks*
  (`hasOriginPermission`) and reports `HOST_PERMISSION_REQUIRED` with the
  origin; the popup does the asking, and the request must be the **first**
  `await` in the click handler or the gesture is already spent. This works
  only because DID resolution needs no grant (the webvh hosting service
  serves `Access-Control-Allow-Origin: *`) — the VTA does *not*, since
  vta-service uses an origin allowlist. See `src/host-permissions.ts`.
- **No static `content_scripts`, and don't add one back.** The page provider
  is registered at runtime for granted origins only
  (`src/content-registration.ts`); a manifest match would re-grant blanket
  host access and double-inject. CI asserts the packaged manifest has none.
  Two consequences: `registerContentScripts` needs the host permission first,
  so the reconcile must re-run on every `permissions.onAdded`/`onRemoved` and
  on cold start; and registration never reaches already-open tabs, so callers
  reload the tab after granting. Anything that used to read
  `manifest.content_scripts` for a match list must read the grants instead —
  `broadcastWalletEvent` silently reached no tabs when it didn't.
- **A browser cannot read a `Location` header, so agent-name stage 1 must
  follow the redirect.** `fetch(url, { redirect: "manual" })` returns an
  opaque-redirect response — status 0, no headers — on every host, and when the
  target is a `did:` URI Chrome refuses the request outright in the network
  stack (`net::ERR_UNSAFE_REDIRECT`), surfacing as a bare `TypeError: Failed to
  fetch`. No extension API is given the header either: `webRequest` never fires
  the callback that would carry it. `fetchAgentName` in `src/background.ts`
  therefore sends an `Accept` that includes `text/html` and follows the
  redirect; the webvh hosting service content-negotiates that into a same-origin
  redirect to the DID's log, and `didFromNameResponse` takes the DID from the
  landing URL or body. That is safe only because the DID is a *candidate* —
  stages 2 and 3 still have to pass — so don't shortcut it into a trusted
  answer. Node's `fetch` does expose `Location`, which is why the unit tests
  cover both shapes.
- **Stub `Response` objects with a real `Response`**, not an `{ ok, json }`
  literal. A hand-rolled stub only implements whatever the code happened to
  call when it was written, and stops representing a Response the moment the
  code reads the body a different way.
- **Node unrefs the timer behind `AbortSignal.timeout`**, so a test awaiting
  one needs something else holding the event loop open or the process exits
  first — it passes locally and fails in CI as "Promise resolution is still
  pending".
