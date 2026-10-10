// The content script's trigger-link click listener (VTI-LNK-056), in a
// happy-dom window, driven with clicks whose `isTrusted` the test controls.
//
// Pinned: only a person's plain primary click acts; the origin is the page's
// at the click; a link that is not a trigger link navigates normally; and the
// page is told nothing (the handler's only output is the message it sends).

import { test } from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";

import { installTriggerLinkClickHandler, type TriggerLinkActivation } from "../src/trigger-link-click.ts";

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
  const ev = new win.MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init });
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
