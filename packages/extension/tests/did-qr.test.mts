// QR geometry for a DID — see src/did-qr.ts.
//
// What matters is that the drawing is exactly the code: a path that dropped or
// doubled a run of modules still renders as a plausible-looking QR code, and
// fails only in a phone camera, where no test here would see it.

import test from "node:test";
import assert from "node:assert/strict";
import qrcode from "qrcode-generator";
import { qrModules, qrPath, QUIET_ZONE } from "../src/did-qr.ts";

const WEBVH = "did:webvh:QmXi1PZD4NEvcvjfErAzVoCGtBFEv7dhXZQJHvcFY4U83F:webvh.storm.ws:first-vtc";

/** Paint the path back onto a grid, the way a renderer would. */
function paint(d: string, side: number): boolean[][] {
  const grid = Array.from({ length: side }, () => Array<boolean>(side).fill(false));
  for (const m of d.matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)) {
    const [x, y, w] = [Number(m[1]), Number(m[2]), Number(m[3])];
    for (let i = 0; i < w; i++) {
      assert.equal(grid[y]![x + i], false, `module (${x + i}, ${y}) drawn twice`);
      grid[y]![x + i] = true;
    }
  }
  return grid;
}

test("a did:webvh is a version-5 code at level M", () => {
  const modules = qrModules(WEBVH);
  assert.equal(modules.length, 37);
  assert.ok(modules.every((row) => row.length === 37));
});

test("the path draws exactly the dark modules, inside the quiet zone", () => {
  const modules = qrModules(WEBVH);
  const { d, side } = qrPath(modules);
  assert.equal(side, modules.length + 2 * QUIET_ZONE);

  const grid = paint(d, side);
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const inside =
        x >= QUIET_ZONE && y >= QUIET_ZONE && x < side - QUIET_ZONE && y < side - QUIET_ZONE;
      const want = inside && modules[y - QUIET_ZONE]![x - QUIET_ZONE]!;
      assert.equal(grid[y]![x], want, `module (${x}, ${y})`);
    }
  }
});

test("the three finder patterns are where a scanner looks for them", () => {
  const m = qrModules(WEBVH);
  const n = m.length;
  // Each finder is a 7x7 dark ring around a light ring around a dark 3x3.
  for (const [ox, oy] of [[0, 0], [n - 7, 0], [0, n - 7]] as const) {
    for (let i = 0; i < 7; i++) {
      assert.ok(m[oy]![ox + i] && m[oy + 6]![ox + i] && m[oy + i]![ox] && m[oy + i]![ox + 6]);
    }
    assert.ok(m[oy + 3]![ox + 3], "finder centre");
    assert.ok(!m[oy + 1]![ox + 1], "finder light ring");
  }
});

test("the code holds the DID's UTF-8 bytes, not the low byte of each UTF-16 unit", () => {
  const text = "did:example:café";
  const utf8 = qrcode(0, "M");
  utf8.addData("did:example:cafÃ©", "Byte");
  utf8.make();
  const want = Array.from({ length: utf8.getModuleCount() }, (_, r) =>
    Array.from({ length: utf8.getModuleCount() }, (_, c) => utf8.isDark(r, c)),
  );
  assert.deepEqual(qrModules(text), want);
});
