// The content script's trigger-link click listener (VTI-LNK-056), in a
// happy-dom window, driven with clicks whose `isTrusted` the test controls.
//
// Pinned: only a person's plain primary click acts; the origin is the page's
// at the click; a link that is not a trigger link navigates normally; and the
// page is told nothing (the handler's only output is the message it sends).

import { test } from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";

import {
  installTriggerLinkClickHandler,
  type TriggerLinkActivation,
  type TriggerLinkNumber,
} from "../src/trigger-link-click.ts";

const EXP = 1791460920;
const LINK =
  "https://link.trustoverip.org/t#_from=did:webvh:QmPEQVM1JPTyrvEgBcDXwjK4TeyLGSX1PxjgyeAisPviUx:members.example.org&_id=Hk2pQ9xV4mT7rW1sZ8yN3A&_exp=1791460920&_type=/vti/flow/sign-in/0.1";

function page(html: string) {
  const win = new Window({ url: "https://members.example.org/members/login" });
  win.document.body.innerHTML = html;
  const sent: TriggerLinkActivation[] = [];
  installTriggerLinkClickHandler(win as unknown as globalThis.Window, {
    send: (m) => sent.push(m),
    now: () => EXP,
  });
  return { win, sent };
}

/** A click as the browser would deliver it; `trusted` stands in for a person. */
function click(win: Window, target: Element, init: MouseEventInit = {}, trusted = true): boolean {
  // A browser's click is composed: it leaves a shadow root with its path.
  const ev = new win.MouseEvent("click", { bubbles: true, cancelable: true, composed: true, button: 0, ...init });
  Object.defineProperty(ev, "isTrusted", { value: trusted, configurable: true });
  target.dispatchEvent(ev as unknown as Event);
  return ev.defaultPrevented;
}

test("a person's click on a sign-in code is taken, with the page's origin", () => {
  const { win, sent } = page(`<a id="qr" href="${LINK}"><svg><rect/></svg></a>`);
  const inner = win.document.querySelector("rect")!;
  assert.equal(click(win, inner as unknown as Element), true, "navigation prevented");
  assert.deepEqual(sent, [{ link: LINK, origin: "https://members.example.org" }]);
});

test("a code the page offers as a way to join says so; any other intent is not passed on", () => {
  const { win, sent } = page(
    `<a id="j" data-oob-intent="join" href="${LINK}">join</a><a id="x" data-oob-intent="admin" href="${LINK}">x</a>`,
  );
  click(win, win.document.getElementById("j")!);
  click(win, win.document.getElementById("x")!);
  assert.deepEqual(sent, [
    { link: LINK, origin: "https://members.example.org", intent: "join" },
    { link: LINK, origin: "https://members.example.org" },
  ]);
});

test("a synthetic click (a.click(), dispatchEvent) is never acted on", () => {
  const { win, sent } = page(`<a id="qr" href="${LINK}">code</a>`);
  const a = win.document.getElementById("qr")!;
  assert.equal(click(win, a as unknown as Element, {}, false), false);
  assert.deepEqual(sent, []);
});

test("an ordinary link navigates normally (pass-on)", () => {
  const { win, sent } = page(`<a id="a" href="https://example.com/help#section">help</a>`);
  assert.equal(click(win, win.document.getElementById("a") as unknown as Element), false);
  assert.deepEqual(sent, []);
});

test("a refused trigger link is still the wallet's: prevented, and sent to be shown", () => {
  const expired = LINK.replace("_exp=1791460920", "_exp=1000");
  const { win, sent } = page(`<a id="a" href="${expired}">code</a>`);
  assert.equal(click(win, win.document.getElementById("a") as unknown as Element), true);
  assert.equal(sent.length, 1);
});

test("modified or non-primary clicks are left to the browser", () => {
  const { win, sent } = page(`<a id="a" href="${LINK}">code</a>`);
  const a = win.document.getElementById("a") as unknown as Element;
  for (const init of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }]) {
    assert.equal(click(win, a, init), false, JSON.stringify(init));
  }
  assert.deepEqual(sent, []);
});

test("a click the page already prevented is not acted on", () => {
  // The page's capture listener is registered before the content script's, so
  // it runs first.
  const win = new Window({ url: "https://members.example.org/" });
  win.document.body.innerHTML = `<a id="a" href="${LINK}">code</a>`;
  win.addEventListener("click", (e) => e.preventDefault(), { capture: true });
  const sent: TriggerLinkActivation[] = [];
  installTriggerLinkClickHandler(win as unknown as globalThis.Window, { send: (m) => sent.push(m), now: () => EXP });
  click(win, win.document.getElementById("a") as unknown as Element);
  assert.deepEqual(sent, []);
});

test("nothing is written back into the page", () => {
  const { win } = page(`<a id="a" href="${LINK}">code</a>`);
  const before = win.document.documentElement.outerHTML;
  const posted: unknown[] = [];
  win.addEventListener("message", (e) => posted.push(e));
  click(win, win.document.getElementById("a") as unknown as Element);
  assert.equal(win.document.documentElement.outerHTML, before);
  assert.deepEqual(posted, []);
});

// ── Backwards compatibility: every link that is not a sign-in code on the link
// host, and every link while there is no wallet, behaves as before. ──

test("only https://<link host>/t#<fields> is taken; every look-alike navigates", () => {
  const lookAlikes = [
    // The reader's grammar on another host: the spec's reader would take it,
    // the click handler does not.
    LINK.replace("link.trustoverip.org", "members.example.org"),
    // Ordinary sites whose URLs happen to carry a reserved name.
    "https://shop.example.com/item?_id=5",
    "https://shop.example.com/item?_from=newsletter&_id=5",
    "https://docs.example.com/page#_from=toc",
    // The link host, but not a trigger link.
    "https://link.trustoverip.org/",
    "https://link.trustoverip.org/about#_from=x",
    "https://link.trustoverip.org/t",
    "https://link.trustoverip.org/t#section",
    "https://link.trustoverip.org/t?_from=did:web:example.org&_id=Hk2pQ9xV4mT7rW1sZ8yN3A",
    LINK.replace("/t#", "/t?x=1#"),
    LINK.replace("https://", "http://"),
    LINK.replace("link.trustoverip.org", "link.trustoverip.org:8443"),
    LINK.replace("/t#", "/t/#"),
    "mailto:someone@example.org",
    "/relative/path",
    "#top",
  ];
  for (const href of lookAlikes) {
    const { win, sent } = page(`<a id="a" href="${href}">x</a>`);
    assert.equal(click(win, win.document.getElementById("a") as unknown as Element), false, href);
    assert.deepEqual(sent, [], href);
  }
});

test("a click that is not on a link is never prevented", () => {
  const { win, sent } = page(`<button id="b">go</button><div id="d">text</div>`);
  for (const id of ["b", "d"]) {
    assert.equal(click(win, win.document.getElementById(id) as unknown as Element), false, id);
  }
  assert.deepEqual(sent, []);
});

test("with no wallet connected, a sign-in code navigates as if the plugin were absent", () => {
  const win = new Window({ url: "https://members.example.org/members/login" });
  win.document.body.innerHTML = `<a id="a" href="${LINK}">code</a>`;
  const sent: TriggerLinkActivation[] = [];
  let ready = false;
  installTriggerLinkClickHandler(win as unknown as globalThis.Window, {
    send: (m) => sent.push(m),
    now: () => EXP,
    walletReady: () => ready,
  });
  const a = win.document.getElementById("a") as unknown as Element;
  assert.equal(click(win, a), false, "not prevented while no wallet");
  assert.deepEqual(sent, []);
  ready = true; // the person connects a VTA; the same page now routes
  assert.equal(click(win, a), true);
  assert.equal(sent.length, 1);
});

test("a configured link host replaces the default", () => {
  const custom = LINK.replace("link.trustoverip.org", "links.example.net");
  const win = new Window({ url: "https://members.example.org/" });
  win.document.body.innerHTML = `<a id="a" href="${custom}">code</a><a id="b" href="${LINK}">code</a>`;
  const sent: TriggerLinkActivation[] = [];
  installTriggerLinkClickHandler(win as unknown as globalThis.Window, {
    send: (m) => sent.push(m),
    now: () => EXP,
    linkHosts: ["links.example.net"],
  });
  assert.equal(click(win, win.document.getElementById("a") as unknown as Element), true);
  assert.equal(click(win, win.document.getElementById("b") as unknown as Element), false);
  assert.equal(sent.length, 1);
});

test("a send that throws (extension reloaded) does not throw into the page", () => {
  const win = new Window({ url: "https://members.example.org/" });
  win.document.body.innerHTML = `<a id="a" href="${LINK}">code</a>`;
  installTriggerLinkClickHandler(win as unknown as globalThis.Window, {
    send: () => {
      throw new Error("Extension context invalidated.");
    },
    now: () => EXP,
  });
  assert.doesNotThrow(() => click(win, win.document.getElementById("a") as unknown as Element));
});

// ── C11: the number the portal shows, read after the click ───────────────────

const ID = "Hk2pQ9xV4mT7rW1sZ8yN3A";

function watchedPage(html: string) {
  const win = new Window({ url: "https://members.example.org/members/login" });
  win.document.body.innerHTML = html;
  const numbers: TriggerLinkNumber[] = [];
  const uninstall = installTriggerLinkClickHandler(win as unknown as globalThis.Window, {
    send: () => {},
    sendNumber: (n) => numbers.push(n),
    now: () => EXP,
  });
  // Uninstalling stops the watch and its timer, so the test can end.
  return { win, numbers, uninstall };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

test("after a click, the number the portal shows for that request is sent once", async (t) => {
  const { win, numbers, uninstall } = watchedPage(`<a id="qr" href="${LINK}">code</a><p id="status"></p>`);
  t.after(uninstall);
  click(win, win.document.getElementById("qr") as unknown as Element);
  await settle();
  assert.deepEqual(numbers, [], "nothing before the page shows it");
  win.document.getElementById("status")!.innerHTML =
    `Your number is <strong data-oob-request-id="${ID}" data-oob-match-number="47">47</strong>`;
  await settle();
  assert.deepEqual(numbers, [{ requestId: ID, matchNumber: "47", origin: "https://members.example.org" }]);
  // Re-rendered: still once.
  win.document.querySelector("strong")!.setAttribute("data-oob-match-number", "48");
  await settle();
  assert.equal(numbers.length, 1);
});

test("a portal that draws its sign-in box in a shadow root has its number read there", async (t) => {
  // The VTC portals render the code and the number inside an open shadow root
  // (their protected widgets); neither the document query nor a document
  // observer sees into it.
  const { win, numbers, uninstall } = watchedPage(`<div id="host" data-protected></div>`);
  t.after(uninstall);
  const root = win.document.getElementById("host")!.attachShadow({ mode: "open" });
  root.innerHTML = `<section><a id="qr" href="${LINK}"><svg><rect/></svg></a></section>`;
  click(win, root.querySelector("rect") as unknown as Element);
  await settle();
  assert.deepEqual(numbers, []);
  // The code is replaced by the number, as the portal's re-render does.
  root.querySelector("section")!.innerHTML =
    `<p>Your number is <strong data-oob-request-id="${ID}" data-oob-match-number="50">50</strong></p>`;
  await settle();
  assert.deepEqual(numbers, [{ requestId: ID, matchNumber: "50", origin: "https://members.example.org" }]);
});

test("a number for another request, or not two digits, is not read", async (t) => {
  const { win, numbers, uninstall } = watchedPage(`<a id="qr" href="${LINK}">code</a><p id="status"></p>`);
  t.after(uninstall);
  click(win, win.document.getElementById("qr") as unknown as Element);
  win.document.getElementById("status")!.innerHTML =
    `<b data-oob-request-id="someone-else" data-oob-match-number="12">12</b>` +
    `<b data-oob-request-id="${ID}" data-oob-match-number="1x">1x</b>`;
  await settle();
  assert.deepEqual(numbers, []);
});

test("without a click the page is not watched", async (t) => {
  const { win, numbers, uninstall } = watchedPage(
    `<strong data-oob-request-id="${ID}" data-oob-match-number="47">47</strong>`,
  );
  await settle();
  assert.deepEqual(numbers, []);
  t.after(uninstall);
  void win;
});
