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

## Setup asks two questions, and they are not the same question

**How far this wallet's authority reaches** and **which context it keeps its
own settings in** are separate, and collapsing them is the mistake the flow is
shaped to prevent. A management console needs authority over every context
*and* one ordinary context to store its state in; expressing "everywhere" by
leaving the context blank would leave it nowhere to put that.

So `onboard-view.tsx` asks both, always. The old flow asked neither properly:
it offered "let the agent choose" (omit `payload.context`, let the inference
rules run) and the reply does not have to name what they picked — so a wallet
could finish onboarding without knowing where its own configuration had landed.
`context` is now a **required** input to `runProvisionIntegration`, which also
makes `provision/integration:contextRequired` unreachable: inference never
runs. The picker that recovered from it was deleted rather than kept for a case
that cannot arise.

**The scope is a wire field, and it is new.** `adminScope: "context" |
"unrestricted"` on `provision/integration/0.3` — `context` (default) binds the
minted admin to the target context, `unrestricted` binds it to none, which is
what an ACL reads as a super-admin. Before it existed the VTA wrote
`allowed_contexts: vec![context]` unconditionally, so **a wallet could not come
out of provisioning as anything but a context admin** and the console had no
way to be granted what it needs. The ephemeral relayer's own super-admin-ness
was never inherited; it only ever affected context inference and inline context
creation.

**Two floors, and both are correctness constraints rather than version
preferences.** `@openvtc/trust-tasks` **0.17.4** is the first binding declaring
`adminScope` and the `context` / `adminScope` summary members; below it this
package cannot name them. `trust-tasks-rs` **0.18.3** is the first schema the
VTA can carry them under, and the VTA pins it as a floor for a reason worth
knowing here: its dispatch spine validates **outgoing** responses against that
embedded schema, not just inbound payloads. Against 0.18.2 the members are
emitted and then rejected by the agent's own guard, so a provisioning that
fully succeeded comes back `500 responseSchemaViolation` — not a dormant
feature, a broken one.

**The order of the two questions differs by scope, and that is forced.** The
grant command has to match the scope and only the operator can run it:
`unrestricted` prints `pnm acl create … --role admin` with **no** `--contexts`,
so the home context is asked *after* the grant, from the list the now-authorised
ephemeral reads (`OFFSCREEN_ONBOARD_CONTEXTS`, speaking as the ephemeral —
distinct from `OFFSCREEN_LIST_CONTEXTS`, which speaks as a holder that does not
exist yet). `context` scope prints `--contexts <id>`, so it must be asked
*before*, as a text field.

**`grant-command.ts` is a `.ts` module with tests because a printed string is a
security decision here.** Both ways of getting it wrong are silent: omit
`--contexts` and the operator grants the whole agent while the screen says one
context; include it for an unrestricted wallet and the provisioning is refused
after they ran a command they were told was right. It also ended a live bug —
the flow printed `--role super-admin`, which `pnm acl create` does not accept
(the roles are `admin`, `initiator`, `application`, `reader`; super-admin is the
*shape* of an admin grant, not a role name).

**What is stored is what the agent said, never what was asked.**
`Connection.homeContext` and `Connection.agentScope` come from
`summary.context` and `summary.adminScope` on the reply. An agent that does not
implement `adminScope` ignores an `unrestricted` ask and writes a
context-scoped entry *while replying success* — indistinguishable from having
honoured it, except by the echo. Absent reads as `"context"`. On a connection
made before any of this, both are absent, and `WalletStanding` in
`setup-pane.tsx` says "not recorded" rather than guessing.

**What breaks it:** making `context` optional again anywhere on the path;
reading `adminScope` back from the request instead of the reply (`?? "context"`
is the fallback, never `?? opts.adminScope`); building the grant command
anywhere but `grant-command.ts`; offering inline context creation on the
context-scoped path (the agent's context-create gate is super-admin-only, so it
could only ever fail); or sending a context on an unrestricted `prepare`, which
would render as `--contexts` and scope the very ephemeral that then has to
confer an unrestricted admin. `tests/grant-command.test.mts` and
`tests/onboard-scope.render.test.mts` pin each of these.

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
something is selected — an attribute's reach runs *down* to the contexts it goes
to, a context's runs *up* to the attributes it holds — is computed in
`identity-graph.ts` and tested; the component only draws. The on-screen words are
an **attribute**, a **face**, a **context** and a persona that **wears** a face,
per `design-docs/persona-vocabulary.md`. The word for a value the holder keeps is
the spec's own: *fact* asserted a truth the model cannot promise — the card said
it directly above a provenance line reading *you said so* — and `fact` was
already spent on `vtc-service`'s verified policy inputs, very nearly the opposite
meaning in the same product (#191). It is banned from screen copy, and
`manager-holder-gate.test.mts` checks. The remaining spec words (`profile`,
`binding`, `materialise`) stay in code and off the screen. Add copy in those
words, or change the document first.

**Every editor opens as a popover, anchored to what was clicked.** This was
the console's loudest defect and the fix is structural, so it is worth knowing
before touching a form. Editors used to render at the *end* of the map's JSX —
after the attributes, the faces, the divider, the contexts and the selection
strip — which on a populated wallet put the first field around 1700px down a
2450px scroller whose `scrollTop` never moved, with focus left on the button.
Pressing *Add an attribute* changed nothing a person could see; the list and
worlds screens instead *replaced* the list, so the thing being worked on
vanished. `popover.tsx` is now the one behaviour: positioned `fixed` against
the anchor (measuring against a scroll container means knowing which one, and
being wrong glues it 800px away), focus moved into the first field, `Escape`
closing it and returning focus. An `Editing` state therefore carries the
element it was opened from — that is not decoration.

`Panel` reads `ChromeProvided` and drops its own border and padding inside one,
rather than four editors each learning where they are being shown. And
`[role="dialog"] *` sets `min-width: 0` in `manager-theme.css`, because a grid
item's default `auto` refuses to shrink below its content and one long help
paragraph sized the editors past the popover's edge.

**Worlds live on the map, and the Worlds tab is gone.** A grouping you cannot
see beside the things it groups is a list of names, and arranging faces on one
screen while looking at them on another is the same act performed twice. Faces
sit inside world bubbles and move by dragging; `worlds.tsx` is now only the
editor the popover mounts. The view toggle is **Map / List / Released**, and
`Released` is a promotion rather than an addition: the disclosure history is the
biggest privacy answer this product has and it used to be a footer under every
other view.

`movePlan` (`world-model.ts`) owns a move, and the **order is the reason it is a
function**: `facet/put` replaces, and the agent refuses to place a face that is
already placed, so the source is rewritten without it before the destination is
rewritten with it. Every write carries live membership via `seedMembership` — a
put echoing a dangling id is refused `unresolvedReference` and leaves the world
uneditable (plugin #216).

**A card is closed until it is selected.** An attribute card draws its type and
one of three words — `shown`, `hidden`, `held back` — and never the value;
selecting it expands it in place. Those three stay three: *hidden* is a value in
hand behind a mask, *held back* is one the agent never sent, and collapsing them
is exactly the defect the reveal path exists to end, one layer up. The detail
strip **no longer renders the value at all**: two `AttributeValue`s for one
attribute is two *Show* buttons and two reveal states, and the second is always
the one that stops being maintained.

**What breaks it:** rendering an editor inline again, or as a mode that replaces
the list; dropping the anchor from `Editing`; re-adding a Worlds pane; reading
`.faceIds` off a facet to build a move instead of `movePlan`; drawing a value on
a closed card; or letting the strip render one again.

**Colour on the map carries three things, in three channels that never
overlap.** The **border** is selection and reach; the **inset stripe** on an
attribute card and the dot on a face's chips are its claim-type family; the
**pills** are status. A world's colour is a **fourth** categorical set and it
does not touch any of those: it is the *ground* of the bubble the faces sit in,
plus a 6px dot on an attribute card — surfaces the three channels do not use.
Putting a world hue on a card border or in a pill is what breaks this.

Reach is drawn in two hues rather than one because
`reachOf` was always asymmetric and the single accent hid it: down is a copy
**leaving** the holder (`--m-act-data`, borrowed from the contexts band it ends
in), up is what a context **holds** of them (the accent). `Flow` is computed in
`identity-graph.ts` with the rest of the model, so the component still only
draws. The family hues (`--m-fam-*`, `manager/attribute-family.ts`) are
**categorical**, the same species as the act colours in `manager-theme.css` and
bound by that file's rule: `--w-ok` / `--w-warn` / `--w-danger` stay the only
colours that mean anything. `familyOf` groups **only** roots the **agent's**
registry declares and this console has placed (`PLACED_ROOTS`) — a family the
agent serves that this build predates is `unregistered`, which is the honest
answer for one rather than a gap. It groups only roots the registry declares — `profile.*` and `employer` are `unregistered`, not a
"profile" family invented here — and no family's words may claim the colour
protects anything, which `manager-attribute-family.test.mts` asserts directly.

**A context is one of four things, decided once.** `standingOf` /
`tallyContexts` (`identity-graph.ts`) answer `known` (a persona wears a face),
`identified` (a persona is present wearing nothing), `unreadable`, `absent`.
`identified` is a real state, not a rounding error: `persona/binding/list/1.0`
enumerates the personas *present* in a context and carries `bound` separately,
so unbinding a face leaves the persona — that context still knows an identifier
of the holder's and can address it, while holding none of their attributes. The
header, the band and the fold row all read this one predicate. They used to use
three different tests, which is how the live console came to say "known in 1 of
12" above two cards with ten folded away — and the state itself had no words on
screen at all.

**What breaks it:** counting contexts anywhere but `tallyContexts` (the numbers
stop closing, and the one that is wrong is the one nobody re-checks); folding
`identified` in with `absent` (an identifier the holder has out there,
disappeared); painting reach in one hue again; putting a family hue on a card
border or in a pill; adding a `--m-fam-*` for something that is *state*; or
giving `familyOf` a prefix rule the registry has not declared.

**Sensitive values are hidden from the screen, and that is all it is.**
The claim-type table is **read from the agent**, through
`persona/claim-types/list` — `@openvtc/pnm-core/persona`'s `listClaimTypes`,
loaded by `panes/persona.tsx` beside the pool and threaded down as a prop.
`manager/claim-sensitivity.ts` used to carry a vendored copy; the copy was
*correct*, which was never the problem. A copy of a table two repositories do
not own costs a re-sync pull request against each on every change, and can only
describe the tokens its own build knew about — an agent serving an extension
type is invisible to a client shipping its own.

**Resolution lives in core** (`resolveTreatment`), beside the served table, and
the strictness orderings come from the agent — so "more protective" means the
same thing on both sides, and a maintainer adding a stricter mask style is
honoured without a rebuild. An axis value this build does not recognise is
treated as **most** protective. `treatmentFor` still applies the holder's
decision over that answer, unchanged: only the axis they decided moves, and a
*declared* token's mask never does.

**`null` is a real state and it fails closed.** While the table is in flight
every value is masked and every attribute groups as `unregistered`, attributed
to the registry rather than the holder — claiming `source: "holder"` for a
default would put their name on one. There is deliberately no compiled
fallback: a stale copy resolving a token the agent has since tightened is the
failure the registry exists to end.

An unregistered or `x:` token resolves to the conservative default
(`high`/`full`) per §4 rule 3. The prefix walk **is** rule 3 and it only ever
*tightens*: an unregistered token takes the more protective of its longest
registered prefix and that default, per axis — so `payment.giftCard` inherits
`payment`'s gating and cannot be escaped by inventing a token, while
`name.somethingNew` does **not** inherit `name`'s `none` and stays masked. (This
note used to say there was deliberately no walk, which was true of the table
before the registry gained one in trust-tasks#377.) A local rule that walks in
the *loosening* direction is still the thing to refuse.

**The mask is not the control. The request is.** Masking a value already
fetched defends a shoulder, a screenshot and a screen share, and nothing else —
never say more than that about it. The control that matters is on the read path,
it now exists, and the console uses it: `includeSensitive` on
`persona/attribute/list` (trust-tasks 0.17.4). The pane lists with
`includeValues` and **without** it, so the plaintext of every `sensitivity: high`
attribute is genuinely not in the page, and *Show* is the request for one —
`manager/reveal-value.ts`, narrowed by `typePrefix` to that attribute's type and
matched back by `attributeId`, because there is no `attribute/get` and a type can
have siblings. *Hide* then **drops** what was fetched rather than covering it.

Before this the console never sent the member, so the agent answered with the
metadata of every sensitive attribute and the plaintext of none — and the pane
drew a mask over the placeholder. A card read `••••` beside a *Show* that
revealed "not requested", under a line promising the agent "has already sent
this value here". Two states, one shape on screen, and the reassuring one was
the lie.

**What breaks it:** setting `includeSensitive` on the pane's own listing (three
lines, every *Show* instant, and every card and passport number the holder owns
sitting in a React tree because a button *might* be pressed — the decorative
version with extra steps); masking a withheld placeholder, which claims a value
is being held back when none arrived; matching a reveal by position rather than
`attributeId`; or a *Hide* that only covers what a press fetched.

**The holder outranks the registry, and "not decided" is a state.**
`sensitivity` and `release` are per-attribute members that are present **only**
where the holder chose one; absent means the claim-type registry answers.
`treatmentFor` applies the first over the second and reports which spoke, so a
pane can say *you decided* without ever putting the registry's answer in the
holder's mouth. The editor offers three options per question, and *let your
agent decide* writes the member **absent** — never the resolved default, because
`persona/attribute/put` is a **replace** and freezing today's answer means a
later tightening of the registry protects every new attribute and leaves this
one exposed. The same replace semantics are why an editor must send back the
decisions it loaded: omitting them silently cleared the holder's gate on every
save, and nothing in the response said so.

**One narrow exception, and it is the reason the feature works at all.** A
holder's `sensitivity` moves that axis only — a declared token keeps the
registry's mask (§3.3: the axes are independent, and `phone.mobile` stays
`•• 25` however the holder marks it). For an **unregistered** token there is no
such statement to respect: `UNREGISTERED` is one conservative answer covering
both axes precisely because nobody had reasoned about the token, so the holder
deciding is the decision it stood in for, and the mask follows them. Without it,
marking your own `profile.github` as showable still drew four bullets, by a rule
justified only by nobody having looked.

**Masking follows the mask style, not the sensitivity.** They are independent
per §3.3; `maskedFact` gated on `high` anyway, so `email.*` (`normal` /
`emailLocal`) was called hidden by `isSensitive` and drawn in full by the
renderer — a promised *Show* button that never appeared.

**A decision does not wait for the table.** `treatmentFor` applies the holder's
`sensitivity` first, before it looks at the registry at all — §4 rule 1 makes
their answer win, so where they gave one there is nothing to combine and nothing
to wait for. It used to return the fail-closed floor for a missing registry
*before* reading the override, which meant an agent that does not implement
`persona/claim-types/list`, or failed to answer once, silently overruled every
choice the holder had made about their own values. The mask axis still keeps a
*declared* token's registry mask; with no table, whether the token is declared is
unknowable and the holder is the only evidence there is.

**A missing table is not a statement about a token.** `source: "unknown"` and the
`unknown` family exist so the screen can say *your agent has not said* rather
than *your agent's table does not declare these* — the second is a claim about
the tokens that nobody checked, the same error as reporting an unreadable
context as an empty one. `persona.tsx` surfaces `registry.error` in a note (it
used to swallow it on the reasoning that "the same agent answers both", which is
false: they are different tasks and a live wallet listed its pool perfectly while
serving no table), and `reloadAll` reloads it — left out, one failure kept every
value masked for the life of the tab.

**An editor may not write a value it never held.** The pane lists without
`includeSensitive` — the point of #194 — so an existing sensitive attribute
reaches the editor with `value: undefined`, `rawValue` turns that into `""`, and
`attribute/put` **replaces**. Opening a withheld attribute to change its label
or its visibility therefore wrote an empty string over a value the console had
never seen, silently and unrecoverably: there is no `attribute/get`, no version
history, nothing to restore from. `AttributeEditor` now fetches the value on
open (the same one-attribute request *Show* makes) and, separately, refuses to
save while it is neither loaded nor typed. Two mechanisms on purpose — the fetch
is the convenience, the refusal is the property.

**The holder's decision has to reach the copy, not just the original.** A claim
inside a face or a binding carries no `sensitivity`; the decision lives on the
pool attribute it was materialised from, above the boundary those panels sit
below. `decidedSensitivity` matches a resolved claim's `attributeId` back to the
pool, so "what someone would receive" answers the way the card does. An
**inline** claim has no `attributeId` and no pool ancestor, so the registry
answers for it — the right answer, not a gap.

**What breaks it:** a control that writes `raw` without going through
`editValue` (the guard then reads a typed value as one nobody typed); dropping
either half of the editor's protection; rendering a claim without the pool where
one is in hand; writing a resolved default into `sensitivity` or `release`;
an editor that omits them and so clears them; treating absent as `normal`
(`treatmentFor`'s `source` is the difference); extending the unregistered-mask
rule to declared tokens; or gating a mask on `sensitivity` again.

**A `release: stepUp` disclosure is refused, and the refusal is returned rather
than thrown.** `payment.*` and `gov.*` resolve to `release: stepUp` in the
registry, so the agent refuses `persona/disclosure/present` until it holds a
fresh approval **bound to that `previewId`** — bound to the session, "each
time" would mean "once per login". `presentDisclosure` therefore returns
`Disclosed | DisclosureStepUpRequired` rather than a `Disclosure`, on the same
reasoning as `ConsentRequired` in `vta/request-task.ts`: a refusal carrying
what the holder must act on is the worst thing to let propagate as an error.
The union landed **before** any surface drove a disclosure, which is the cheap
moment — after N callers exist it is a breaking change to each.

**Match it on the top-level `code`, not `details.reason`.** This is the one
asymmetry with the consent refusal next door, and the reason
`persona/step-up.ts` says so twice: `ConsentRequired` rides in `details`
because the VTA rejects it as the standard `taskFailed`, while
`persona/disclosure/present/1.0` declares its own extended code and the agent
emits it at the top level. Looking in `details` for this one finds nothing and
the flow dies silently — exactly the defect the consent path already shipped
once.

**Everything the holder is shown comes out of the signature.** The refusal
carries an agent-signed approve-request whose `ext` names the verifier, the
claim types and the purpose; the unsigned half of the refusal carries no
authority. `verifyDisclosureStepUp` adds the check
`verifyStepUpApproveRequest` cannot know to make: **the `previewId` inside the
signature must equal the one the refusal named**, or the holder read a prompt
describing one disclosure and authorised whichever the signed document meant.

**The verify/sign half of the step-up ceremony lives in `vta/step-up.ts`, not
`rp-login/`.** Two unrelated callers need it — the did-hosting RP gets its
approve-request from a REST `start`, `persona/` gets one inside a Trust-Task
refusal — and `rp-login/` and `persona/` are the same layer, so neither can
import the other. It moved *down* rather than earning a boundary exception or
a second copy. `rp-login/step-up.ts` re-exports every name, and
`tests/rp-login.step-up.mjs` passes unchanged, which is what says the move was
non-breaking.

**Reveal lives in `AttributeValue`'s own state**, per value, and nowhere else. Lifted
to the pane and keyed by fact id it would be a store of "things unhidden" that
outlives the card the person was looking at and is one refactor from a *Show
all*. Component state cannot become that: it dies with the element, so leaving
the pane re-hides everything — `persona-pane.render.test.mts` mounts twice to
pin exactly that, since every sticky implementation passes a single-mount test.

**What breaks it:** reading `presentDisclosure` as returning a `Disclosure`
again, or catching the refusal and rethrowing it; matching the step-up code in
`details.reason`; rendering the verifier or claim types from
`unverifiedApproveRequest` instead of the verified `context`; dropping the
`previewId` cross-check; moving the verify/sign half back up beside the RP
flow; a surface that formats a value itself instead of rendering
`AttributeValue` (the second surface is always the one added later, and a value
masked on the card and printed in the strip is masked nowhere); greying a mask
with `c.faint`, which is this pane's word for "the agent sent no value" and so
makes a fact the holder has look like one they do not; reintroducing a compiled
table as a fallback for a registry that has not loaded; or letting a UI string
imply the console does not hold
what it hides.

**A listing is read to the end, and that is the client's job.** Every
`persona/…/list` task is cursor-paginated, and the specification is explicit: a
producer MUST NOT infer exhaustion from a short page — only an absent
`nextCursor` means the end. `personaAttributeList`, `personaProfileList` and
`listBindings` returned the first page and dropped the cursor, which nothing
downstream could detect, because a short array is indistinguishable from a
complete one: past the agent's page size (100 by default) the identity map drew
a face pointing at attributes that were not in its own list, under counts that
agreed with each other because they counted the same truncated array. All three
now follow the cursor through `collectPages` (`core/src/util/pages.ts`), and
`listBindings` returns a document with no `nextCursor` because there is nothing
left to fetch. `limit` on those calls is the **page size to ask for**, never a
cap on the result.

**The bound throws rather than truncating.** `MAX_PAGES` guards against a far
side that will not end — a cursor that repeats, or a pool beyond anything a
picture can draw — and returning what had been collected would reintroduce the
defect one layer down and with a longer array. It is set high enough (50 pages,
25,000 records at the maximum page size) that reaching it means a fault rather
than a large pool.

**What breaks it:** reading `.attributes` / `.profiles` / `.personas` off a
single response again; treating `limit` as a cap; or catching the bound's error
and returning a partial list.

**The console's components are rendered in tests, and this is how.**
`tests/harness/` holds module hooks and a DOM so `node --test` can mount a
pane. Two things it does that are not obvious: it resolves a `./thing.js`
import to `thing.tsx` (the sources use TypeScript's `Bundler` resolution, which
Node does not implement) and transforms JSX with **esbuild** — not
`typescript`, whose 7.x JS API is the native port's small surface with no
`transpileModule` on it. Tests are `.mts` and cannot contain JSX, so compose
with `h(Component, props)`; calling a component runs its hooks outside React
and dies on the first `useState`.

Three sharp edges in the harness itself, each of which failed silently before
it was fixed. **`.ts` goes through esbuild too**, not Node's own stripping:
Node's mode is *strip-only* and refuses a constructor parameter property
(`webauthn-prf-wrap.ts` has one), which surfaces as a parse error in a file the
failing test never mentions. **`react-dom` is imported after a DOM exists** —
it decides `canUseDOM` and probes `isEventSupported("input")` at module scope,
and with those false its change plugin falls back to an input-event polyfill
that infers edits from keystrokes. Clicks keep working, so buttons, radios and
checkboxes are all fine and only *typing* goes quiet: the field shows the text
and the component's state stays empty. **`type()` clears React's
`_valueTracker`** for the same reason a hand-set `checked` does not work on a
checkbox — React drops a change event whose value matches what it last saw.

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

## Data rooms: custody on screen, and a second family a page may not drive

`@openvtc/pnm-core/rooms` is subpath-only — deliberately **not** in the root
barrel, the same discipline `admin/*` and the persona pool follow — and
`manager/panes/rooms.tsx` is the one surface that uses it.

**The rooms family is split across two recipients, and the split is the design.**
`rooms/keys/*` terminates at the **member's own VTA** (their key holder) and
`rooms/owner/*` at the **owner's**; everything else — `create`, `records/*`,
`epoch/*` — is served by the room's **host**, which holds ciphertext it cannot
read. `RoomsCaller` names the two parties for exactly this reason, and
`tests/task-surface.mjs`'s `NOT_IN_SDK` records which half is which: a
host-served verb gaining a `vta-sdk` constant would mean the boundary moved.

**The pane lists key custody, and must never present it as membership.** The two
sets differ in both directions: a room whose Welcome never arrived is absent
though a perfectly good membership credential is held, and a VTA not yet told of
a removal still lists a room it can read and can no longer write to. Authority is
the host's decision, taken from credentials the room issued.

**Two epochs per room, because neither alone is a diagnosis.** `epoch` behind the
room's own means a commit was not delivered; `earliestReadableEpoch` equal to
`epoch` means the epoch key chain has not arrived. Different repairs — and a
member shown only "you can't read this" reads a pending delivery as lost history.
`standing()` maps the pair to the three answers and
`rooms-pane.render.test.mts` asserts each against the words on screen, not
against the function.

**A page may not drive `rooms/*` either**, and the owner verbs are the sharpest
case `page-task-policy.ts` has: they mint credentials in the **room's** name, so
one generic prompt got past an owner is a site issuing itself membership — or
authority to admin the room — and the room would be right to honour it.
`keys/open` returns plaintext the room withholds from its own host, and
`keys/list` is that member's view of what they belong to. The refusal is the
whole family because the boundary is "a page is not a member", not a judgement
about particular verbs.

**What breaks it:** exporting `rooms` from the root barrel (its URIs then reach
the service worker); sending a `keys/*` task to the host or a host verb to the
VTA; drawing a failed listing as an empty one ("this agent holds keys to no
rooms" is a claim, and an agent that did not answer has made none); or rendering
one epoch and calling it the answer.

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
