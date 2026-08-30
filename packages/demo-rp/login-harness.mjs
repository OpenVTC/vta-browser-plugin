// A test website for the RP login paths.
//
// The wallet's two RP-login flows — REST SIOPv2 (`login`) and DIDComm
// (`loginDidcomm`) — had no way to be exercised outside a real deployment, and
// one of them was broken for an unknown length of time because of it: the
// plugin sent a retired `authenticate` Type URI that the control plane no
// longer routes, and nothing noticed, because nothing drove the flow (plugin
// #139).
//
// This is the missing half of that loop. It serves a page that calls
// `window.vtaWallet` exactly as a real relying party would, against a control
// plane of your choosing — the live one, or a `did-hosting-control` on
// localhost — and shows what came back. It asserts nothing itself: the point is
// to make the round-trip observable, with the wallet's own console alongside.
//
// It is deliberately NOT part of `server.mjs`. That one is a password-login
// target for the VTA's `vault/proxy-login` driver and shares nothing with this
// but a workspace.
//
//   node packages/demo-rp/login-harness.mjs
//
// Env:
//   PORT         4041
//   HOST         127.0.0.1
//   CONTROL_DID  the RP's control DID, prefilled into the form
//   MEDIATOR_DID the RP's mediator DID, prefilled into the form
//   BASE_URL     the RP's REST base, for the SIOP path

import { createServer } from "node:http";

const PORT = Number(process.env.PORT ?? 4041);
const HOST = process.env.HOST ?? "127.0.0.1";
const CONTROL_DID = process.env.CONTROL_DID ?? "";
const MEDIATOR_DID = process.env.MEDIATOR_DID ?? "";
const BASE_URL = process.env.BASE_URL ?? "";

const page = `<!doctype html>
<meta charset="utf-8">
<title>RP login harness</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 14px/1.5 system-ui, sans-serif; margin: 0 auto; max-width: 46rem; padding: 2rem 1rem; }
  h1 { font-size: 1.25rem; }
  label { display: block; margin: .75rem 0 .25rem; font-weight: 600; }
  input { width: 100%; padding: .4rem .5rem; font: inherit; box-sizing: border-box; }
  button { margin: 1rem .5rem 0 0; padding: .5rem .9rem; font: inherit; cursor: pointer; }
  pre { background: rgba(127,127,127,.12); padding: .75rem; overflow-x: auto; border-radius: 4px; }
  .muted { opacity: .7; }
</style>
<h1>RP login harness</h1>
<p class="muted">Drives <code>window.vtaWallet</code> against a did-hosting control plane, the
way a relying party would. Keep the wallet's offscreen console open beside this.</p>

<p id="provider" class="muted">Looking for the wallet…</p>

<label for="controlDid">Control DID <span class="muted">(DIDComm login: authcrypt recipient, ACL subject)</span></label>
<input id="controlDid" value="${CONTROL_DID}" placeholder="did:webvh:…">

<label for="mediatorDid">Mediator DID <span class="muted">(from the control DID's DIDCommMessaging service)</span></label>
<input id="mediatorDid" value="${MEDIATOR_DID}" placeholder="did:webvh:…">

<label for="baseUrl">REST base URL <span class="muted">(SIOP login only)</span></label>
<input id="baseUrl" value="${BASE_URL}" placeholder="https://…">

<button id="didcomm">Login over DIDComm</button>
<button id="siop">Login over REST (SIOP)</button>
<button id="proxy">Login as a per-site persona (proxy SIOP)</button>
<button id="profile">Which identity does this site know me as?</button>

<p class="muted">The proxy button names no vault entry, which is the point: the wallet resolves
one from this origin, and on a first visit asks which identity to use and binds the answer. A
second click should not prompt for an identity again.</p>

<h2 style="font-size:1rem">Result</h2>
<pre id="out">—</pre>

<script>
  const out = document.getElementById("out");
  const show = (label, value) => {
    out.textContent = label + "\\n\\n" + (typeof value === "string" ? value : JSON.stringify(value, null, 2));
  };

  // The provider is injected into granted origins only, and registration does
  // not reach an already-open tab — so a first visit after granting needs a
  // reload. Say so rather than leaving a dead button.
  const probe = () => {
    const el = document.getElementById("provider");
    if (window.vtaWallet) {
      el.textContent = "Wallet provider found.";
      return true;
    }
    el.textContent =
      "No wallet provider on this origin. Grant this site in the extension, then reload — " +
      "content scripts are registered per granted origin and do not reach tabs that are already open.";
    return false;
  };
  probe();
  setTimeout(probe, 500);

  const val = (id) => document.getElementById(id).value.trim();

  document.getElementById("didcomm").addEventListener("click", async () => {
    if (!probe()) return;
    show("Requesting DIDComm login…", "The wallet should raise a consent prompt.");
    try {
      const r = await window.vtaWallet.loginDidcomm({
        controlDid: val("controlDid"),
        mediatorDid: val("mediatorDid"),
      });
      show("loginDidcomm resolved", r);
    } catch (e) {
      show("loginDidcomm rejected", String(e && e.message ? e.message : e));
    }
  });

  // The shape an RP uses when its challenge is bound to the persona DID: ask
  // the wallet who this site knows you as, THEN fetch a challenge for that DID,
  // then mint. Here it just reports the answer — the harness has no challenge
  // endpoint of its own — which is enough to see the first-use prompt fire and
  // to confirm a second click does not prompt again.
  document.getElementById("profile").addEventListener("click", async () => {
    if (!probe()) return;
    show(
      "Asking the wallet…",
      "On a first visit it should ask which identity to bind to this site.",
    );
    try {
      const r = await window.vtaWallet.walletProfile({});
      show(r.bound ? "walletProfile bound a new identity" : "walletProfile resolved", r);
    } catch (e) {
      show("walletProfile rejected", String(e && e.message ? e.message : e));
    }
  });

  // Deliberately passes NO entryId. A page that supplies one has had to call
  // vaultList() to learn it — a second consent prompt that enumerates the
  // user's vault to this site. Omitting it is the shape a relying party should
  // actually use, so it is the shape the harness exercises.
  document.getElementById("proxy").addEventListener("click", async () => {
    if (!probe()) return;
    show(
      "Requesting proxy login…",
      "On a first visit the wallet should ask which identity to sign in as.",
    );
    try {
      const r = await window.vtaWallet.proxyLogin({});
      show("proxyLogin resolved", r);
    } catch (e) {
      show("proxyLogin rejected", String(e && e.message ? e.message : e));
    }
  });

  document.getElementById("siop").addEventListener("click", async () => {
    if (!probe()) return;
    show("Requesting SIOP login…", "The wallet should raise a consent prompt.");
    try {
      const r = await window.vtaWallet.login({
        baseUrl: val("baseUrl"),
        rpDid: val("controlDid"),
      });
      show("login resolved", r);
    } catch (e) {
      show("login rejected", String(e && e.message ? e.message : e));
    }
  });
</script>
`;

createServer((req, res) => {
  if (req.url === "/favicon.ico") {
    res.writeHead(204).end();
    return;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page);
}).listen(PORT, HOST, () => {
  console.log(`[login-harness] http://${HOST}:${PORT}`);
  if (!CONTROL_DID) {
    console.log("[login-harness] set CONTROL_DID / MEDIATOR_DID / BASE_URL to prefill the form");
  }
});
