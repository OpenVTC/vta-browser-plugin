# pnm-browser-plugin

Browser-side bridge between **WebAuthn passkeys** and **VTA-managed
DIDs**. Lets an operator prove control of a DID hosted in a remote
Verifiable Trust Agent by performing a passkey ceremony in the
browser — no DID private keys ever leave the VTA, and no long-lived
bearer token sits in browser storage. Speaks both REST and **full
DIDComm v2** to the VTA, including when the VTA is private-network
and only reachable via a mediator.

## Why

Passkeys solve local user authentication beautifully (synced
keychains, biometric unlock, phishing-resistant). DIDs solve global
identity (self-sovereign, portable, signable). Neither alone solves
"log into a third-party site as the controller of my VTA DID."

This project glues the two together: a passkey is enrolled as a
`verificationMethod` (purpose: `authentication`) in the DID document
the VTA publishes via WebVH. Any verifier that resolves the DID can
then validate a WebAuthn assertion against the embedded public key
without ever talking to the VTA — the DID document *is* the trust
anchor.

```
┌──────────────┐  WebAuthn        ┌────────────────┐
│   Browser    │ ───────────────▶ │  Authenticator │ (Touch ID,
│ (PWA / ext)  │ ◀─────────────── │   / Passkey    │  Windows Hello,
└──────┬───────┘   pubkey + sig   └────────────────┘  YubiKey, …)
       │
       │ enroll(passkey_pubkey)        verify(assertion)
       ▼                                       ▲
┌──────────────┐                       ┌───────┴────────┐
│      VTA     │ ── WebVH update ─────▶│ Public DID doc │
│ (remote)     │                       │ (resolvable by │
└──────────────┘                       │  any verifier) │
                                       └───────┬────────┘
```

## Architecture (layer cake)

```
┌─────────────────────────────────────────────────────────────────┐
│  PWA (Vite + React 19)            MV3 Extension (Vite + React)  │
│  packages/pwa                     packages/extension            │
└────────────────────────────┬────────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────────┐
│  @openvtc/pnm-core                                                      │
│                                                                 │
│  WalletSession ─────────────────────────────────────┐           │
│     │                                               │           │
│     ├─ generateOrLoadHolderIdentity   (KVStore)     │           │
│     │     ├─ IndexedDBKVStore         (browser)     │           │
│     │     └─ InMemoryKVStore          (tests)       │           │
│     │                                               │           │
│     ├─ MediatorClient (coordinate-mediation/2.0)    │           │
│     │     ├─ requestMediation                       │           │
│     │     ├─ updateKeylist                          │           │
│     │     ├─ setLiveDelivery                        │           │
│     │     └─ acknowledgeMessages                    │           │
│     │                                               │           │
│     └─ DidcommVtaTransport (passkey-management/1.0) │           │
│            (implements VtaTransport)                │           │
│                                                     │           │
│  VtaClient  (REST, implements VtaTransport) ───────┘           │
│                                                                 │
│  DidcommMessageBridge interface ┐                               │
│     ├─ WebSocketDidcommBridge   │   multi-sender registry       │
│     │     ├─ RawDispatcher      │   (skid-based JWE peek)       │
│     │     └─ Pickup3Dispatcher  │   (live-mode unwrap)          │
│     └─ InMemoryDidcommBridge    │   (test simulator)            │
│                                 │                               │
│  webauthn/  did/  vta/  store/  didcomm/                        │
└────────────────────────────┬────────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────────┐
│  @openvtc/vti-didcomm-js  (npm dependency)                      │
│     WebCrypto-backed DIDComm v2 primitives                      │
│     Identity { generate, fromSecretJwk, publicJwk, secretJwk }  │
│     packAuthcrypt / packAnoncrypt / wrapForward / unpack        │
│     packAnoncryptJson / packAuthcryptJson (preserves extras)    │
└─────────────────────────────────────────────────────────────────┘
```

Every layer has matching ownership:

- **`@openvtc/vti-didcomm-js`** owns crypto: HPKE-style authcrypt
  (ECDH-1PU + A256CBC-HS512), anoncrypt (ECDH-ES + A256CBC-HS512),
  Ed25519 signatures, Routing 2.0 forward envelopes. Pulled in as
  an npm dependency — no Rust toolchain required to build this
  workspace.
- **@openvtc/pnm-core** owns the wire protocols + transport abstraction.
  REST (`VtaClient`) and DIDComm (`DidcommVtaTransport`) implement
  the same `VtaTransport` interface; pick at boot.
- **Bridge implementations** own network I/O. `WebSocketDidcommBridge`
  is the production bridge (mediator over WSS, Pickup 3.0 live mode
  via `Pickup3Dispatcher`, concurrent thid demuxing).
  `InMemoryDidcommBridge` simulates both mediator and VTA for tests.
- **`WalletSession`** is the only thing the UI talks to. One call —
  `bootstrap()` — does identity load/mint, mediator enrollment (if
  needed), and constructs a ready `VtaTransport`.
- **PWA / extension** are thin shells over `@openvtc/pnm-core`.

## Form factors

| Package | Role |
|---|---|
| `@openvtc/pnm-core` | Wire types, WebAuthn ceremony helpers, COSE→Multikey conversion, DID `verificationMethod` builder, REST + DIDComm transports, mediator client, bridges, wallet orchestration. |
| `@openvtc/pnm-pwa` | Installable web app (Vite + React 19). Operator-facing wallet for connecting to a VTA and managing passkeys. Has a `/smokes` diagnostic page that runs the in-browser smoke suite. |
| `@openvtc/pnm-extension` | Manifest v3 browser extension. Same flows, plus future ability to intercept RP login pages and inject SIOPv2/OpenID4VP responses. |

## First milestone — enroll a passkey as a DID `verificationMethod`

1. Operator points the app at a running VTA and authenticates with an
   existing admin credential (the standard `pnm bootstrap connect`
   flow already produces one) — *or* the wallet bootstraps over
   DIDComm via `WalletSession`.
2. App triggers `navigator.credentials.create(...)`. The authenticator
   produces a credential whose public key is COSE-encoded.
3. App parses the COSE_Key, converts it to **W3C Multikey** form
   (multicodec `0x1200` for P-256 / ES256, `0xed01` for Ed25519,
   multibase-base58btc with the `z` prefix).
4. App POSTs `{ credential_id, multikey_pubkey, attestation_object }`
   to the VTA (`POST /did/verification-methods/passkey` — new endpoint,
   see [docs/passkey-did-binding.md](docs/passkey-did-binding.md) for the
   contract).
5. VTA appends a WebVH LogEntry adding the VM with `id =
   <did>#passkey-<sha256(credential_id)>` and purpose
   `authentication`.
6. From then on, any RP can verify a WebAuthn assertion against the
   VM by resolving the DID — no shared secret, no callback to the
   VTA.

## DIDComm-only VTA support

When the VTA has `services rest disable`'d and is only reachable via
its DIDComm mediator, the wallet stack handles it transparently:

```ts
const session = new WalletSession({
  store: new IndexedDBKVStore(),
  mediator: {
    websocketUrl: "wss://mediator.example.com/ws",
    did: "did:key:zMediator…",
    keyAgreementKid: "did:key:zMediator…#key-agreement-1",
    keyAgreementPublicJwk: { kty: "OKP", crv: "X25519", x: "…" },
  },
  vta: {
    did: "did:webvh:vta.example.com:abc",
    keyAgreementKid: "did:webvh:…#key-agreement-1",
    keyAgreementPublicJwk: { kty: "OKP", crv: "X25519", x: "…" },
  },
});

await session.bootstrap();          // mint or load holder, enroll w/ mediator
await session.setLiveDelivery(true);// pickup/3.0 live-mode push
const challenge = await session
  .transport()
  .requestEnrollmentChallenge(holder.did);  // passkey-management/1.0
```

On first run: mints a did:key holder identity, registers with the
mediator (coordinate-mediation/2.0), persists state.

On subsequent runs: loads the holder identity, detects the existing
mediator relationship, skips re-enrollment.

All messages travel as:
- inner: `authcrypt(holder → VTA, passkey-management/1.0/...)`
- wrapped: `routing/2.0/forward` envelope addressed to the VTA
- outer: `anoncrypt(forward → mediator)`

The mediator delivers the inner JWE to the VTA. Replies travel back
via the wallet's mediator inbox, decrypted by `Pickup3Dispatcher`,
and demuxed by `thid` to the waiting Promise.

### Mediator CORS (browser requirement)

The wallet runs **in the browser**, so the mediator's WebSocket
(`wss://…/ws`) and REST (`/inbound`, `/authenticate`, …) endpoints must
allow the **origin the wallet page is served from** — either by echoing
that exact origin in `Access-Control-Allow-Origin`, or with `*`. This is
a mediator-side configuration; the wallet cannot work around it.

Symptom of a missing/incorrect CORS allow-list: the REST auth handshake
succeeds (or appears to), but opening the live-delivery socket fails with

```
mediator-transport: WebSocket failed to open (close code 1006)
```

A browser rejects a cross-origin WebSocket upgrade *before* the socket
opens, which surfaces as an abnormal **1006** close with no HTTP status —
indistinguishable, from the client side, from a refused upgrade or a
proxy that strips the `Upgrade` header. If REST auth works from the same
page but the WS gives 1006, **check the mediator's CORS allow-list for
your wallet origin first.**

For a self-hosted `affinidi-messaging-mediator`, set the allowed origins
in its config (e.g. `cors_allow_origin`) to include your wallet's origin
(`http://localhost:5173` in dev, your extension/PWA origin in prod), or
`*` for a permissive dev setup. Restart the mediator after changing it.

## End-to-end validation

Six smokes cover the main DIDComm + wallet links. Run from a browser
at `/smokes` or invoke directly via `@openvtc/pnm-core`:

| Smoke | What it proves |
|---|---|
| `smokeAuthcryptRoundtrip` | authcrypt + unpack round-trips intact |
| `smokeBuildDidcommEnrollChallenge` | Full forward+anoncrypt envelope assembly |
| `smokeDidcommVtaTransportRoundtrip` | DIDComm enrollment exchange via in-memory bridge |
| `smokeMediatorEnrollment` | mediate-request → grant → keylist-update |
| `smokeMediatorNotifications` | live-delivery-change + messages-received notifications |
| `smokeWalletBoot` | Full WalletSession bootstrap on first run + resume on second run |

## Status

Scaffold + core enrollment ceremony + REST client + complete DIDComm
v2 stack (authcrypt, anoncrypt, forward, coordinate-mediation/2.0,
pickup/3.0 live mode) + WalletSession orchestrator.

The VTA-side endpoint is documented in
[docs/passkey-did-binding.md](docs/passkey-did-binding.md) but not
yet implemented in `vta-service`; the browser code targets the
documented contract and can be exercised against a mock today.

## Layout

```
pnm-browser-plugin/
├── package.json          (npm workspaces root)
├── tsconfig.base.json    (shared compiler options)
├── tsconfig.json         (solution-style references)
├── docs/
│   └── passkey-did-binding.md
└── packages/
    ├── core/             @openvtc/pnm-core
    │   └── src/
    │       ├── webauthn/      passkey ceremony helpers, COSE→Multikey
    │       ├── did/           verificationMethod builder
    │       ├── didcomm/       TS facade over @openvtc/vti-didcomm-js
    │       ├── store/         KVStore + holder identity persistence
    │       └── vta/           transports, bridges, MediatorClient,
    │                          WalletSession, smokes
    ├── pwa/              @openvtc/pnm-pwa (Vite + React 19)
    └── extension/        @openvtc/pnm-extension (Manifest v3)
```

## Development

Prereqs: Node 24+. No Rust toolchain needed — DIDComm crypto comes
from the `@openvtc/vti-didcomm-js` npm package.

```bash
npm install
npm run build              # tsc -b + vite build across TS workspaces
npm run dev:pwa            # http://localhost:5173
npm run dev:extension      # vite watch into packages/extension/dist
```

### Installing the extension into your browser

After `npm run build` (or while `npm run dev:extension` is running),
`packages/extension/dist/` contains a complete unpacked Manifest v3
extension. Side-load it like this:

**Chrome / Edge / Brave / Arc**

1. Open `chrome://extensions` (or `edge://extensions`,
   `brave://extensions`, `arc://extensions`).
2. Toggle **Developer mode** on (top-right).
3. Click **Load unpacked** and select
   `packages/extension/dist/` from this checkout.
4. Pin **VTA Wallet** to the toolbar (Chrome's puzzle-piece icon →
   pin) so it's one click away.
5. **Setup opens automatically on install.** Work through it top to
   bottom — the order matters. The agent's address comes first because
   its mediator is resolved from it; you're only asked for a mediator
   if the agent publishes none. The passkey lock and your inbox follow.
   You can reopen it any time at **Options → Setup**, or from the
   popup's **Open setup** button.

   The agent field takes either form: an agent name
   (`webvh.storm.ws/@glenn-vta`) or a full `did:webvh:…`. A name is
   resolved in three stages — an HTTPS request that answers with a DID,
   DID resolution, then the document must claim the name back via
   `alsoKnownAs`. The third stage is mandatory: a redirect alone proves
   nothing, since whoever controls a domain can point a name at somebody
   else's DID. The DID is what gets stored; names are re-claimable.

   Stage 1 needs the name's server to answer in a form a *browser* can
   read. The reference (Rust) resolver reads a `did:…` straight out of a
   `Location` header; no browser can, so the wallet sends a browser-shaped
   `Accept` and follows whatever it is given — the webvh hosting service
   answers that with a redirect to the DID's log. A name server that only
   ever answers with a bare `did:` redirect cannot be resolved from an
   extension at all; paste the full `did:webvh:…` instead.

   Onboarding deliberately runs in a tab rather than the toolbar popup:
   Chrome tears the popup down whenever a native dialog takes focus
   (crbug 40721470), and this flow raises two — the host-permission
   grant and the passkey ceremony.
6. Optional extras — a separate approver identity, background wake-up,
   step-up defaults — live under **Advanced** and can wait.

**Firefox**

Not supported out of the box: Firefox's MV3 service-worker support
diverges from Chromium and the manifest would need adjusting. Not in
scope today.

**Reloading after a rebuild**

`npm run dev:extension` rebuilds into `dist/` on change, but Chrome
does not auto-pick up the new bundle for a side-loaded extension.
After each rebuild, click the reload icon on the **VTA Wallet** card
in `chrome://extensions`.

**Debugging**

`chrome://extensions` → **VTA Wallet** → **service worker** opens
DevTools for the background script. The popup, options page, and
offscreen document each have their own DevTools — right-click →
Inspect on the popup, or use the **Inspect views** links on the
extension card.

### Permissions model

The extension requests **no host permissions at install time** and declares
**no static content scripts**. The manifest carries `optional_host_permissions`
only, and the page provider is registered at runtime for granted origins
(`src/content-registration.ts`) — so the install prompt no longer asks to read
and change your data on all websites.

A grant means two things at once: the wallet may talk to that host, and
`window.vtaWallet` exists on its pages. Turning a site off in **Sites** stops
both.

The wallet asks for one origin at a time, at the moment it needs it:

- **Connecting to a VTA** — the host is read out of the `did:webvh` before any
  request is made, and Chrome prompts on the Prepare click. Needed because
  vta-service applies an origin-allowlist CORS layer.
- **Visiting a site for the first time** — the popup shows "Enable on
  <site>". Until then the site cannot see the wallet at all, so its sign-in
  button does nothing; enabling registers the provider and reloads the page.

Resolving DIDs needs no grant: the did:webvh hosting service serves public
resolution with `Access-Control-Allow-Origin: *`. A did:webvh host behind a
restrictive CORS policy is the known gap — it surfaces in the consent prompt
as an unresolved DID, which fails closed.

### Signing in to a community: trigger links, and the legacy methods

A community portal signs a member in by showing a **sign-in code**: a QR code
that is also a link (`https://link.trustoverip.org/t#_from=<VTC DID>&_id=…`,
VTI spec chapter 7a). On the same computer, clicking the code opens this
wallet's sign-in window instead of navigating: the wallet checks the community
is one of yours, verifies its DID document, refuses a code clicked on any page
but the community's own portal, and claims the request (`auth/oob/*`). With
more than one identity for the community it first asks "Sign in to <community>
at <portal>?" and which one; with one (entries for the same DID count once) the
click is the go-ahead. The two-digit number the portal shows is read from that
page once the portal shows it — the element carrying `data-oob-request-id` and
`data-oob-match-number` (sign-in contract C11) — so you do not type it; a
portal that does not publish it, or a community whose name differs from your
record, gets the number screen instead; that screen offers "Call it <name> in
my wallet", which renames your record to the community's name (so the next
sign-in has nothing to flag) and goes on. The community still checks the
number.
Then the window shows where the request came from, and Approve signs the grant
with your passkey. The page is told nothing; the portal learns the outcome from
the community.

A site the wallet does not know yet gets the same checks first: its DID
document is resolved and verified, and the code must have been clicked on its
own portal. Nothing is sent to it until you agree, and declining or closing
the window sends nothing at all. What happens next depends on what its verified
document says it is:

- **A DID hosting service** (it publishes a `WebVHHosting` service): "Use
  <host> to host your DIDs?", with the DIDs your agent hosts to choose from. Yes
  records it in your vault exactly as the older `proxyLogin` first-use prompt
  does — a `did-self-issued` entry for the portal's origin and the service's
  DID, in the chosen DID's context — and the window goes straight on to sign
  in with it for the same code. The service admits only DIDs its operator
  has added to its access list. If it has not added yours, the window says
  "<host> hasn't added you yet. Send this DID to its operator:" and shows the
  DID with a Copy button; the same screen appears for an identity you have
  used there before that it no longer admits.
- **A community (VTC)** (it publishes a `VTCRest` service): "Join <host>?".
  Still nothing has been sent. **See what it asks** fetches the community's
  join manifest (`vtc/join-requests/manifest/0.3`) as a throwaway key, so the
  community learns nothing about who is asking. The window then shows whether
  it admits members straight away or an administrator reviews each request,
  the details it asks applicants to give (required ones must be filled in),
  a "List me in its public member registry" box (unticked unless you tick it),
  and who to join as. First, and chosen unless you pick otherwise, is **a new
  identity for <host>**: your agent sets up a context of its own for the
  community (`vtc-<host>`) and a new DID in it, published through one of its
  DID hosting servers (you choose which when it has more than one), so the
  community learns of no other identity you hold. It is made only when you
  send the request, and a request that fails after it is made reuses it next
  time rather than making another. It needs an agent this wallet administers
  with at least one hosting server; without one it is shown but can't be
  chosen. Below it are the DIDs your agent already hosts, each marked with any
  site it is already used at, since one identity used at two communities links
  them. **Send request**
  records the community in your vault (the same `did-self-issued` entry a
  member's sign-in uses: the portal's origin and the community's DID, in the
  chosen DID's context) and sends `vtc/join-requests/submit/0.3`, signed by
  your agent as that DID. The entry comes first because your agent signs only
  as a vault entry's identity, and the community takes the applicant from that
  signature. Then:
  - **Admitted straight away:** the window goes on to "Sign in to <host>?" for
    the same code.
  - **Waiting for an administrator** (or for more evidence): "Request sent —
    you can sign in once <host> approves it". Nothing else is sent, and the
    vault entry stays, because the request is open under that DID.
  - **Already a member** as that DID (`submit:alreadyMember` — joined from
    another wallet, or the entry here was removed): nothing is queued; the
    window says so and goes on to "Sign in to <host>?", keeping the entry.
  - **Declined, or the request was refused** (not accepting members, a
    required detail missing, unreachable): the reason, plainly, and the vault
    entry is removed again.

  **Already a member, from the join page.** A portal marks the code on its
  join page `data-oob-intent="join"`. When this wallet already signs in to that
  community, the sign-in screen does not go on by itself: it says you are
  already a member and offers **Join with a new identity** beside signing in.
  That reads the manifest as above, without the identities you already use
  there, and makes the new identity in a context none of them is in
  (`vtc-<host>`, else `vtc-<host>-2`, …). The page's mark only changes what you
  are offered; nothing is sent until you choose.

  A community whose every way in needs something this wallet cannot send yet —
  a credential, an invitation or identity vetting — gets a screen that lists
  what it asks for and closes; nothing about you was sent. VTC DID documents
  do not advertise a join page to link to, so the window names the verified
  address to ask.
- **Anything else:** "Not one of your communities", with its verified sign-in
  page.

Each browser is one of your devices at your VTA. Every install (every browser
profile) has its own holder identity, so it registers itself separately
(`device/register`, as `companion`/`browser`, named like "Chrome on macOS")
after onboarding, when it first connects to your agent, and before a sign-in.
An install from before this registers on its next unlock, with no new
onboarding. A second browser or a phone registers under its own identity and
does not disturb this one, and disabling one device at your agent leaves the
others signing in. A browser that has been disabled is told so, rather than
retried.

Approving uses the wallet's one passkey. The VTA signs a grant only on a
decision made by this browser's user-verification key: an Ed25519 `did:key`
per agent, held sealed under the passkey's PRF output, which the authenticator
yields only after a PIN or biometric. Each approval runs the passkey ceremony
bound to that grant's digest and unseals the key for one signature. The first
approval mints the key and enrols it with your VTA (`device/heartbeat`
`org.openvtc.uv-key`, kind `prfSealedKey`, never claimed as hardware-backed).
A wallet with no passkey yet creates it at that first approval, which also
encrypts that agent's wallet record at rest. So a browser needs one passkey,
and one gesture per approval after the first; on Linux, where Chrome has no
built-in authenticator, that is one security-key or phone prompt.
A security key (YubiKey 5, Nitrokey 3) needs a FIDO2 PIN set, and is touched
twice when the passkey is first made: most keys give the PRF output only on an
assertion, not at registration. Password-manager extensions such as 1Password
supply passkeys only to web pages; they cannot answer for another extension's
pages, so the wallet's prompt is always the browser's own.

What it does not give: a PRF output is a secret, not a one-time signature. A
copy of IndexedDB opens nothing, but code running inside the extension that
captures one approval's PRF output could keep the unsealed key and approve
later grants with no gesture, which a per-grant WebAuthn assertion would not
allow. The VTA records the kind, so its policy can tell the two apart.

#### Approving without a passkey: a PIN, or your phone

A browser that can't keep a PRF passkey (Linux Chromium without a security
key, or a 1Password user) approves sign-ins one of two other ways, chosen once
per agent. The review screen offers "Use a PIN or my phone instead", and Approve
goes straight to that choice when the browser says it has no PRF or the passkey
turns out not to support it.

- **A PIN** (`vtaPin`): six or more characters, digits or a passphrase. The
  wallet derives a key from it (PBKDF2-HMAC-SHA256, 600 000 iterations) and
  enrols that with your agent; each approval sends an HMAC of the grant digest
  under the key, beside a decision signed by this browser's own device key. Your
  agent checks it and locks it after 5 wrong tries (15 minutes, doubling after
  each further wrong one). The wallet keeps only the salt; never the PIN or the
  key. A browser whose storage was cleared gets the salt back from the agent,
  which reports it on every `device/heartbeat` response. A forgotten PIN: an
  administrator disables the device at the agent and you connect this browser
  again.
- **Your phone** (`remoteApprover`): pick one of the phones your agent lists
  (`device/heartbeat` with `ext["org.openvtc.uv-approvers"] = {}`). Each
  approval asks the phone; the window shows the code the phone shows beside the
  request and waits until you approve or decline there. The agent lists a
  phone only when the OpenVTC app on it is connected to the same agent **and**
  an administrator of the agent has made it this browser's approver (its
  `stepUpApprover`, or a member of an approver set), and never one this browser
  created. See the VTA's `docs/02-vta/wallet-sign-in-uv-keys.md`.

Settings → Advanced → **Sign-in approval** shows each agent's method and lets
you change the PIN or switch between a PIN and your phone. Replacing a PIN needs
the current one.

#### When a sign-in code isn't accepted

The window tells the person only the outcome ("Code not accepted", "Community
unreachable", ...) and never which part of the code was wrong (VTI-LNK-021).
When the cause is the service's DID document or the page the code was on, the
collapsed **Details** line says what the operator has to fix, with the DID (and
a Copy button) or the origins that were checked. Nothing in it is logged.

| Code | Details says | How the operator fixes it |
|---|---|---|
| `no-portal-service` | The DID document doesn't list a sign-in portal (a `SignInPortal` service), or lists one whose endpoint isn't usable. | Add a `SignInPortal` service whose endpoint is the sign-in page: an `https` URL on a public host name, no port or credentials. |
| `no-common-transport` | The DID document doesn't list a Trust-Task endpoint (a `TrustTaskHTTPS` service), or lists one whose endpoint isn't usable. | Add a `TrustTaskHTTPS` service whose endpoint is the Trust-Task base (the wallet posts to `<base>/trust-tasks`), with the same URL rules. |
| `wrong-origin` | This page (`https://a`) isn't the service's sign-in page (`https://b`). | Show the code on the `SignInPortal` page's origin, or point `SignInPortal` at the page that shows it. |
| `did-document-unverified` | The wallet couldn't fetch or verify the DID document, with the DID. | Check the DID resolves, its log verifies, and its host is a public name on the default `https` port. |
| `from-not-allowed` | Sign-in doesn't accept a `did:key` (or other named method) DID as the service's identifier. | Use a DID that can list services, such as `did:webvh`. |
| `unsupported-vid` | This wallet can't resolve that DID method yet. | Use a supported method, or wait for a wallet update. |
| `domain-not-linked` | The website (its origin) doesn't publish a DID Configuration linking it to the DID. | Serve `/.well-known/did-configuration.json` on that origin with a Domain Linkage credential for the DID. |

A **DID hosting service** needs all three of these services in its DID
document: `SignInPortal` (its console's login page, `https://<host>/login`),
`TrustTaskHTTPS` (its Trust-Task base, `https://<host>/api`) and
`WebVHHosting` (`{ "uri": "https://<host>" }`). Add a missing one with
`pnm did-mgmt dids edit --did <did>`.

This needs the portal's origin granted (see below): the click is caught by the
same content script as the page provider, and the community's Trust-Task
endpoint is usually on that origin. On a site that is not granted, the click
goes to the link host's page for people with no wallet.

**`window.vtaWallet.login`, `loginDidcomm` and `proxyLogin` are deprecated**
(sign-in contract C7). They keep working, and the console says so once per page.
Put them behind an "Using an older wallet?" link; a removal date will be set
later.

### The wallet writes nothing into your browser

A sign-in produces a signed `id_token` the site verifies for itself by
resolving your published DID document; a DIDComm login never touches browser
state either. The extension holds no `cookies` permission and calls no cookie
API — `chrome.cookies.set` appears nowhere in the source.

It did once. A relying party that was an ordinary web app with a server-side
session and no notion of DIDs could have its login performed by the VTA, which
returned a `SessionBlob` whose cookie jar the wallet wrote into the browser
(guarded by scope checks in what was `src/cookie-scope.ts`). That legacy path
is gone: the `cookies` permission is off the manifest, the vault's password
entries are browser-fill only, and any cookie jar a VTA still returns is
dropped in the offscreen document before it can cross into the popup
(`doVaultProxyLogin`, `src/offscreen.ts`).

What remains of `vault/proxy-login` is the modern half — the VTA mints a SIOP
`id_token` on your behalf and the long-term key never leaves it. The wallet
displays that session; it never installs it. Keep it that way when changing
this code: "the wallet writes nothing into your browser" is a claim a reviewer
can check in one grep, and it is worth more than any scoping argument.

### Packaging for the Chrome Web Store

```bash
npm run package --workspace @openvtc/pnm-extension
# → packages/extension/release/vta-wallet-<version>.zip
```

The zip holds the *contents* of `dist/` (manifest at the archive root,
as the Store requires). CI builds and validates it on every run and
uploads it as the `vta-wallet-extension` artifact, so a submission is
never the first time the packaging path runs.

**Version.** `packages/extension/package.json` is the single source of
truth; `packages/extension/manifest.json` is a template and carries no
`version` field. The build injects it and rejects anything the Store
would reject — npm prerelease spellings like `0.3.0-rc.1` are not valid
Chrome versions. Bump the package version before each upload: the Store
refuses a version that is not greater than the last one it accepted.

**Extension ID.** `chrome.runtime.id` is load-bearing — `src/holder.ts`
uses it as the WebAuthn PRF rpId, so if it changes, every
passkey-wrapped secret becomes unopenable and any
`chrome-extension://<id>` allowlist (VTA CORS) breaks. It is pinned by
`extension-key.txt`, whose public key the build injects into `dist/`'s
manifest as `key`.

The Store zip deliberately omits `key`: the Store issues its own key on
the first upload of a new item and rejects a package that carries one.
So the local ID matches the published one only after cutover — once the
item exists in the Developer Dashboard, replace `extension-key.txt`
with the dashboard's **Package → View public key** value and delete
`extension-key.pem`. Confirm the result:

```bash
npm run generate:key --workspace @openvtc/pnm-extension -- --show
# prints the derived ID; it must equal the dashboard's Item ID
```

Until then the pinned key is a locally generated one (`npm run
generate:key`), which holds the ID still across machines and checkouts
but is *not* the published ID. Cutover re-keys every dev passkey once.

### Validating in a browser

```bash
npm run dev:pwa
# open http://localhost:5173/smokes → click "Run all"
```

All smokes should pass. The diagnostics page exercises every layer
of the stack including the WebSocket bridge's thid demuxer and the
full WalletSession boot.
