# @pnm/demo-rp

Minimal HTTP relying party — single zero-dependency Node service that the VTA's `vault/proxy-login/0.1` Password POST driver can target end-to-end (M2B.5).

## Why

The Password POST driver in `verifiable-trust-infrastructure` needs a real third-party service to log into. Standing it up inside the plugin workspace lets the wallet's "🔑 Use" button on a password vault entry drive a full round-trip:

```
wallet popup ──▶ vta-service /vault/proxy-login/0.1
                   │
                   └──▶ demo-rp POST /api/login (username + password)
                          │
                          └─ session cookie returned
                   ◀─────────────────────────────────
wallet  ◀── SessionBlob with the cookie
   │
   └── chrome.cookies.set(...) ──▶ user's browser
       │
       └── GET demo-rp/me → 200 (logged in)
```

## Run

```sh
npm run dev:demo-rp
# or, from the workspace root:
node packages/demo-rp/server.mjs
```

Listens on `http://127.0.0.1:4040` by default.

Override via env:

| Var | Default | Notes |
|---|---|---|
| `PORT` | `4040` | TCP port |
| `HOST` | `127.0.0.1` | Bind address — must be loopback for the VTA's `http://` loopback carve-out to accept this URL |
| `DEMO_USERNAME` | `alice` | Hardcoded test user |
| `DEMO_PASSWORD` | `passw0rd!` | Hardcoded test password |

## Wallet setup

Create a `password` vault entry in the VTA wallet with:

- **Label**: anything (e.g. "Demo RP")
- **Context**: any context the wallet has visibility into
- **Targets**: `web-origin: http://127.0.0.1:4040`
- **Secret**:
  - `username`: `alice` (or whatever you set `DEMO_USERNAME` to)
  - `password`: `passw0rd!`
  - `loginConfig`:
    - `loginUrl`: `http://127.0.0.1:4040/api/login`
    - `format`: `json`

`vault/upsert/0.1` accepts the full secret shape including `loginConfig` (per `vault/_shared/0.1/vault-secret#/$defs/PasswordLoginConfig`).

Then in the wallet popup, click **🔑 Use** on the entry. The wallet will:

1. POST `vault/proxy-login/0.1` to the VTA with the entry id.
2. The VTA performs `POST http://127.0.0.1:4040/api/login` with the credentials.
3. The VTA captures the `Set-Cookie` from the response and packs it into a SessionBlob.
4. The wallet receives the SessionBlob via authcrypt unsealing.
5. (Coming next PR) Wallet injects the cookies via `chrome.cookies.set` into the user's browser.
6. User refreshes `http://127.0.0.1:4040/` and sees themselves logged in.

## Endpoints

- `GET /` — login form + status indicator. Shows "Logged in as &lt;user&gt;" when the session cookie is present, otherwise shows the manual login form.
- `POST /api/login` — JSON body `{ username, password }`. On success: `Set-Cookie: demo_session=…; Path=/; Max-Age=3600; SameSite=Lax`. On failure: 401 `{ error: "invalid credentials" }`.
- `GET /me` — 200 + `{ user: { username } }` when authenticated; 401 otherwise. The browser's network-level cookie is read.
- `POST /api/logout` — clears the session cookie and 303-redirects to `/`.

## Security disclaimers

- Single hardcoded user. **NOT a real auth system.**
- Sessions are an in-memory map; restarting the server invalidates all sessions.
- Cookie is not `HttpOnly` so the page's inline JS can read it for the status indicator. A production RP would scope tighter.
- No `Secure` attribute (the demo runs on plain HTTP loopback). Real deployments MUST add `Secure`.
- Permissive CORS — allow any origin with credentials. The demo doesn't ship sensitive endpoints; tighten in production.
