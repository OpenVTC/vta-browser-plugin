// What a verified room file may be shown as — decided by its bytes, never by
// the type its author claimed — and the queue background fetches go through.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mayPreview, previewKind, textOf, worthAutoPreview, AUTO_PREVIEW_MAX_BYTES } from "../src/manager/file-preview.js";
import { createLimiter } from "../src/manager/limit.js";

const bytes = (...xs: (number | string)[]) =>
  new Uint8Array(xs.flatMap((x) => (typeof x === "string" ? [...x].map((ch) => ch.charCodeAt(0)) : [x])));

test("raster images are recognised by their signature", () => {
  assert.equal(previewKind(bytes(0x89, "PNG", 0x0d, 0x0a, 0x1a, 0x0a, 0)), "png");
  assert.equal(previewKind(bytes(0xff, 0xd8, 0xff, 0xe0)), "jpeg");
  assert.equal(previewKind(bytes("GIF89a", 1)), "gif");
  assert.equal(previewKind(bytes("RIFF", 0, 0, 0, 0, "WEBPVP8 ")), "webp");
});

// The ones a preview must never draw, whatever a record says they are.
test("markup and documents are download only", () => {
  const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  assert.equal(previewKind(svg), "text", "SVG is shown as its text, never drawn");
  assert.equal(previewKind(bytes("%PDF-1.7", 0, 1, 2)), null);
  assert.equal(previewKind(bytes("PK", 3, 4, 0, 0)), null, "a .docx is a zip");
});

test("text is UTF-8 with no control characters", () => {
  assert.equal(textOf(new TextEncoder().encode("Settled on \"Trustie\"\n\tdone")), "Settled on \"Trustie\"\n\tdone");
  assert.equal(textOf(bytes(0xc3, 0x28)), null, "not UTF-8");
  assert.equal(textOf(bytes("a", 0x1b, "[31m")), null, "an escape sequence is not plain text");
});

test("only small pictures are fetched unasked; the claim only decides whether to fetch", () => {
  assert.equal(worthAutoPreview({ name: "a.png", size: 1000, mediaType: "image/png" }), true);
  assert.equal(worthAutoPreview({ name: "a.png", size: AUTO_PREVIEW_MAX_BYTES + 1, mediaType: "image/png" }), false);
  assert.equal(worthAutoPreview({ name: "a.pdf", size: 1000, mediaType: "application/pdf" }), false);
  assert.equal(mayPreview({ name: "notes.md" }), true);
  assert.equal(mayPreview({ name: "deck.pptx" }), false);
});

test("the queue runs a few at a time, in the order asked", async () => {
  const limit = createLimiter(2);
  let running = 0;
  let most = 0;
  const order: number[] = [];
  const task = (n: number) => () =>
    new Promise<number>((resolve) => {
      running++;
      most = Math.max(most, running);
      order.push(n);
      setTimeout(() => {
        running--;
        resolve(n);
      }, 5);
    });
  const results = await Promise.all([1, 2, 3, 4, 5].map((n) => limit.run(task(n))));
  assert.deepEqual(results, [1, 2, 3, 4, 5]);
  assert.deepEqual(order, [1, 2, 3, 4, 5]);
  assert.equal(most, 2);
});

test("a failed task does not stall the queue", async () => {
  const limit = createLimiter(1);
  await assert.rejects(limit.run(() => Promise.reject(new Error("host refused"))));
  assert.equal(await limit.run(async () => "next"), "next");
});
