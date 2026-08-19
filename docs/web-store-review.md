# Chrome Web Store — single purpose and permission justifications

Paste-ready text for the Developer Dashboard's Privacy practices tab, plus the
facts a reviewer will want to check. Keep this in step with `manifest.json`:
if a permission is added or removed and this file does not change, the
submission is wrong before it is written.

## Single purpose

A wallet for decentralised identifiers. It holds the user's DIDs and
credentials, signs in to relying parties on their behalf using SIOPv2, and
renders the human approval prompts that gate privileged actions at the user's
Verifiable Trust Agent.

The wallet writes nothing into the browser on a site's behalf: no cookies, no
storage, no injected session. A sign-in produces a signed token the site
verifies for itself.

## Permissions

### `storage`

Stores the wallet's own settings and its connection to the user's trust agent.
No browsing data is read or written.

### `offscreen`

DID resolution and DIDComm need a DOM (WebCrypto plus a WebSocket that outlives
a message round trip); an MV3 service worker has neither. The offscreen
document is the wallet's crypto and transport worker. It renders nothing and is
never shown.

### `notifications`

Notifies the user when an approval request arrives while the wallet is idle.
Without it a request for a privileged action can sit unseen until it expires.

### `tabs`

Two uses, both about the extension's own pages: reloading tabs after an
extension update so their injected provider is not orphaned, and delivering
wallet lifecycle events to pages that are already listening for them. Tab URLs
are matched against the origins the user has granted; browsing history is never
read or stored.

### `scripting`

Registers the page provider (`window.vtaWallet`) **only** on origins the user
has explicitly granted. The extension deliberately declares no static
`content_scripts`: registration is derived at runtime from the granted origins,
so a site the user has not approved cannot see the wallet at all. See
`src/content-registration.ts`.

### `optional_host_permissions: <all_urls>`

Requested one origin at a time, never at install. Two uses, each asked for
when it is needed: reaching the user's trust agent (its REST API applies an
origin allowlist, so an ungranted request is blocked), and running the page
provider on sites the user chooses. The wildcard is declared because the set of
relying parties is not knowable in advance — it is a ceiling on what the user
*may* grant, not a grant.

## Remote code

**None.** No `eval`, no `new Function`, no remotely-hosted scripts, and no
dynamic `import()` (CI asserts the last of these, because an MV3 service worker
cannot load one). All executable code ships in the package. The extension
communicates with the user's own trust agent over HTTPS and WebSocket; that is
data, not code.

## Data use

Handles personally identifiable information and authentication information.
Both stay between the user's browser and the trust agent they chose. Nothing is
sold, nothing is transferred to third parties, and nothing is used for any
purpose beyond the wallet's single purpose above.

## Notes for the reviewer

- Source: https://github.com/OpenVTC/vta-browser-plugin — the published bundle can be diffed against it.
- Test instructions, including the demo agent and demo relying party, are in
  the section below — paste them into the dashboard's **Test instructions**
  field verbatim.
- The extension holds no `cookies` permission and calls no cookie API. An
  earlier version wrote a trust-agent-issued session into the jar for legacy
  password-based sites; that feature was removed rather than defended. The
  wallet now discards any cookie jar a trust agent returns before it leaves
  the offscreen document (`doVaultProxyLogin` in `src/offscreen.ts`).
- The most privileged remaining action is a SIOP sign-in, which mints a signed
  `id_token` and hands it to the page that asked — behind a consent prompt
  naming the requesting origin (`gatedConsent` in `src/background.ts`).

## Test instructions (paste into the dashboard field)

The dashboard's *Test instructions* box is free text and the reviewer follows it
literally, so it is written for someone who has never seen this project and will
not open a terminal. Everything it needs is served by the demo site
(`packages/reviewer-demo/`). Fill every `<PLACEHOLDER>` before submitting.

> This wallet connects to a **Verifiable Trust Agent** — a service the user runs
> or subscribes to. We host a throwaway demo agent so you can exercise every
> flow without setting anything up, and a demo site that walks you through it.
> Nothing below needs a terminal.
>
> **The demo is disposable.** Every authorisation it issues expires after 7
> days, and the whole demo — agent, accounts, anything created in it — is
> deleted on `<DELETION DATE>`. Please do not put your own data into it.
>
> 1. Open `<DEMO SITE URL>` and sign in with this reviewer key ID:
>    `<REVIEWER KEY ID>`
>    The page that follows is the walkthrough, and it shows the demo agent's
>    DID. Keep it open.
> 2. Install the extension. A setup tab opens by itself.
> 3. In the wallet's setup step 1, paste the **Agent DID** from the demo site
>    and click **Prepare**. Chrome asks for access to that host — approve it.
> 4. The wallet now shows a command containing a `did:key:z…`. Copy the whole
>    line, paste it into **step 3** on the demo site, and click **Authorise this
>    wallet**. (That command would normally be run by whoever operates the
>    agent; the demo site runs it for you, for 7 days.)
> 5. Back in the wallet, click **Connect**. Setup completes and the wallet shows
>    the agent as connected. The passkey lock offered during setup is optional —
>    if you would rather not enrol an authenticator, leave it off and everything
>    below still works.
> 6. On the demo site, click **Sign out**, then **Sign in with your VTA Wallet**.
>    The first time, the wallet is invisible to the page by design: open the
>    extension's popup and choose **Enable on this site**, which is the per-site
>    grant. Then click it again.
> 7. The wallet raises a consent prompt naming the site — this is the human
>    check the extension exists to provide. Approve it, and you are signed in as
>    your own DID, which the demo site verified with the agent rather than
>    trusting the browser. No cookie is written at any point; the extension
>    holds no cookie permission.
> 8. Finally, click **Ask the agent to do something** in step 6 of the
>    walkthrough. This is the generic path any site can use to ask your agent to
>    carry out a task, and the wallet stops it to ask you first. **Click Deny the
>    first time**: the request fails and the page learns only that you refused.
>    Then try again and approve. The prompt names the site and the task, and the
>    site supplies neither — it is drawn by the extension in its own window and
>    the page cannot restyle it, dismiss it, or answer for you.
>
> If anything goes wrong, the walkthrough page has a **Reset the demo agent**
> button that returns it to a known starting state (clearing its login profiles
> and contexts) so you can begin again from step 1.
>
> If the demo is unreachable when you review, a full screen recording of this
> walkthrough is at `<VIDEO URL>`.

Before every submission:

- **The demo is up.** `curl <DEMO SITE URL>/health` returns `ok`. A reviewer who
  hits a dead demo has no way to test, and this is the single most likely cause
  of a failed review.
- **The key ID matches.** It is `REVIEWER_KEY` on the demo site, and it must be
  what the instructions say.
- **The deletion date is in the future**, and the agent behind it still exists.
- **A reset leaves the agent in the state step 3 assumes** — run the reset, then
  walk the whole flow yourself with a fresh browser profile.
