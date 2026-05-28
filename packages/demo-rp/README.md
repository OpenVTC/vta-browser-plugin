# @pnm@openvtc/pnm-demo-rp

Minimal HTTP relying party — single zero-dependency Node service that the VTA's `vault@openvtc/pnm-proxy-login@openvtc/pnm-0.1` Password POST driver can target end-to-end (M2B.5).

## Why

The Password POST driver in `verifiable-trust-infrastructure` needs a real third-party service to log into. Standing it up inside the plugin workspace lets the wallet's "🔑 Use" button on a password vault entry drive a full round-trip:

```
wallet popup ──▶ vta-service @openvtc/pnm-vault@openvtc/pnm-proxy-login@openvtc/pnm-0.1
                   │
                   └──▶ demo-rp POST @openvtc/pnm-api@openvtc/pnm-login (username + password)
                          │
                          └─ session cookie returned
                   ◀─────────────────────────────────
wallet  ◀── SessionBlob with the cookie
   │
   └── chrome.cookies.set(...) ──▶ user's browser
       │
       └── GET demo-rp@openvtc/pnm-me → 200 (logged in)
```

## Run

```sh
npm run dev:demo-rp
# or, from the workspace root:
node packages@openvtc/pnm-demo-rp@openvtc/pnm-server.mjs
```

Listens on `http:@openvtc/pnm-@openvtc/pnm-127.0.0.1:4040` by default.

Override via env:

| Var | Default | Notes |
|---|---|---|
| `PORT` | `4040` | TCP port |
| `HOST` | `127.0.0.1` | Bind address — must be loopback for the VTA's `http:@openvtc/pnm-@openvtc/pnm-` loopback carve-out to accept this URL |
| `DEMO_USERNAME` | `alice` | Hardcoded test user |
| `DEMO_PASSWORD` | `passw0rd!` | Hardcoded test password |

## Wallet setup

Create a `password` vault entry in the VTA wallet with:

- **Label**: anything (e.g. "Demo RP")
- **Context**: any context the wallet has visibility into
- **Targets**: `web-origin: http:@openvtc/pnm-@openvtc/pnm-127.0.0.1:4040`
- **Secret**:
  - `username`: `alice` (or whatever you set `DEMO_USERNAME` to)
  - `password`: `passw0rd!`
  - `loginConfig`:
    - `loginUrl`: `http:@openvtc/pnm-@openvtc/pnm-127.0.0.1:4040@openvtc/pnm-api@openvtc/pnm-login`
    - `format`: `json`

`vault@openvtc/pnm-upsert@openvtc/pnm-0.1` accepts the full secret shape including `loginConfig` (per `vault@openvtc/pnm-_shared@openvtc/pnm-0.1@openvtc/pnm-vault-secret#@openvtc/pnm-$defs@openvtc/pnm-PasswordLoginConfig`).

Then in the wallet popup, click **🔑 Use** on the entry. The wallet will:

1. POST `vault@openvtc/pnm-proxy-login@openvtc/pnm-0.1` to the VTA with the entry id.
2. The VTA performs `POST http:@openvtc/pnm-@openvtc/pnm-127.0.0.1:4040@openvtc/pnm-api@openvtc/pnm-login` with the credentials.
3. The VTA captures the `Set-Cookie` from the response and packs it into a SessionBlob.
4. The wallet receives the SessionBlob via authcrypt unsealing.
5. (Coming next PR) Wallet injects the cookies via `chrome.cookies.set` into the user's browser.
6. User refreshes `http:@openvtc/pnm-@openvtc/pnm-127.0.0.1:4040@openvtc/pnm-` and sees themselves logged in.

## Endpoints

- `GET @openvtc/pnm-` — login form + status indicator. Shows "Logged in as &lt;user&gt;" when the session cookie is present, otherwise shows the manual login form.
- `POST @openvtc/pnm-api@openvtc/pnm-login` — JSON body `{ username, password }`. On success: `Set-Cookie: demo_session=…; Path=@openvtc/pnm-; Max-Age=3600; SameSite=Lax`. On failure: 401 `{ error: "invalid credentials" }`.
- `GET @openvtc/pnm-me` — 200 + `{ user: { username } }` when authenticated; 401 otherwise. The browser's network-level cookie is read.
- `POST @openvtc/pnm-api@openvtc/pnm-logout` — clears the session cookie and 303-redirects to `@openvtc/pnm-`.

## Security disclaimers

- Single hardcoded user. **NOT a real auth system.**
- Sessions are an in-memory map; restarting the server invalidates all sessions.
- Cookie is not `HttpOnly` so the page's inline JS can read it for the status indicator. A production RP would scope tighter.
- No `Secure` attribute (the demo runs on plain HTTP loopback). Real deployments MUST add `Secure`.
- Permissive CORS — allow any origin with credentials. The demo doesn't ship sensitive endpoints; tighten in production.
