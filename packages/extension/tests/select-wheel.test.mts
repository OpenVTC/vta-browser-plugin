// Wheel release after a pointer-driven <select> change — see
// src/select-wheel.ts.
//
// The pointer/keyboard split is the whole design: blurring on every `change`
// would fix a mouse annoyance by breaking keyboard selection, which fires
// `change` on every arrow keystroke. These pin both halves.

import test from "node:test";
import assert from "node:assert/strict";
import { releaseSelectAfterPointerChange, type SelectWheelHost } from "../src/select-wheel.ts";

/** A stand-in document that just dispatches to whatever was registered. */
function host() {
  const listeners = new Map<string, ((e: Event) => void)[]>();
  const h: SelectWheelHost = {
    addEventListener(type, listener) {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    removeEventListener(type, listener) {
      listeners.set(type, (listeners.get(type) ?? []).filter((l) => l !== listener));
    },
  };
  const fire = (type: string, target: unknown) => {
    for (const l of listeners.get(type) ?? []) l({ target } as unknown as Event);
  };
  return { h, fire, count: () => [...listeners.values()].flat().length };
}

function select() {
  let blurred = 0;
  return { tagName: "SELECT", blur: () => void blurred++, blurs: () => blurred };
}

test("a pointer-opened select is released once the choice lands", () => {
  const { h, fire } = host();
  releaseSelectAfterPointerChange(h);
  const el = select();
  fire("pointerdown", el);
  fire("change", el);
  assert.equal(el.blurs(), 1);
});

test("a keyboard change keeps focus — blurring would reset tab position", () => {
  const { h, fire } = host();
  releaseSelectAfterPointerChange(h);
  const el = select();
  fire("keydown", el);
  fire("change", el);
  assert.equal(el.blurs(), 0);
});

test("a key pressed after the pointer cancels the pending release", () => {
  const { h, fire } = host();
  releaseSelectAfterPointerChange(h);
  const el = select();
  fire("pointerdown", el);
  fire("keydown", el);
  fire("change", el);
  assert.equal(el.blurs(), 0);
});

test("an abandoned menu leaves nothing armed for the next change", () => {
  const { h, fire } = host();
  releaseSelectAfterPointerChange(h);
  const el = select();
  fire("pointerdown", el);
  fire("pointerdown", { tagName: "DIV" }); // dismissed by clicking elsewhere
  fire("change", el);
  assert.equal(el.blurs(), 0);
});

test("only the select the pointer opened is released", () => {
  const { h, fire } = host();
  releaseSelectAfterPointerChange(h);
  const opened = select();
  const other = select();
  fire("pointerdown", opened);
  fire("change", other);
  assert.equal(other.blurs(), 0);
  assert.equal(opened.blurs(), 0);
});

test("a change on a non-select target is left alone", () => {
  const { h, fire } = host();
  releaseSelectAfterPointerChange(h);
  const input = { tagName: "INPUT", blur: () => assert.fail("blurred an input") };
  fire("pointerdown", input);
  fire("change", input);
});

test("the disposer removes every listener it added", () => {
  const { h, count } = host();
  const dispose = releaseSelectAfterPointerChange(h);
  assert.equal(count(), 3);
  dispose();
  assert.equal(count(), 0);
});
