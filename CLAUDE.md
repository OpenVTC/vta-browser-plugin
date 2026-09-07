# CLAUDE.md — PNM Browser Plugin

The MV3 browser-extension wallet: holds the user's DIDs/credentials, runs the
mediator inbound sessions — one per onboarded agent (offscreen document), and renders consent/step-up
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
  repo (with vti-didcomm-js; `pnm-relay` was the third and no longer exists —
  see R4.1).
- **`vti-architectural-direction.md`** — design-level rationale.

Rules that bite hardest here:

- **Nothing is deployed — do not write compatibility folds.** The extension has
  never been published to the Chrome Web Store and has no users outside this
  workspace, so "an older agent is still a supported peer" is not true and the
  fold it justifies is dead code that reads like a live constraint. Dual-accept
  arms for the trust-tasks #279 re-casing and a legacy inbound-dedup record were
  both removed for exactly this reason; don't reintroduce the pattern. Match the
  spelling the registry declares **today**, with `===`. When a wire format
  changes, the plugin and the VTA cut over together — say so in the coordinating
  issue rather than absorbing the old shape here. This is also why a request to
  another repo should not ask for a deprecation window on this repo's behalf.

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
  dies on the next line. **Satisfied — and easy to break again**: see "How
  persist-before-ack is held" below before touching the inbound path.
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
- **R4.1 — the shared core is extracted; keep it that way.** This rule used to
  read "shared code with pnm-relay and vti-didcomm-js is a liability until
  extracted: the relay never received this repo's body-first error-parsing
  fix". That is done and the note had gone stale: **`pnm-relay` no longer
  exists.** Its `rest-channel.ts` / `request-task.ts` were consolidated into
  `@openvtc/pnm-core` — the copy `pnm-extension` and `pnm-pwa` both consume,
  which carries the body-first parse (`decodeTrustTaskHttpAck` reads the body,
  then builds with `errorFromBody`; `errorFromResponse` appears nowhere) and the
  `ConsentRequired` union. Nothing depends on `@openvtc/pnm-relay`, and
  `rp-sdk-js` is a separate server-side SIOPv2 verifier, not its successor.
  (`vti-networking-remediation-plan.md` F5, resolved by consolidation.)

  What survives is the *rule*, not the defect: `vti-didcomm-js` is still a
  separate implementation of the same wire contract, so a transport or
  error-shape fix has to land in both. A third copy is what R4.1 exists to
  prevent — do not reintroduce one.

## How persist-before-ack is held (R1.6)

This was an open defect and is now closed, in two halves that only work
together. Both are load-bearing, and neither is obvious from the code that
depends on it.

**The transport acks after handoff.** `@openvtc/vti-didcomm-js` 0.6.2+
(`_dispatchFrame` in `mediator-transport.js`) awaits `_deliver` — which awaits
your `onMessage` — and only then acks. The ack is what tells the mediator to
delete its queued copy, so acking first would make the mediator's copy the only
copy during the window where we hold nothing. **The plugin's `^0.6.2` floor is
therefore a correctness constraint, not a version preference.** An older
transport acks first and silently reintroduces the defect.

**The handler persists before it returns.** `onInboundMessage` in
`src/offscreen.ts` awaits `putPendingInbound` (`core/src/inbound/pending.ts`)
as its first action, so the whole message is durably stored before the promise
settles and the ack goes out. `offscreen.ts` and `background.ts` drain
`listPendingInbound` on boot, so anything interrupted mid-decision is re-driven
rather than lost. `tests/inbound.ack-ordering.mjs` pins the ordering.

**What breaks it:** making `onInboundMessage` return before the write settles
(dropping the `await`, moving the persist after a branch, or handling a message
type on a path that skips it), or relaxing the `vti-didcomm-js` floor below
0.6.2. `pending.ts` is deliberately separate from `dedup.ts` — dedup answers
"have I already prompted for this?", pending answers "is this still
outstanding?" A message can be both, which is why the drain path bypasses the
dedup check.

## Every outbound Trust-Task document is signed (SPEC §7.2 item 7a)

The VTA enforces the four checks a Trust Task specification declares for
itself, on the dispatch spine common to all three transports. Three of them
this wallet has always satisfied — `recipient`, `issuedAt`, audience binding.
The fourth it did not: **93 of the 141 task types it speaks declare `proof`
REQUIRED**, and nothing on the channel path attached one, so every `vault/*`,
`acl/*`, `vta/webvh/*`, `credential-exchange/*` and `vtc/*` call was refused
with `proofRequired` before reaching a handler.

**The channel signs, not the caller.** `signOutboundTask`
(`vta/trust-task.ts`) is called by `RestChannel.post`, `TspChannel.packForVta`
and `DidcommVtaTransport.packEnvelope` — the one place each transport funnels
through on the way out. The ~116 sites that call `buildTrustTask` know nothing
about it, which is the point: signing at each of them is the same decision
taken 116 times, and forgetting once is a task that breaks the day someone
turns a check on.

**A `SigningIdentity` is a REQUIRED channel input.** Not optional, not
defaulted — a channel that could be built without one is a channel that
silently sends unsigned documents. `loadHolder` already returns `signing`
beside `identity`, so the composition roots have it.

**What breaks it:** making the input optional; signing at a call site instead
(the next transport added would not inherit it); or reading the
specification's `isProofRequired` to decide — we sign unconditionally, because
a proof where one is merely RECOMMENDED is legal and strictly more
attributable, and a 141-entry table of which tasks need one goes stale
invisibly.

**What is deliberately NOT signed:** the `/auth/` handshake
(`vta/auth.ts`). That route is bespoke — it authenticates by the authcrypt
sender and never reaches the dispatch spine — and `provision/integration`,
which signs its own document with an `authentication`-purpose proof in
`provision/request.ts` and sends outside the channels. Neither is an oversight;
routing either through a channel would overwrite or duplicate a proof.

`tests/vta.outbound-signing.mjs` pins it, running the real verifier over the
document as the counterparty receives it — a signature copied from another
document satisfies an "is there a `proof` member" check and fails this one.

## The wallet ships no operator authority — the console does

`@openvtc/pnm-core/admin` is operator surface: granting authority at an agent,
revoking it, destroying contexts. It is deliberately absent from the package
root barrel, and CI greps the built output for 17 of its task URIs.

That guard used to read "banned anywhere in `dist/`", on the grounds that a
wallet has no business shipping any of it. The **management console**
(`manager.html`) makes that statement false on purpose — administering the agent
is its whole job — so the guard was **narrowed, not deleted**: banned everywhere
in `dist/` *except* `manager.js`. Every wallet surface (service worker, content
and page-world scripts, popup, confirm, offscreen, options) keeps the property
the guard was protecting.

**The console is its own vite build** (`vite.config.manager.ts`,
`codeSplitting: false`). That is what makes "exactly one file may contain admin"
structural rather than a convention: the main build emits popup, options,
confirm and offscreen *together*, and Rollup is free to hoist shared code into a
common `assets/*.js` chunk that wallet surfaces load. Building the console alone
means there is no other entry to share with. A second CI assertion fails if it
ever emits more than one chunk, because the first guard names exactly one
exception and an extra chunk is a file nothing checks.

**The console holds no key material.** It composes typed documents with the
`admin/*` helpers and the offscreen document signs them, so an XSS there cannot
exfiltrate a key. This is why `admin/*` and `vta/contexts.ts` type their
envelope parties as `TaskParty` (`vta/channel.ts`) — just a DID — rather than
`Identity` and `RemoteDidcommEndpoint`: only `.did` was ever read, and a
surface typed on `Identity` can only be called from somewhere holding a private
key. The REST convenience wrappers (`vtaListContexts`, `vtaCreateContext`) still
take the stricter pair, because they *build a channel*, and a channel signs.

**Only `type` and `payload` cross the bridge.** `RUNTIME_MANAGER_TASK` carries
those two members and nothing else; `carrier.ts` strips the envelope the admin
helper built, and `offscreen.ts`'s existing `OFFSCREEN_REQUEST_TASK` mints the
real one and signs it. `core/src/vta/request-task.ts` explains why the device
must mint it, and that reasoning does not soften because the composer is an
extension page: a wallet that counter-signs a document composed elsewhere
attests to fields it never checked. Reusing that path also inherits transport
selection, `TransportHealth`, and the same-browser approver ceremony for free —
`offscreen.ts` needed no change at all.

**The relay is gated on `sender.url`, not `sender.id`.** Every content script
carries this extension's id, so `sender.id` cannot separate a page from an
extension surface. `isExtensionPageSender` compares against
`chrome.runtime.getURL("")`. Unlike the page-facing `RUNTIME_REQUEST_TASK`, this
one does **not** prompt per call — the caller is the operator driving their own
console, and twelve identical dialogs to render one screen is dismissal, not
consent. What stands in its place: the agent's ACL, its policy engine (a
`requireConsent` comes back as `ConsentRequiredError` and renders as a match-code
ceremony, never as a red string), and preview-then-confirm on every irreversible
action, showing the agent's own account of what would be destroyed.

**What breaks it:** importing `admin` from the package root instead of the
subpath; folding `manager.html` into `vite.config.ts` (a shared chunk then
carries admin into wallet surfaces); losing `codeSplitting: false`; adding
`RUNTIME_MANAGER_TASK` to `PAGE_FACING_RUNTIME_TYPES` or to `content.ts`'s
dispatch table; gating on `sender.id`; or widening the carrier to pass the
envelope through. `tests/manager-sender.test.mts`,
`tests/manager-surface.test.mts` and the two CI assertions pin each of these.

## The holder's own identity crosses the boundary one way, downwards

`persona/*` is two families wearing one prefix, and which half a task belongs to
decides which surface may hold it.

**The pool and the profiles over it are agent-scoped.** One person, one set of
facts about themselves, sitting *above* every trust context. **Bindings,
contacts and disclosure records are context-scoped**, because a persona lives in
a context and so do its counterparties. Nothing inside a context may read the
pool: the holder pushes a materialised projection down, and a context never
pulls. That is a rule about *direction*, not a permission — an access-control
failure over a readable pool discloses everything, while a pool no context can
address has nothing to disclose.

**The two halves live at two subpaths, and that is what makes the rule
checkable.** `@openvtc/pnm-core/persona` is the wallet's half: disclosure's
two-call gate, contacts, read-only bindings, renderers, and context-local
profiles. `@openvtc/pnm-core/admin`'s `persona.ts` is the holder's half — the
attribute pool, profiles, `binding/set`, `correlation/analyze`,
`disclosure/history` — and the agent gates all ten on
**`require_super_admin`**: `Admin` *and* unrestricted scope. A guard reading
"is this an administrator" passes for one scoped to a single context, who would
then be reading identity data belonging to every *other* context. The console's
`isUnscopedHolder` mirrors that test and exists so a pane can *explain* the
refusal; it never decides.

**Only `manager.js` may carry the holder's half.** CI greps `dist/` for those
ten URIs with `manager.js` excluded, exactly as it does for `admin/*`. The
console administers the agent and its operator can hold the credential these
tasks need; every wallet surface acts as a party inside a context and cannot.
A **second** assertion checks the console still *has* them, because narrowing
the guard gave a leak two shapes: a wallet gaining them, and the console losing
them to a dropped import or a tree-shake — the second being a persona pane whose
buttons do nothing, behind a smaller bundle and a green build.

**A page may not drive any of it, either half.** `page-task-policy.ts` refuses
the whole `persona/` prefix with a reason that names the route that does exist.
A page is a verifier, and `requestTask` hands the VTA's reply straight back to
the caller — so one vague prompt would otherwise buy a site the holder's name,
address and phone number without showing them any of it.

**The pane is a picture, and its words are fixed.** `panes/persona.tsx` loads
the pool, the faces and every context's bindings, builds `identity-graph.ts`'s
model, and shows either the guided setup (`persona-setup.tsx`, while the holder
has no face) or the identity map (`persona-map.tsx`). What lights up when
something is selected — a fact's reach runs *down* to the contexts it goes to,
a context's runs *up* to the facts it holds — is computed in
`identity-graph.ts` and tested; the component only draws. The on-screen words
are a **fact**, a **face**, a **context** and a persona that **wears** a face,
per `design-docs/persona-vocabulary.md`; the spec's words (`attribute`,
`profile`, `binding`, `materialise`) stay in code and off the screen. Add copy
in those words, or change the document first.

**The console's components are rendered in tests, and this is how.**
`tests/harness/` holds module hooks and a DOM so `node --test` can mount a
pane. Two things it does that are not obvious: it resolves a `./thing.js`
import to `thing.tsx` (the sources use TypeScript's `Bundler` resolution, which
Node does not implement) and transforms JSX with **esbuild** — not
`typescript`, whose 7.x JS API is the native port's small surface with no
`transpileModule` on it. Tests are `.mts` and cannot contain JSX, so compose
with `h(Component, props)`; calling a component runs its hooks outside React
and dies on the first `useState`.

The fake agent answers **by task URI** and *throws* on a task the test did not
name, because a pane asking something unexpected is the thing worth noticing.
It returns the relay's real envelope (`{ok, result: {kind: "accepted", …}}`),
so a pane that mishandles a real response cannot pass. Drive checkboxes with a
click rather than assigning `checked` — React reads the click, and a hand-set
value looks like a tick to the test and like nothing to the component.

Every test in `persona-pane.render.test.mts` is a bug that reached the live
console and was invisible to both the type checker and the tested models
beneath it: a `ref` that looped the renderer, a form that opened empty, a
picker offering another context's identifiers. Add a rendered test when a bug
is one a person would see and a model would not.

**What breaks it:** putting a pool task in `core/src/persona/` or the root
barrel; importing `@openvtc/pnm-core/admin` from a wallet entry; testing
`hasRole(authority, "admin")` where a persona task is concerned; relaxing the
guard to allow more than `manager.js`; or deleting the presence assertion
because it "duplicates" the exclusion one. `packages/core/tests/admin.persona.mjs`
pins the client shapes, including the two the wire depends on: a `value` is sent
as the JSON it is rather than wrapped in an object, and a `profileId` of `null`
is an unbind rather than an omission.

## Key material never reaches a browser, and that is enforced

`vta/seeds/*` — `list`, `rotate`, `export-mnemonic` — is the one task family
this extension refuses outright. `export-mnemonic` returns a BIP-39 mnemonic:
the seed every derived key in the agent comes from, and the one secret whose
disclosure loses everything at once. `list` and `rotate` are the rest of that
family's surface.

**A second CI guard bans all three from anywhere in `dist/`, with no
exception.** That is the difference from the admin guard above, and the
difference is the point: `admin/*` is *authority*, which the console is meant to
hold, so that guard names `manager.js` as its one permitted file. These return
*material*, and no browser context should be able to ask for them — not the
console, not the wallet, nowhere.

**Why a guard rather than simply not building it.** Not building a seeds pane is
indistinguishable from not having got round to one. Someone reasonable adds it
next year, nothing objects, and the refusal was never recorded anywhere a person
would look. The guard is what makes the decision legible.

**Verified non-vacuous — and the way it is verified matters.** A seeds URI
merely *present* in console source is not enough: Rollup tree-shakes an
unreferenced export, the string never reaches `dist/`, and the guard correctly
stays silent. That is the guard being right, not weak — it asserts what
*ships* — but it means a probe that adds an unused `export const` proves
nothing and reads like a hole. To re-verify, put the URI somewhere the console
actually renders (a nav `label`, say), rebuild, and watch `manager.js` trip it.

`packages/core` has no seeds module and must not gain one. The guard catches
that too — a core function would be bundled into `manager.js` and grep would
find it there.

**`vault/release/0.1` is deliberately not on the list.** It releases a secret to
a site the human has just approved, which is the wallet's entire job. The line
is not "touches a secret"; it is "hands over material the holder cannot revoke,
to a surface that cannot contain it".

**What breaks it:** adding a seeds client to `packages/core`; relaxing the guard
to allow `manager.js` "for symmetry" with the admin one; or reading this as
advice rather than a refusal.

## Advertisement is not availability

A VTA's DID document says what it *offers*. `buildVtaSession` skips a channel
whose mediator it cannot reach and falls through to the next, so a wallet
routinely advertises TSP, DIDComm and REST while every byte goes over REST.
The UI used to derive "Transport in use" from the stored connection alone and
therefore named transports that had never carried a byte — worse than saying
nothing, because it stops anyone asking the question.

`activeTransport` (`transports.ts`) now takes a `TransportHealth`, recorded by
`buildVtaSession` at the two places it decides — and only there, because that
is the only code that knows. Three states, and the third is load-bearing:
`up` needs positive evidence (for TSP/DIDComm a completed mediator handshake
and an open socket), `down` is a skip, and REST records **`unknown`** because
a `RestChannel` is built from a URL without contacting anything. Marking a
constructed REST channel `up` would reintroduce the same overconfidence one
layer down. `unknown` is not a failure and never removes REST from selection.

**What breaks it:** computing the status from `TransportSources` alone again;
recording `up` on construction rather than on evidence; or adding a fourth
transport without recording its outcome, which reads as "not observed" and
silently restores the advertisement-only answer for that channel.

## Every agent gets its own inbox, because nothing publishes one

A v4 holder is a **`did:key` the VTA mints** (`store/holder-identity.ts`), and
`did:key` has no service endpoint. The wallet publishes its relay to nobody —
`device/set-wake`'s `suggestedTriggers` is advisory and never carries it. So
**there is no discovery path**: an executor with something for this wallet can
only hand it to a mediator it already knows, its own, and the wallet hears it
only if it happens to be listening there.

An inbox is therefore not one address the wallet owns. It is "wherever *that*
agent's relay is", once per onboarded agent — `settings.inboxes` is
`Record<vtaDid, { did, source }>`. It was a single wallet-wide `mediatorDid`,
which meant whichever agent that value named was reachable and **every other
agent's consent requests were lost without a trace**. The approver inbox is the
same map, which is the sharper version: that session carries
`task-consent/request`, so a wrong relay is a gated action that never got its
human check (R7.2).

**Sessions are keyed on the (agent, relay) PAIR**, not on a relay DID.
`reconcileInbound` opens one per pair, and `isInbox`, the close-extras sweep
and the transport-health snapshot all match that way, because with one relay
per agent the same mediator can be one agent's inbox and another's outbound
hop. A single-DID comparison mislabels sessions and closes the wrong ones.

**`source` is provenance, and it is load-bearing.** `agent` follows that
agent's DID document (`followAgentInbox`, on `onStartup`/`onInstalled` — not
per worker spin-up); `operator` is pinned and never moved. It exists because
`setSettings` used to merge the *defaulted* settings and write them back, so
the old hardcoded relay became a **stored** value indistinguishable by content
from a deliberate choice — and the migration meant to rescue those wallets
declined to touch them. `setSettings` now merges onto the stored record; that
class of bug was never mediator-specific.

**Two orderings that look arbitrary and are not.** `setInbox`/`forgetInbox`
own the read-modify-write of the map — handing `setSettings` a whole `inboxes`
object drops every agent absent from the caller's copy, whose symptom is
exactly the silent loss this map exists to end. And an entry is forgotten
*inside* `reconcileInbound`, right after that session closes: deleting it where
the operator forgets the agent runs **before** the reconcile, leaving the
session unrecognisable as an inbox and so open forever.

**What breaks it:** a wallet-wide inbox lookup (a string where the map belongs);
comparing a bare relay DID instead of the pair; writing `inboxes` through
`setSettings`; forgetting an entry outside the reconcile; or reintroducing a
default relay — `tests/wallet-inbox.test.mts` fails on any DID literal with a
real identifier body anywhere in `src/`, which is what a default becomes.

## A CORS refusal is unreadable, so it is inferred

Chrome hands JavaScript a bare `TypeError: Failed to fetch` for a CORS
refusal, a dead host and a DNS failure alike; the actual reason ("No
`Access-Control-Allow-Origin` header is present") goes to the devtools console
and nowhere an extension can read. It cannot be recovered from the exception —
don't try. `transport-diagnosis.ts` infers it from one bit instead: a request
that fails at the network layer against a host that answers an opaque
(`mode: "no-cors"`) probe a moment later was refused by policy, not by the
network. Discrimination is structural — `TypeError`, `DOMException.name ===
"TimeoutError"` — never message text (R3.7).

This matters because **the mediator's auth handshake is CORS-governed even
though its WebSocket is not**. `authenticateToMediator` POSTs to
`{authEndpoint}/challenge` before any socket exists, so a mediator whose
`[security] cors_allow_origin` omits this extension's origin takes out TSP and
DIDComm together — they share that handshake — leaving REST carrying
everything and **the inbox dark**. A host permission is deliberately not
requested for it: the mediator applies the same origin policy to the WebSocket
upgrade server-side, where no browser permission reaches, so the fix is the
mediator's config and the wallet must say so rather than imply it can fix it
locally.

The self-test (`runDiagnostics` in `offscreen.ts`, surfaced by
`diagnostics-panel.tsx`) exists because **`curl` cannot reproduce this**: a
terminal sends no `Origin` header, so the endpoint answers perfectly and the
operator concludes nothing is wrong. The wallet is the only place the question
can be asked truthfully. Its checks are read-only, and its `checkCorsReachable`
must keep using a plain `GET` against the *same* endpoint that fails — no
custom headers, so no preflight, and any status is a pass because reading a
status at all proves the origin was allowed. Swapping it for a health endpoint
would test a different policy than the one that breaks.

## Repo mechanics worth knowing before you start

- **Build `core` before typechecking anything that depends on it.** Each
  workspace typechecks against its dependencies' emitted, gitignored `dist`,
  so a stale `dist` produces phantom "cannot find module" / "no exported
  member" errors in source that is perfectly correct. `tsc -b` walks the
  project references and builds them in order.
- **Never `rm -rf packages/core/dist` on its own — use `npm run clean`.** The
  `.tsbuildinfo` survives the delete, so the next `tsc -b` believes the output
  is current, **prints nothing, exits 0, and emits no files**. Every dependent
  workspace then fails with "cannot find module `@openvtc/pnm-core`" across
  dozens of files, which reads like a broken package rather than an empty
  `dist`. This is the nastier sibling of the stale-`dist` trap above: there the
  build tells you something is wrong, here it reports success. The `clean`
  script removes `dist` *and* `*.tsbuildinfo`, which is the whole reason it
  exists; `tsc -b --force` also works.
- **Lint is `tsc -b`, never `tsc -b --noEmit`** — the latter is invalid when a
  referenced composite project must emit (TS6310) and fails outright.
- **Never add a cross-workspace import without the matching `references`
  entry** in that package's tsconfig, or `tsc -b` cannot know the build order.
- **`packages/core` is layered, and the layering is enforced.** Modules import
  downwards only — `util`/`http` → `did`/`didcomm`/`webauthn` → `siop` →
  `trust-tasks` → `vta` → `store`/`vault`/`device`/`provision`/`rp-login`/
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
- **`@swc/core` and `@swc/wasm` are pinned below 1.16, and the pin is load
  bearing.** `vite-plugin-top-level-await` (1.6.0, its latest) hands swc a
  hand-built AST node and calls `printSync`; swc 1.16 tightened AST validation
  and rejects it with `missing field \`type\``, taking out the `pwa` and
  `extension` vite builds. The plugin declares `@swc/core: ^1.12.14`, so a
  caret happily resolves the version that breaks it — which is why this is a
  root `overrides` entry (`~1.15.47`) rather than anything a workspace can
  express. Both packages are pinned, not just `core`: the plugin falls back to
  `@swc/wasm` where there is no native binding, so pinning one leaves the same
  break waiting on a different platform. **Verified 1.16.0 and 1.16.2 both
  fail**, so this is the 1.16 line rather than one bad patch. Lift it only when
  the plugin ships a fix — and re-run `npm run build`, because `npm test`
  passes either way (the failure is in the bundler, not the type checker).

- **Stub `Response` objects with a real `Response`**, not an `{ ok, json }`
  literal. A hand-rolled stub only implements whatever the code happened to
  call when it was written, and stops representing a Response the moment the
  code reads the body a different way.
- **Node unrefs the timer behind `AbortSignal.timeout`**, so a test awaiting
  one needs something else holding the event loop open or the process exits
  first — it passes locally and fails in CI as "Promise resolution is still
  pending".
