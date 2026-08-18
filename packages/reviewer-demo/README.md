# @openvtc/pnm-reviewer-demo

The demo site that makes this extension testable by a Chrome Web Store
reviewer.

## Why it exists

Onboarding the wallet is a two-party handshake. During **Prepare** the wallet
mints an ephemeral `did:key` in the reviewer's own browser and shows them a
command:

```
pnm acl create --did did:key:z… --role admin --expires 1h
```

Someone with access to the agent has to run it before **Connect** works. The
ephemeral is minted per installation, so it cannot be granted in advance, and
the agent has no self-service enrolment to fall back on. A reviewer has neither
a shell on the agent nor a reason to trust one — so without this site, the
extension cannot be reviewed at all.

This site stands in for that shell, and doubles as the relying party the
reviewer signs in to afterwards.

## The flow it supports

1. The reviewer signs in with the **reviewer key ID** from the listing's test
   instructions. This is the bootstrap: it is needed before a wallet exists.
2. The walkthrough page shows the demo agent's DID, the steps to follow, and a
   box to paste the command into. Pasting authorises their wallet — for **seven
   days**, not the one hour the command asks for, so it does not expire
   mid-review.
3. They complete setup in the wallet and click **Connect**.
4. They come back and sign in again, this time with **Sign in with your VTA
   Wallet** (SIOPv2) — which is the flow under review.
5. They click **Ask the agent to do something**, which raises the consent prompt
   deliberately rather than in passing.

Step 4's result is verified rather than trusted: the browser hands over the
access token and session id the wallet returned, and the server spends that
token against the agent's `GET /auth/sessions`. A 200 with a matching
`session_id` is the agent's own account of who signed in.

## Running it

```bash
VTA_DID='did:webvh:…' \
VTA_BASE_URL='https://demo-agent.example/api' \
REVIEWER_KEY='pick-something' \
GRANT_CONTEXT='reviewer-sandbox' \
DEMO_DELETES_ON='2026-09-01' \
RESET_SCRIPT=/opt/demo/reset-agent.sh \
SECURE_COOKIE=1 \
npm start --workspace @openvtc/pnm-reviewer-demo
```

It must run somewhere `GRANT_BIN` (default `pnm`) is installed and already
authenticated against the demo agent — the same shell an operator would type
the command in. It holds no agent credentials of its own.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8792` | Listen port. |
| `VTA_DID` | *(required)* | The demo agent's DID. Displayed on every screen. |
| `VTA_BASE_URL` | *(required)* | The demo agent's REST base URL. |
| `REVIEWER_KEY` | *(none)* | Key ID for the first sign-in. **Set it** — unset leaves the page open to anyone. |
| `GRANT_BIN` | `pnm` | The VTA CLI. |
| `GRANT_CONTEXT` | *(none)* | Scopes grants to one context. Set it. |
| `GRANT_EXPIRES` | `7d` | Grant lifetime. Always this — never the pasted command's. |
| `MAX_GRANTS_PER_HOUR` | `40` | Ceiling on grants issued per hour. |
| `RESET_SCRIPT` | *(none)* | Absolute path to the reset script. The Reset button is hidden while unset. |
| `DEMO_DELETES_ON` | *(none)* | ISO date shown in the "this is thrown away" banner. |
| `DEMO_TASK_TYPE` | `…/spec/auth/whoami/0.1` | The task behind the approval-prompt button. |
| `SECURE_COOKIE` | off | Set to `1` behind TLS. |

`GET /health` returns `ok`. **Check it before every submission** — a reviewer
who lands on a dead demo has no way to test the extension, which is the most
likely way this listing gets rejected.

### The approval-prompt button

Step 5 calls `window.vtaWallet.requestTask({ type, payload })` — the generic
relay any relying party can use. The wallet stops it and prompts, naming this
site as the asker and naming the task; the site supplies neither, which is why
the walkthrough can tell a reviewer to trust the prompt over the page.

The default task is `auth/whoami/0.1`: read-only introspection, chosen because
the point of the button is the prompt, so what sits behind it should be the
least consequential thing the agent supports. The walkthrough asks the reviewer
to **Deny** first — a refusal tells the page nothing except that it was refused,
which is the property most worth demonstrating.

That is the *first* round of delegated execution. A policy-gated task goes
further: the agent computes the real effects itself and asks an approver to
confirm them against a digest, never against the description the site supplied.
Point `DEMO_TASK_TYPE` at such a task if your demo agent has one and an approver
enrolled, and the same button shows both rounds — the page handles the
`requireConsent` reply and says that nothing has happened yet. Left at the
default, the walkthrough explains the second round rather than staging it.

### The reset script

`RESET_SCRIPT` is run with no arguments when the reviewer clicks **Reset the
demo agent**. It should put the agent back to the state the walkthrough assumes
— clearing login profiles and contexts — because a reviewer arriving after
someone else's half-finished attempt otherwise has no way forward. Writing it is
deployment-specific and deliberately left to the operator: this site will not
compose a destructive command on your behalf.

Leave it unset and the button disappears; the walkthrough still works, but a
stuck agent then needs a human.

## What this is, and is not

**Point it only at a demo agent that can be destroyed.** Onboarding needs an
admin grant, so anyone holding the key ID gets admin on that agent for a week.
That is the actual trade: an agent holding nothing, existing to be poked at,
rebuilt on a schedule. Every screen says so, because a reviewer putting their
own data into it would be a worse outcome than a failed review.

The guardrails narrow the blast radius rather than remove it:

- Pasted text is parsed for an anchored `did:key:z…` base58btc pattern, and only
  the roles `admin` and `super-admin` are accepted. Base58btc contains no
  whitespace and no shell metacharacter, and the value is passed as argv — never
  through a shell. Covered by `tests/`.
- The expiry is always this site's, so a pasted `--expires` cannot influence it.
- Grants are capped per hour, and every grant, failure and sign-in is logged.
- Session cookies are `HttpOnly`, `SameSite=Lax`, and every state-changing
  request is checked same-origin. Sessions live in memory: a restart signs
  everyone out, which is the right failure mode here.
- The pages have a CSP that permits only this origin's own assets and
  connections to the configured agent.

It is not a production enrolment flow and should not become one. If
self-service enrolment is ever wanted for real users, it belongs in the agent,
where the policy lives — not in a page that shells out to a CLI.
