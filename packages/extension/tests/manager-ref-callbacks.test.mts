// A `ref` callback must not set state or call a prop.
//
// ## The bug this exists for
//
// The guided setup showed a live "what a stranger would receive" card beside
// the face editor. Rather than ask the editor for its selection, it wrapped the
// editor in a div and scraped the checkboxes out of the DOM from a `ref`
// callback:
//
//     <div ref={(el) => { if (el) read(el); }}>   // read() called onTick()
//
// React invokes a ref callback on every commit whose ref identity changed — and
// an inline arrow is a new identity every render. So the scrape called the
// parent's setter, the parent re-rendered, the ref was re-invoked, and it
// scraped again. `Minified React error #185`, a blank pane, and nothing in the
// message naming a preview card as the cause.
//
// The fix was not a smarter ref. It was to stop reading the DOM: `ProfileEditor`
// now reports its own selection through an `onPreview` prop, from an effect keyed
// on the selection rather than on the callback.
//
// ## The rule
//
// A `ref` callback may record the node (`ref.current = el`, a map insert). It
// may not call a state setter or a prop callback — that is a render-loop with
// no symptom other than a blank screen.
//
// Source-level, because the failure needs a real React commit loop to reproduce
// and there is no renderer in this suite. That is the same reason it was not
// caught before shipping.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../src/manager", import.meta.url));

const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : [],
  );

/** Every `ref={…}` attribute expression in `src`, brace-balanced. */
function refExpressions(src: string): string[] {
  const out: string[] = [];
  const marker = /\bref=\{/g;
  let m: RegExpExecArray | null;
  while ((m = marker.exec(src)) !== null) {
    let depth = 1;
    let i = m.index + m[0].length;
    while (i < src.length && depth > 0) {
      if (src[i] === "{") depth += 1;
      else if (src[i] === "}") depth -= 1;
      i += 1;
    }
    out.push(src.slice(m.index, i));
  }
  return out;
}

/** A call that reaches outside the ref: a state setter, or a prop callback. */
const ESCAPES = /\b(set[A-Z]\w*|on[A-Z]\w*)\s*\(/;

test("the sweep reads real files and the pattern matches the shape it bans", () => {
  const found = files(ROOT);
  assert.ok(found.length > 15, `found only ${found.length} console sources — the path is stale`);

  // The exact shape that shipped, so this cannot pass by matching nothing.
  const shipped = `<div ref={(el) => { if (el) read(el); onTick(ids, name); }}>`;
  assert.equal(refExpressions(shipped).length, 1, "the extractor does not find a ref attribute");
  assert.match(refExpressions(shipped)[0]!, ESCAPES);
  assert.match(`ref={(el) => { setBoxes(el); }}`, /./);
  assert.ok(ESCAPES.test(`ref={(el) => setOpen(true)}`), "a state setter in a ref must match");

  // …and the legitimate shapes must not.
  assert.ok(!ESCAPES.test(`ref={register("fact:" + id)}`), "a registration helper is fine");
  assert.ok(!ESCAPES.test(`ref={stage}`), "an object ref is fine");
  assert.ok(
    !ESCAPES.test(`ref={(el) => { if (el) nodes.current.set(id, el); }}`),
    "recording the node is the thing a ref is for",
  );
});

test("no ref callback in the console sets state or calls a prop", () => {
  const offenders: string[] = [];
  for (const file of files(ROOT)) {
    for (const expr of refExpressions(readFileSync(file, "utf8"))) {
      if (ESCAPES.test(expr)) {
        offenders.push(`${file.slice(ROOT.length + 1)}: ${expr.replace(/\s+/g, " ").slice(0, 90)}`);
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `these call a setter or a prop from a ref callback:\n  ${offenders.join("\n  ")}\n\n` +
      `React re-invokes a ref callback on every commit whose ref identity changed, and an ` +
      `inline arrow is a new identity every render — so the call sets state, the state ` +
      `re-renders, and the ref fires again. It surfaces as React error #185 and a blank ` +
      `pane, with nothing pointing at the ref. Have the child report through a prop from an ` +
      `effect keyed on the value, not on the callback.`,
  );
});
