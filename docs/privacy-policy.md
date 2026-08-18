# VTA Wallet — Privacy Policy

_Last updated: 18 August 2026_

VTA Wallet is a browser extension that holds decentralised identifiers (DIDs)
and credentials on your behalf, signs you in to relying parties, and shows you
the approval prompts that gate privileged actions at your Verifiable Trust
Agent (VTA).

**We do not operate a service that collects your data.** The extension talks
only to the trust agent you point it at, the mediator that agent publishes, and
the hosting service that serves the DID documents it needs to resolve. There is
no analytics, no telemetry, no crash reporting, no advertising, and no
third-party SDK of any kind in the extension.

## What is stored, and where

**In your browser** (IndexedDB and `chrome.storage`, on your device only):

- The wallet's own identity — an Ed25519/X25519 key pair minted locally on
  first run and never transmitted. You may choose to encrypt it with a key
  derived from your passkey authenticator (WebAuthn PRF), in which case
  unlocking the wallet requires that authenticator.
- Your settings: the DID of your trust agent, its mediator, any additional
  executors you enrol, and an optional push gateway URL.
- Which sites you have granted access to, which you asked the wallet to
  remember, and the relying-party identity last seen at each — so the wallet
  can warn you when a site changes the identity it presents.
- Inbound message identifiers, to avoid acting on the same request twice.

**At your trust agent** (not in the browser): your vault entries and the
long-term secrets inside them. The extension displays them and asks the agent
to act on them; the secrets themselves stay at the agent. When you reveal or
use one, the material lives in the extension's memory only, and is wiped at the
expiry the agent sets.

## What leaves your browser, and to whom

- **Your trust agent** — the requests you make of it, and the approvals you
  give it. You choose the agent; where it runs and who operates it is your
  decision, and its own privacy terms apply to it.
- **Your agent's mediator** — an encrypted message relay. Messages are
  end-to-end encrypted between the wallet and the agent; the mediator carries
  ciphertext it cannot read.
- **DID hosting services** — when the wallet resolves a DID (yours, or a
  relying party's) it fetches that DID's public document from the host named in
  the DID itself. This is a public read, the same one any verifier performs.
- **A push gateway**, only if you configure one, so approval requests can wake
  the wallet while it is idle. It receives an opaque subscription handle, not
  your requests.

Nothing is sold. Nothing is transferred to any third party for any purpose.
Nothing is used to build a profile, to advertise, or to train anything.

## What the extension does not do

- It does not read your browsing history, and it does not track the sites you
  visit. It holds no host permissions when installed; you grant one site at a
  time, at the moment it is needed, and you can revoke any of them under
  **Sites** in the extension's options.
- It does not read, write, or enumerate cookies. It holds no `cookies`
  permission at all.
- It does not inject anything into pages you have not enabled it on.
- It does not contain remotely-hosted code: everything it runs ships in the
  package.

## Permissions, and why each exists

- `storage` — the wallet's own settings and connection state.
- `offscreen` — a hidden document that performs cryptography and holds the
  message connection, because an MV3 service worker can do neither.
- `notifications` — tells you an approval request has arrived while the wallet
  is idle, so it does not expire unseen.
- `tabs` — reloads the extension's own affected tabs after an update, and
  delivers wallet events to pages you have enabled.
- `scripting` — registers the page interface on the origins you granted, and
  only those.
- Optional site access — requested one origin at a time, never at install.

## Your control

Everything the extension holds locally is removed when you remove the
extension. Site grants can be revoked individually at any time. Vault contents
live at your trust agent and are governed by that agent — the wallet can delete
entries at your instruction, but it is not the system of record.

## Contact

Questions or requests: <fill in the contact address for the listing>

Source code: https://github.com/OpenVTC/vta-browser-plugin
