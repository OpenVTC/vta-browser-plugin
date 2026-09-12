// The demo RP's CORS answer is an allow-list, and this is what holds it there.
//
// It used to reflect any request `Origin` into `Access-Control-Allow-Origin`
// beside `Access-Control-Allow-Credentials: true` — the pair that tells a
// browser "this origin may read a response sent with the visitor's cookies".
// Reflected, that is every origin, so a page on any site could read `/me` for a
// signed-in visitor. The reproduction was a curl script; this is that script as
// a test, so the behaviour is pinned rather than described in a comment.
//
// Boots the real `server.mjs` as a child process with `PORT=0` — an
// OS-assigned port, so the test never fights whatever holds 4040 — and reads
// the port back off the server's own log line.
//
// Every absence asserted below is paired with a presence. A test that only
// checks a header is missing passes just as happily against a server that
// answers nothing at all.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SERVER = join(dirname(fileURLToPath(import.meta.url)), "..", "server.mjs");

/** An origin the demo has never heard of — the attacker in the reproduction. */
const EVIL = "https://evil.example";
/** An origin an operator named in `ALLOWED_ORIGINS` when starting the server. */
const PARTNER = "https://partner.example";

let child;
/** `http://127.0.0.1:<bound port>` — also the demo's own origin. */
let base;

before(async () => {
  child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: "0", HOST: "127.0.0.1", ALLOWED_ORIGINS: PARTNER },
    stdio: ["ignore", "pipe", "inherit"],
  });
  base = await new Promise((resolve, reject) => {
    let seen = "";
    const timer = setTimeout(
      () => reject(new Error(`the server never reported a port. It said: ${seen}`)),
      10_000,
    );
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      seen += chunk;
      const match = /listening on (http:\/\/\S+)/.exec(seen);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`the server exited before listening (code ${code}). It said: ${seen}`));
    });
  });
});

after(() => {
  child?.kill();
});

/** Log in as the demo user and return the session cookie to send back. */
async function login() {
  const res = await fetch(`${base}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "alice", password: "passw0rd!" }),
  });
  assert.equal(res.status, 200, "the demo credentials must still work");
  const cookie = res.headers.getSetCookie()[0];
  assert.ok(cookie, "login must set a session cookie");
  return cookie.split(";")[0];
}

test("a preflight from an unlisted origin is not answered with that origin", async () => {
  const res = await fetch(`${base}/me`, {
    method: "OPTIONS",
    headers: { origin: EVIL, "access-control-request-method": "GET" },
  });
  assert.equal(res.status, 204, "the preflight itself is still answered");
  assert.equal(
    res.headers.get("access-control-allow-origin"),
    null,
    "the request Origin must not come back — reflecting it is the finding",
  );
  assert.equal(res.headers.get("access-control-allow-credentials"), null);
  // The header that makes a cache keep the two answers apart.
  assert.match(res.headers.get("vary") ?? "", /\borigin\b/i);
});

test("a preflight from the demo's own origin is answered, with credentials", async () => {
  const res = await fetch(`${base}/me`, {
    method: "OPTIONS",
    headers: { origin: base, "access-control-request-method": "GET" },
  });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("access-control-allow-origin"), base);
  assert.equal(res.headers.get("access-control-allow-credentials"), "true");
  assert.match(res.headers.get("vary") ?? "", /\borigin\b/i);
});

test("an origin named in ALLOWED_ORIGINS is answered too", async () => {
  const res = await fetch(`${base}/me`, {
    method: "OPTIONS",
    headers: { origin: PARTNER, "access-control-request-method": "GET" },
  });
  assert.equal(res.headers.get("access-control-allow-origin"), PARTNER);
  assert.equal(res.headers.get("access-control-allow-credentials"), "true");
});

test("a wildcard is never sent, to anyone", async () => {
  // `*` with credentials is refused by every browser, so a server that sends
  // the pair looks permissive and is in fact broken. Neither half appears.
  for (const origin of [base, PARTNER, EVIL]) {
    const res = await fetch(`${base}/`, { headers: { origin } });
    assert.notEqual(res.headers.get("access-control-allow-origin"), "*", `for ${origin}`);
  }
});

test("the credentialed cross-origin read the reproduction showed is no longer permitted", async () => {
  const cookie = await login();

  // curl and `fetch` here ignore CORS, so the body still arrives — the point is
  // that the header a browser needs in order to hand it to page script does
  // not. This is step 5 of the reproduction.
  const stolen = await fetch(`${base}/me`, { headers: { origin: EVIL, cookie } });
  assert.equal(stolen.status, 200, "the session itself is valid, which is what made this a finding");
  assert.equal(
    stolen.headers.get("access-control-allow-origin"),
    null,
    "no allow-origin for evil.example, so the browser refuses the read",
  );

  // And the demo's own page, which is what actually needs this, still works.
  const own = await fetch(`${base}/me`, { headers: { origin: base, cookie } });
  assert.equal(own.status, 200);
  assert.equal(own.headers.get("access-control-allow-origin"), base);
  assert.equal(own.headers.get("access-control-allow-credentials"), "true");
});

test("a request with no Origin at all is unaffected", async () => {
  // The server-to-server path (the VTA's proxy-login POST) sends no Origin and
  // never needed a CORS header; tightening the list must not have touched it.
  const res = await fetch(`${base}/me`);
  assert.equal(res.status, 401, "no session, so no data");
  assert.equal(res.headers.get("access-control-allow-origin"), null);
});
