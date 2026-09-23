// The "Show QR code" button every DID carries — see src/did-qr-view.tsx.
//
// Pinned here: the button opens a popover holding the code and the full DID;
// it does not also fire the row or card the DID sits in (the popover's
// outside-click catcher is inside that row as far as React is concerned); and
// a DID inside another control carries no button of its own.

import { test } from "node:test";
import assert from "node:assert/strict";
import { h, render } from "./harness/dom.mjs";
import { Did } from "../src/ui.js";

const DID = "did:webvh:QmXi1PZD4NEvcvjfErAzVoCGtBFEv7dhXZQJHvcFY4U83F:webvh.storm.ws:first-vtc";

type Screen = Awaited<ReturnType<typeof render>>;
const qrButton = (screen: Screen) =>
  screen.container.querySelector<HTMLButtonElement>('button[aria-label="Show this DID as a QR code"]');
/** The popover is portalled to `document.body`, outside the render container. */
const dialog = (screen: Screen) =>
  screen.container.ownerDocument.querySelector<HTMLElement>('[role="dialog"][aria-label="DID as a QR code"]');

test("a DID carries a QR button that opens the code and the full DID", async () => {
  const screen = await render(h(Did, { value: DID }));
  const button = qrButton(screen);
  assert.ok(button, "the DID has a QR button");
  assert.equal(button.getAttribute("aria-expanded"), "false");
  assert.equal(dialog(screen), null);

  await screen.click(button);
  const pop = dialog(screen);
  assert.ok(pop, "the popover opened");
  assert.equal(button.getAttribute("aria-expanded"), "true");
  assert.ok(pop.querySelector(`svg[aria-label="QR code of ${DID}"] path`), "the code is drawn");
  assert.match(pop.textContent ?? "", new RegExp(DID.replace(/[.]/g, "\\.")));
  assert.match(pop.textContent ?? "", /Copy DID/);

  await screen.key("Escape");
  assert.equal(dialog(screen), null, "Escape closes it");
  await screen.unmount();
});

test("opening and dismissing the code does not click the row the DID sits in", async () => {
  let rowClicks = 0;
  const screen = await render(
    h("div", { onClick: () => rowClicks++ }, h(Did, { value: DID })),
  );
  await screen.click(qrButton(screen)!);
  assert.ok(dialog(screen));

  // The transparent catcher behind the popover: a click "outside" it.
  const catcher = dialog(screen)!.previousElementSibling as HTMLElement;
  await screen.click(catcher);
  assert.equal(dialog(screen), null, "an outside click closes it");
  assert.equal(rowClicks, 0, "neither click reached the row");
  await screen.unmount();
});

test("qr={false} draws the DID alone, for a DID inside another control", async () => {
  const screen = await render(h("button", null, h(Did, { value: DID, qr: false })));
  assert.equal(qrButton(screen), null);
  assert.equal(screen.container.querySelectorAll("button").length, 1, "no button inside the button");
  await screen.unmount();
});
