// Demo Relying Party for the VTA's `vault/proxy-login/0.1` Password
// POST driver (M2B.5). Single-file, zero-dependency Node service.
//
// Endpoints:
//   GET  /            login form + status indicator
//   POST /api/login   { username, password } → 200 + Set-Cookie session=…
//   GET  /me          200 + JSON { user } when authenticated; 401 otherwise
//   POST /api/logout  clears the session cookie
//
// The wallet's role end-to-end:
//   1. User opens / in a browser; sees "Not logged in".
//   2. User clicks the wallet's "🔑 Use" on a Password entry pinned to
//      this RP's origin (the entry's loginConfig.loginUrl points at
//      this service's /api/login).
//   3. VTA POSTs the credentials to /api/login; gets the session
//      cookie back in the response.
//   4. Wallet receives the cookie inside the SessionBlob and injects it
//      into the user's browser via chrome.cookies.set (next plugin PR).
//   5. User refreshes /; the page sees the session cookie via /me and
//      shows "Logged in as <user>".
//
// Security disclaimer:
// - Single hardcoded user. NOT a real auth system.
// - Sessions are an in-memory map; restarting the server drops them.
// - Cookie is not HttpOnly so the demo page can read it for the
//   status indicator. A real RP would scope tighter.

import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { URL } from "node:url";

// ─── Config ────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT ?? 4040);
const HOST = process.env.HOST ?? "127.0.0.1";
// Hardcoded test user. Change via env so the demo can be re-run with a
// fresh credential pair without editing the file.
const DEMO_USERNAME = process.env.DEMO_USERNAME ?? "alice";
const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? "passw0rd!";
const SESSION_COOKIE_NAME = "demo_session";
// Sessions live in memory, max 1 hour. The wallet's cookie-injection
// path declares its own TTL on the SessionBlob; this is the server-
// side authority and the floor.
const SESSION_TTL_MS = 60 * 60 * 1000;

/** @type {Map<string, { username: string, expiresAt: number }>} */
const sessions = new Map();

function issueSession(username) {
  const id = randomBytes(24).toString("base64url");
  sessions.set(id, { username, expiresAt: Date.now() + SESSION_TTL_MS });
  return id;
}
function readSession(req) {
  const cookie = req.headers["cookie"] ?? "";
  for (const pair of cookie.split(";")) {
    const [k, ...rest] = pair.trim().split("=");
    if (k === SESSION_COOKIE_NAME) {
      const id = rest.join("=");
      const s = sessions.get(id);
      if (!s) return null;
      if (s.expiresAt < Date.now()) {
        sessions.delete(id);
        return null;
      }
      return { id, ...s };
    }
  }
  return null;
}
function clearSessions() {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (s.expiresAt < now) sessions.delete(id);
  }
}
setInterval(clearSessions, 5 * 60 * 1000).unref();

// ─── Handlers ──────────────────────────────────────────────────────

function sendHtml(res, status, html) {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    // Permit the wallet extension's content scripts to talk to the
    // page (default CSP is fine for the demo's simple inline JS).
    "cache-control": "no-store",
  });
  res.end(html);
}
function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    ...headers,
  });
  res.end(JSON.stringify(body));
}

function homePage(req) {
  const session = readSession(req);
  const status = session
    ? `<p class="ok">✓ Logged in as <code>${escapeHtml(session.username)}</code> · session ${escapeHtml(session.id.slice(0, 12))}…</p>
       <form method="post" action="/api/logout"><button>Log out</button></form>`
    : `<p class="warn">Not logged in.</p>
       <ol>
         <li>Open the VTA wallet, add a <code>password</code> vault entry pinned to this origin.</li>
         <li>Set <code>loginConfig</code> to <code>{ loginUrl: "http://${HOST}:${PORT}/api/login", format: "json" }</code>.</li>
         <li>Click the wallet's <strong>🔑 Use</strong> button.</li>
         <li>The wallet injects the session cookie; refresh this page.</li>
       </ol>
       <p>Or sign in the old-fashioned way:</p>
       <form id="manual" onsubmit="return handleManualLogin(event)">
         <label>Username <input name="username" value="${escapeHtml(DEMO_USERNAME)}"></label>
         <label>Password <input name="password" type="password" value="${escapeHtml(DEMO_PASSWORD)}"></label>
         <button type="submit">Sign in</button>
         <span id="manual-result"></span>
       </form>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>VTA demo RP</title>
<style>
  body { font: 14px/1.4 -apple-system, system-ui, sans-serif; max-width: 720px; margin: 40px auto; padding: 0 20px; color: #222; }
  h1 { margin-bottom: 4px; }
  .lede { color: #666; margin-top: 0; }
  code { font-family: ui-monospace, monospace; background: #f3f3f3; padding: 1px 4px; border-radius: 3px; font-size: 12px; }
  .ok { color: #16632c; background: #e6f4ea; padding: 8px 12px; border-radius: 6px; border: 1px solid #b6e0c2; }
  .warn { color: #8a6300; background: #fff8e1; padding: 8px 12px; border-radius: 6px; border: 1px solid #f0d090; }
  form { margin: 12px 0; display: grid; gap: 8px; max-width: 320px; }
  label { display: grid; gap: 2px; }
  input, button { padding: 6px 10px; font: inherit; border: 1px solid #ccc; border-radius: 4px; }
  button { cursor: pointer; background: #4338ca; color: white; border-color: #4338ca; }
  button:hover { background: #3730a3; }
  #manual-result { color: #c00; font-size: 12px; }
  ol li { margin: 4px 0; }
</style>
</head>
<body>
  <h1>VTA Demo Relying Party</h1>
  <p class="lede">Target for the <code>vault/proxy-login/0.1</code> Password POST driver (M2B.5).</p>
  ${status}
  <hr style="margin-top: 30px; opacity: 0.3;">
  <details>
    <summary>API</summary>
    <ul>
      <li><code>POST /api/login</code> JSON body <code>{ username, password }</code> → sets <code>${SESSION_COOKIE_NAME}</code> cookie</li>
      <li><code>GET /me</code> → 200 JSON when authenticated, 401 otherwise</li>
      <li><code>POST /api/logout</code> → clears the cookie</li>
    </ul>
    <p>Demo credentials: <code>${escapeHtml(DEMO_USERNAME)}</code> / <code>${escapeHtml(DEMO_PASSWORD)}</code></p>
  </details>
<script>
async function handleManualLogin(ev) {
  ev.preventDefault();
  const form = ev.target;
  const username = form.elements.username.value;
  const password = form.elements.password.value;
  const r = await fetch("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (r.ok) {
    location.reload();
  } else {
    document.getElementById("manual-result").textContent =
      "Login failed (" + r.status + ")";
  }
  return false;
}
</script>
</body>
</html>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
  })[c]);
}

async function readJsonBody(req, maxBytes = 16 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > maxBytes) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

async function handleApiLogin(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return sendJson(res, 400, { error: "invalid JSON body" });
  }
  const username = String(body?.username ?? "");
  const password = String(body?.password ?? "");
  if (username !== DEMO_USERNAME || password !== DEMO_PASSWORD) {
    // Constant-time-ish: don't reveal which of username/password was
    // wrong. Real RPs go further; for the demo this is enough.
    return sendJson(res, 401, { error: "invalid credentials" });
  }
  const id = issueSession(username);
  // Cookie attributes:
  //   - Path=/ → applies to the whole origin.
  //   - SameSite=Lax → blocks cross-site implicit submission (CSRF-ish).
  //   - Max-Age in seconds; mirrors SESSION_TTL_MS.
  //   - HttpOnly intentionally omitted so the demo's inline JS can
  //     read the cookie value for the status indicator. Production
  //     would set HttpOnly.
  //   - No Secure attribute (the demo runs on plain HTTP loopback);
  //     real deployments MUST add Secure.
  const cookie = [
    `${SESSION_COOKIE_NAME}=${id}`,
    "Path=/",
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
    "SameSite=Lax",
  ].join("; ");
  return sendJson(res, 200, { ok: true, user: { username } }, {
    "set-cookie": cookie,
  });
}

function handleMe(req, res) {
  const s = readSession(req);
  if (!s) return sendJson(res, 401, { error: "no session" });
  return sendJson(res, 200, {
    user: { username: s.username },
    sessionExpiresAt: new Date(s.expiresAt).toISOString(),
  });
}

function handleLogout(req, res) {
  const s = readSession(req);
  if (s) sessions.delete(s.id);
  res.writeHead(303, {
    location: "/",
    "set-cookie": `${SESSION_COOKIE_NAME}=; Path=/; Max-Age=0; SameSite=Lax`,
  });
  res.end();
}

// ─── Router ────────────────────────────────────────────────────────

const server = createServer(async (req, res) => {
  // Permissive CORS — the wallet extension's content script lives in
  // its own origin and may issue cross-origin requests during the
  // proxy-login round-trip the VTA itself initiates. Since the demo
  // doesn't ship any sensitive endpoints, allow any origin with
  // credentials. Tighten in production.
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("access-control-allow-credentials", "true");
    res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
    res.setHeader("access-control-allow-headers", "content-type");
  }
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  let url;
  try {
    url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  } catch {
    res.writeHead(400).end("bad request");
    return;
  }

  if (req.method === "GET" && url.pathname === "/") {
    return sendHtml(res, 200, homePage(req));
  }
  if (req.method === "GET" && url.pathname === "/me") {
    return handleMe(req, res);
  }
  if (req.method === "POST" && url.pathname === "/api/login") {
    return handleApiLogin(req, res);
  }
  if (req.method === "POST" && url.pathname === "/api/logout") {
    return handleLogout(req, res);
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
});

server.listen(PORT, HOST, () => {
  console.log(`[demo-rp] listening on http://${HOST}:${PORT}`);
  console.log(`[demo-rp] demo credentials: ${DEMO_USERNAME} / ${DEMO_PASSWORD}`);
  console.log(`[demo-rp] vault entry loginConfig.loginUrl: http://${HOST}:${PORT}/api/login`);
});
