// The legacy SIOPv2 sign-in methods on `window.vtaWallet`, pinned.
//
// `login`, `loginDidcomm` and `proxyLogin` are deprecated (sign-in contract
// C7) but are kept, unchanged, for every page that already calls them. The
// only permitted difference is a one-time console notice. These tests hold the
// rest: the methods exist with the same arity, post the same bridge message
// (`{ source, id, method, params }`, params passed through untouched) to the
// content script, resolve with the content script's `result` as is, and reject
// with an `Error` whose message is the content script's `error` verbatim.
//
// It also pins the content script's routing of the three methods to the same
// runtime message types the background has always handled.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Window } from "happy-dom";

const INPAGE_SOURCE = "vta-wallet/inpage";
const CONTENT_SOURCE = "vta-wallet/content";

const win = new Window({ url: "https://rp.example.org/login" });
Object.defineProperty(globalThis, "window", { value: win, writable: true, configurable: true });
Object.defineProperty(globalThis, "CustomEvent", { value: win.CustomEvent, writable: true, configurable: true });

const warnings: unknown[][] = [];
const realWarn = console.warn;
console.warn = (...args: unknown[]) => void warnings.push(args);
await import("../src/provider.ts");
console.warn = realWarn;

type Posted = { source: string; id: string; method: string; params: unknown };

/** The content script, played by the test: answer the next request with
 *  `reply`, and record what the provider posted. */
function contentScript(reply: { ok: true; result: unknown } | { ok: false; error: string }) {
  const seen: Posted[] = [];
  const listener = (e: { data: unknown }) => {
    const data = e.data as Posted;
    if (!data || data.source !== INPAGE_SOURCE) return;
    seen.push(data);
    win.postMessage({ source: CONTENT_SOURCE, id: data.id, ...reply }, win.location.origin);
  };
  win.addEventListener("message", listener as never);
  return { seen, done: () => win.removeEventListener("message", listener as never) };
}

const wallet = () => (win as unknown as { vtaWallet: Record<string, (p: unknown) => Promise<unknown>> }).vtaWallet;

const CASES = [
  {
    method: "login",
    params: { rpDid: "did:web:rp.example.org", baseUrl: "https://rp.example.org", nonce: "n-1" },
  },
  {
    method: "loginDidcomm",
    params: { controlDid: "did:web:rp.example.org", mediatorDid: "did:web:mediator.example.org", nonce: "n-2" },
  },
  {
    method: "proxyLogin",
    params: { rpDid: "did:web:rp.example.org", baseUrl: "https://rp.example.org" },
  },
] as const;

test("the legacy sign-in methods are still on window.vtaWallet, one parameter each", () => {
  for (const { method } of CASES) {
    assert.equal(typeof wallet()[method], "function", method);
    assert.equal(wallet()[method]!.length, 1, `${method} takes one parameter`);
  }
});

for (const { method, params } of CASES) {
  test(`${method}: posts the same bridge message and resolves with the result unchanged`, async () => {
    const result = { idToken: "eyJ.x.y", accessToken: "at", nested: { a: [1, 2] } };
    const cs = contentScript({ ok: true, result });
    try {
      const got = await wallet()[method]!(params);
      assert.deepEqual(got, result);
      assert.equal(cs.seen.length, 1);
      const msg = cs.seen[0]!;
      assert.deepEqual(Object.keys(msg).sort(), ["id", "method", "params", "source"]);
      assert.equal(msg.source, INPAGE_SOURCE);
      assert.equal(msg.method, method);
      assert.deepEqual(msg.params, params, "params passed through untouched");
      assert.equal(typeof msg.id, "string");
    } finally {
      cs.done();
    }
  });

  test(`${method}: rejects with the content script's error message verbatim`, async () => {
    const cs = contentScript({ ok: false, error: "user denied the login" });
    try {
      await assert.rejects(wallet()[method]!(params), (e: unknown) => {
        assert.ok(e instanceof Error);
        assert.equal((e as Error).message, "user denied the login");
        return true;
      });
    } finally {
      cs.done();
    }
  });
}

test("the deprecation notice is a console warning, once per method, and nothing else", async () => {
  const seen: unknown[][] = [];
  console.warn = (...args: unknown[]) => void seen.push(args);
  try {
    for (const { method, params } of CASES) {
      for (let i = 0; i < 2; i++) {
        const cs = contentScript({ ok: true, result: {} });
        await wallet()[method]!(params);
        cs.done();
      }
    }
  } finally {
    console.warn = realWarn;
  }
  // The earlier tests already used each method once, so no further notice.
  assert.deepEqual(seen, []);
  assert.deepEqual(warnings, [], "no notice merely for loading the provider");
});

test("the content script still routes the legacy methods to the same runtime types", () => {
  const content = readFileSync(fileURLToPath(new URL("../src/content.ts", import.meta.url)), "utf8");
  const pin: Record<string, [string, string]> = {
    login: ["RUNTIME_LOGIN", "vta-wallet/login"],
    loginDidcomm: ["RUNTIME_LOGIN_DIDCOMM", "vta-wallet/login-didcomm"],
    proxyLogin: ["RUNTIME_VAULT_PROXY_LOGIN_PAGE", "vta-wallet/vault-proxy-login-page"],
  };
  for (const [method, [constant, value]] of Object.entries(pin)) {
    assert.match(content, new RegExp(`^const ${constant} = "${value}";$`, "m"), constant);
    assert.match(content, new RegExp(`^\\s*${method}: ${constant},$`, "m"), method);
  }
});
