#!/usr/bin/env node
// Reviewer demo site — the thing that makes this extension testable by someone
// who will not open a terminal.
//
// Onboarding the wallet is a two-party handshake. The wallet mints an ephemeral
// `did:key` in the reviewer's own browser and shows them a command:
//
//   pnm acl create --did did:key:z… --role admin --expires 1h
//
// Someone with access to the agent has to run it before "Connect" works. The
// ephemeral is per-installation, so it cannot be granted ahead of time, and the
// agent has no self-service enrolment path. A Chrome Web Store reviewer has
// neither a shell on the agent nor a reason to trust one — so without this,
// they cannot test the extension at all.
//
// This site stands in for that shell. The reviewer signs in with a key ID from
// the listing's test instructions, pastes the command the wallet is showing
// them, and this runs it against a **throwaway demo agent** with a seven-day
// expiry. Once onboarded, they come back and sign in again — this time with the
// wallet over SIOPv2 — which is itself the flow under review.
//
//   npm start --workspace @openvtc/pnm-reviewer-demo
//
// Configuration (environment):
//   PORT             listen port                                (default 8792)
//   REVIEWER_KEY     key ID for the paste screen. **Set it.**   (default none = open)
//   VTA_DID          the demo agent's DID, shown on the site    (required)
//   VTA_BASE_URL     the demo agent's REST base URL             (required)
//   GRANT_BIN        the VTA CLI                                (default "pnm")
//   GRANT_CONTEXT    context to scope grants to                 (default none)
//   GRANT_EXPIRES    grant lifetime                             (default "7d")
//   MAX_GRANTS_PER_HOUR                                          (default 40)
//   RESET_SCRIPT     absolute path to the reset script; the
//                    Reset button is hidden while unset         (default none)
//   DEMO_DELETES_ON  ISO date the whole demo is torn down       (default none)
//   DEMO_TASK_TYPE   task behind the approval-prompt button     (default auth/whoami/0.1)
//   SECURE_COOKIE    set to "1" behind TLS                      (default off)
//
// **Point this only at a demo agent that can be destroyed.** Onboarding needs
// an admin grant, so anyone holding the key ID gets admin on that agent for a
// week. The expiry, the context scoping and the hourly ceiling bound the blast
// radius; none of them make this safe in front of an agent holding anything
// real. The site says so on every screen, because a reviewer typing their own
// data into it would be a worse outcome than a failed review.

import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.PORT ?? 8792);
const REVIEWER_KEY = process.env.REVIEWER_KEY ?? "";
const VTA_DID = process.env.VTA_DID ?? "";
const VTA_BASE_URL = (process.env.VTA_BASE_URL ?? "").replace(/\/+$/, "");
const GRANT_BIN = process.env.GRANT_BIN ?? "pnm";
const GRANT_CONTEXT = process.env.GRANT_CONTEXT ?? "";
const GRANT_EXPIRES = process.env.GRANT_EXPIRES ?? "7d";
const MAX_GRANTS_PER_HOUR = Number(process.env.MAX_GRANTS_PER_HOUR ?? 40);
const RESET_SCRIPT = process.env.RESET_SCRIPT ?? "";
const DEMO_DELETES_ON = process.env.DEMO_DELETES_ON ?? "";
const SECURE_COOKIE = process.env.SECURE_COOKIE === "1";
// The task the walkthrough's approval-prompt button proposes. The default is
// read-only introspection: the point of that button is the prompt, so the task
// behind it should be the least consequential one the agent supports. An
// operator whose demo agent has a policy-gated task can point this at it, and
// the same button then demonstrates the second round — the approver's digest
// match — as well as the first.
const DEMO_TASK_TYPE =
  process.env.DEMO_TASK_TYPE ?? "https://trusttasks.org/spec/auth/whoami/0.1";

const PUBLIC_DIR = join(import.meta.dirname, "public");
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * True when this file was run, rather than imported.
 *
 * The parser below is unit-tested, and a test that imports this module must not
 * find itself running a web server on a real port — so binding, and the
 * configuration checks that would exit the process, happen only for the
 * entrypoint.
 */
const isEntrypoint =
  Boolean(process.argv[1]) && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

// ── sessions ────────────────────────────────────────────────────────────────
// In memory, and deliberately so: a restart signing everyone out is the right
// failure mode for a demo, and nothing here is worth persisting.

/** @type {Map<string, { expiresAt: number, method: string, did?: string }>} */
const sessions = new Map();

function newSession(method, did) {
  const token = randomBytes(32).toString("base64url");
  sessions.set(token, { expiresAt: Date.now() + SESSION_TTL_MS, method, did });
  return token;
}

function readSession(req) {
  const raw = req.headers.cookie ?? "";
  const match = /(?:^|;\s*)demo_session=([A-Za-z0-9_-]+)/.exec(raw);
  if (!match) return null;
  const s = sessions.get(match[1]);
  if (!s) return null;
  if (s.expiresAt < Date.now()) {
    sessions.delete(match[1]);
    return null;
  }
  return { token: match[1], ...s };
}

function cookieHeader(token) {
  const parts = [
    `demo_session=${token}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ];
  if (SECURE_COOKIE) parts.push("Secure");
  return parts.join("; ");
}

/** Constant-time compare that does not leak the key's length. */
function keyMatches(supplied) {
  if (!REVIEWER_KEY) return true;
  const a = Buffer.from(String(supplied ?? ""));
  const b = Buffer.from(REVIEWER_KEY);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// ── grant ───────────────────────────────────────────────────────────────────

/**
 * `did:key` in base58btc multibase — the only shape the wallet's ephemeral ever
 * takes, and the only thing that reaches `execFile`.
 *
 * Anchored where it is tested whole, and narrow by construction: base58btc
 * excludes whitespace, every shell metacharacter, and a leading `-` that argv
 * could read as a flag. The value is passed as argv rather than through a shell
 * regardless — this is the belt to that brace.
 */
const DID_KEY_ANYWHERE = /(did:key:z[1-9A-HJ-NP-Za-km-z]{40,120})/;
const DID_KEY_WHOLE = /^did:key:z[1-9A-HJ-NP-Za-km-z]{40,120}$/;

/**
 * Pull the grant out of whatever the reviewer pasted.
 *
 * They are copying from a wallet UI into a web form, so accept the whole
 * command, a command that wrapped across lines, or just the DID on its own —
 * every one of those is a reviewer who did the right thing. What is *not*
 * accepted is a role beyond the two the wallet ever prints, and the expiry is
 * always this site's, never the pasted one: the command says `1h`, which is far
 * too short for someone reviewing an extension between other work.
 */
export function parseGrantCommand(text) {
  const input = String(text ?? "").trim();
  if (!input) return { ok: false, error: "Nothing pasted." };

  const did = DID_KEY_WHOLE.test(input)
    ? input
    : (DID_KEY_ANYWHERE.exec(input)?.[1] ?? null);
  if (!did) {
    return {
      ok: false,
      error:
        "No did:key found in that. Copy the whole line the wallet is showing " +
        "you — it looks like `pnm acl create --did did:key:z… --role admin " +
        "--expires 1h` — or just the did:key:z… part on its own.",
    };
  }

  const roleMatch = /--role[\s=]+(super-admin|admin)\b/.exec(input);
  const otherRole = /--role[\s=]+([\w-]+)/.exec(input);
  if (!roleMatch && otherRole) {
    return {
      ok: false,
      error: `This demo grants the "admin" and "super-admin" roles only; that command asks for "${otherRole[1]}".`,
    };
  }

  return { ok: true, did, role: roleMatch?.[1] ?? "admin" };
}

/** Grant timestamps inside the trailing hour. Memory-only: a restart clearing
 *  the ceiling is the correct failure mode for a demo. */
let recentGrants = [];

function underCeiling() {
  const cutoff = Date.now() - 3_600_000;
  recentGrants = recentGrants.filter((t) => t > cutoff);
  return recentGrants.length < MAX_GRANTS_PER_HOUR;
}

function runGrant(did, role) {
  const args = ["acl", "create", "--did", did, "--role", role, "--expires", GRANT_EXPIRES];
  if (GRANT_CONTEXT) args.push("--contexts", GRANT_CONTEXT);
  return new Promise((resolve) => {
    execFile(GRANT_BIN, args, { timeout: 30_000 }, (err, stdout, stderr) => {
      if (err) {
        // The CLI's own message is the useful one, and the reviewer has no
        // other diagnostic channel — pass it through rather than flattening it.
        resolve({ ok: false, error: (stderr || err.message || "grant failed").trim() });
        return;
      }
      resolve({ ok: true, output: (stdout || "").trim() });
    });
  });
}

function runReset() {
  return new Promise((resolve) => {
    execFile(RESET_SCRIPT, [], { timeout: 120_000 }, (err, stdout, stderr) => {
      if (err) {
        resolve({ ok: false, error: (stderr || err.message || "reset failed").trim() });
        return;
      }
      resolve({ ok: true, output: (stdout || "").trim() });
    });
  });
}

// ── SIOPv2 verification ─────────────────────────────────────────────────────

/**
 * Verify a login the wallet performed against the demo agent.
 *
 * The page hands us the access token and session id the wallet returned. Both
 * came through the page, so neither is evidence on its own — the check is to
 * spend the token against the agent that would have issued it. A 200 from
 * `/auth/sessions` means the agent minted this token, and the entry matching
 * `sessionId` carries the DID the agent authenticated, which is the only
 * account of who signed in that this site did not receive from the browser.
 */
async function verifySiopLogin(accessToken, sessionId) {
  let res;
  try {
    res = await fetch(`${VTA_BASE_URL}/auth/sessions`, {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    return { ok: false, error: `could not reach the demo agent: ${e instanceof Error ? e.message : e}` };
  }
  if (!res.ok) {
    return { ok: false, error: `the demo agent rejected that session (HTTP ${res.status})` };
  }
  let sessionList;
  try {
    sessionList = await res.json();
  } catch {
    return { ok: false, error: "the demo agent returned a session list this site could not read" };
  }
  if (!Array.isArray(sessionList)) {
    return { ok: false, error: "unexpected session list shape from the demo agent" };
  }
  const found = sessionList.find((s) => s?.session_id === sessionId);
  if (!found) {
    return { ok: false, error: "that session is not one the demo agent knows about" };
  }
  return { ok: true, did: typeof found.did === "string" ? found.did : "(unknown)" };
}

// ── plumbing ────────────────────────────────────────────────────────────────

// An explicit map rather than a path join: there is no traversal to defend
// against if the request path never reaches the filesystem in the first place.
const STATIC = {
  "/static/demo.css": ["demo.css", "text/css; charset=utf-8"],
  "/static/shared.js": ["shared.js", "text/javascript; charset=utf-8"],
  "/static/login.js": ["login.js", "text/javascript; charset=utf-8"],
  "/static/app.js": ["app.js", "text/javascript; charset=utf-8"],
};

function sendHtml(res, status, file, extraHeaders = {}) {
  const body = readFileSync(join(PUBLIC_DIR, file));
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    // The pages load only their own assets and talk only to this origin and
    // the demo agent; `connect-src` has to allow the agent because the SIOPv2
    // panel reports on it.
    "content-security-policy":
      "default-src 'none'; script-src 'self'; style-src 'self'; " +
      `connect-src 'self' ${VTA_BASE_URL}; form-action 'self'; base-uri 'none'`,
    ...extraHeaders,
  });
  res.end(body);
}

function sendJson(res, status, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...extraHeaders,
  });
  res.end(body);
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 8192) throw new Error("body too large");
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/**
 * Same-origin check for state-changing requests.
 *
 * The session cookie is `SameSite=Lax`, which already keeps it off
 * cross-site POSTs; this is the second lock. A request with no `Origin` at all
 * is refused rather than waved through — every caller here is `fetch` from our
 * own page, and every one of those sends it.
 */
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return false;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const session = readSession(req);

  try {
    // ── static + pages ──
    if (req.method === "GET" && STATIC[url.pathname]) {
      const [file, type] = STATIC[url.pathname];
      res.writeHead(200, {
        "content-type": type,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      res.end(readFileSync(join(PUBLIC_DIR, file)));
      return;
    }

    if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok\n");
      return;
    }

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      if (session) {
        res.writeHead(302, { location: "/app", "cache-control": "no-store" });
        res.end();
        return;
      }
      sendHtml(res, 200, "index.html");
      return;
    }

    if (req.method === "GET" && url.pathname === "/app") {
      if (!session) {
        res.writeHead(302, { location: "/", "cache-control": "no-store" });
        res.end();
        return;
      }
      sendHtml(res, 200, "app.html");
      return;
    }

    // ── public config, read by both pages ──
    if (req.method === "GET" && url.pathname === "/api/config") {
      sendJson(res, 200, {
        vtaDid: VTA_DID,
        vtaBaseUrl: VTA_BASE_URL,
        grantExpires: GRANT_EXPIRES,
        demoTaskType: DEMO_TASK_TYPE,
        deletesOn: DEMO_DELETES_ON,
        resetEnabled: Boolean(RESET_SCRIPT),
        keyRequired: Boolean(REVIEWER_KEY),
        signedIn: Boolean(session),
        signedInAs: session?.did ?? null,
        signedInVia: session?.method ?? null,
      });
      return;
    }

    // ── everything below changes state ──
    if (req.method === "POST" && !sameOrigin(req)) {
      sendJson(res, 403, { ok: false, error: "cross-origin request refused" });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/login-key") {
      const body = await readJsonBody(req);
      if (!keyMatches(body.key)) {
        sendJson(res, 403, {
          ok: false,
          error: "That reviewer key ID is not right. It is in the test instructions for this listing.",
        });
        return;
      }
      const token = newSession("key");
      sendJson(res, 200, { ok: true }, { "set-cookie": cookieHeader(token) });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/login-siop") {
      const body = await readJsonBody(req);
      const accessToken = typeof body.accessToken === "string" ? body.accessToken : "";
      const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
      if (!accessToken || !sessionId) {
        sendJson(res, 400, { ok: false, error: "the wallet returned no session to verify" });
        return;
      }
      const verified = await verifySiopLogin(accessToken, sessionId);
      if (!verified.ok) {
        sendJson(res, 401, { ok: false, error: verified.error });
        return;
      }
      const token = newSession("siop", verified.did);
      console.log(`[reviewer-demo] SIOPv2 sign-in verified for ${verified.did}`);
      sendJson(res, 200, { ok: true, did: verified.did }, { "set-cookie": cookieHeader(token) });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/logout") {
      if (session) sessions.delete(session.token);
      sendJson(
        res,
        200,
        { ok: true },
        { "set-cookie": "demo_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0" },
      );
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/acl") {
      if (!session) {
        sendJson(res, 401, { ok: false, error: "sign in first" });
        return;
      }
      const body = await readJsonBody(req);
      const parsed = parseGrantCommand(body.command);
      if (!parsed.ok) {
        sendJson(res, 400, { ok: false, error: parsed.error });
        return;
      }
      if (!underCeiling()) {
        sendJson(res, 429, {
          ok: false,
          error: "This demo has issued its hourly limit of authorisations. Try again shortly.",
        });
        return;
      }
      const result = await runGrant(parsed.did, parsed.role);
      if (!result.ok) {
        console.error(`[reviewer-demo] grant FAILED ${parsed.did}: ${result.error}`);
        sendJson(res, 502, { ok: false, error: `The demo agent refused it: ${result.error}` });
        return;
      }
      recentGrants.push(Date.now());
      console.log(`[reviewer-demo] granted ${parsed.role} to ${parsed.did} for ${GRANT_EXPIRES}`);
      sendJson(res, 200, {
        ok: true,
        did: parsed.did,
        role: parsed.role,
        expires: GRANT_EXPIRES,
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/reset") {
      if (!session) {
        sendJson(res, 401, { ok: false, error: "sign in first" });
        return;
      }
      if (!RESET_SCRIPT) {
        sendJson(res, 501, { ok: false, error: "no reset script is configured on this demo" });
        return;
      }
      const result = await runReset();
      if (!result.ok) {
        console.error(`[reviewer-demo] reset FAILED: ${result.error}`);
        sendJson(res, 502, { ok: false, error: result.error });
        return;
      }
      console.log("[reviewer-demo] demo agent reset to its starting state");
      sendJson(res, 200, { ok: true, output: result.output.slice(0, 2000) });
      return;
    }

    sendJson(res, 404, { ok: false, error: "not found" });
  } catch (e) {
    console.error("[reviewer-demo]", e);
    sendJson(res, 500, { ok: false, error: "internal error" });
  }
});

if (isEntrypoint) {
  if (!VTA_DID || !VTA_BASE_URL) {
    console.error(
      "VTA_DID and VTA_BASE_URL are required — they are what the reviewer is " +
        "pointed at, and every screen displays them.",
    );
    process.exit(1);
  }
  if (!REVIEWER_KEY) {
    console.warn(
      "[reviewer-demo] REVIEWER_KEY is not set: anyone who finds this page can " +
        "grant themselves access to the demo agent.",
    );
  }

  server.listen(PORT, () => {
    console.log(
      `[reviewer-demo] listening on :${PORT}\n` +
        `  agent    ${VTA_DID}\n` +
        `  api      ${VTA_BASE_URL}\n` +
        `  grants   ${GRANT_EXPIRES}, role admin|super-admin` +
        `${GRANT_CONTEXT ? `, context ${GRANT_CONTEXT}` : ""}\n` +
        `  key ID   ${REVIEWER_KEY ? "required" : "NOT SET (open to anyone)"}\n` +
        `  reset    ${RESET_SCRIPT ? RESET_SCRIPT : "not configured (button hidden)"}\n` +
        `  task     ${DEMO_TASK_TYPE}\n` +
        `  deletes  ${DEMO_DELETES_ON || "date not configured"}`,
    );
  });
}
