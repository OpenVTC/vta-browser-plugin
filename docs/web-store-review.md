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

### `cookies` — the one worth reading closely

**Scope: legacy relying parties only.**

The wallet's normal sign-in path writes no cookies. A SIOPv2 sign-in returns a
signed `id_token` that the site verifies for itself by resolving the user's
published DID document; a DIDComm login never touches the cookie jar either.

This permission serves exactly one case: a relying party that is an ordinary
web application, issues a server-side session, and has no notion of DIDs. For
those, the user's trust agent performs the password sign-in and returns the
resulting session, which the wallet writes into the jar so the user lands
signed in.

Every one of these constraints is enforced in code, and each is a few lines a
reviewer can check in `src/cookie-scope.ts` and `src/background.ts`:

- **The user starts it.** Cookies are written only from an explicit "Sign in
  to `<site>`" click on a session the user has just released from their vault.
  Nothing is written as a side effect of loading a page or of an earlier action.
- **Per-site permission, asked at that moment.** The extension holds no host
  permissions at install time (`optional_host_permissions` only). Writing a
  cookie for a site requires a grant the user makes in Chrome's own dialog,
  for that site, at that moment.
- **Scoped to the bound origin.** Every cookie is checked against the origin
  the session is bound to using RFC 6265 domain-matching before any write is
  attempted. A cookie claiming a domain that does not match is refused and
  reported to the user, not silently dropped.
- **HTTPS only**, except `localhost` for local development.
- **Nothing is read.** The wallet never enumerates or reads the user's cookies.
  Only `chrome.cookies.set` is used, and only on the path above.

The user can see and revoke every granted site under **Sites** in the
extension's own options page.

### `optional_host_permissions: <all_urls>`

Requested one origin at a time, never at install. Three uses, each asked for
when it is needed: reaching the user's trust agent (its REST API applies an
origin allowlist, so an ungranted request is blocked), writing the legacy
session cookies described above, and running the page provider on sites the
user chooses. The wildcard is declared because the set of relying parties is
not knowable in advance — it is a ceiling on what the user *may* grant, not a
grant.

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

- Source: <repository URL> — the published bundle can be diffed against it.
- A test agent and credentials for exercising the sign-in and approval flows:
  <fill in before submitting>.
- The cookie path is the one most worth watching. The quickest way to see its
  boundary is `src/cookie-scope.ts`, which is dependency-free and covered by
  unit tests, including the case where a session claims a domain that does not
  belong to the site it is bound to.
