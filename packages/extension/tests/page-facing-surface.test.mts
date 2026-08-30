// The content script's copy of the protocol, checked against the protocol.
//
// `content.ts` is injected as a *classic* script and cannot `import`, so it
// inlines the runtime-type strings with a "keep these in sync" comment and no
// guard. Two things ride on that hand-sync, and neither fails loudly:
//
//  1. **Origin attestation.** `background.ts` overrides the body's origin with
//     the browser's `sender` origin for types in `PAGE_FACING_RUNTIME_TYPES`,
//     and only those. A page-facing method routed to a type missing from that
//     list would let the calling page name its own origin — and every vault
//     entry, trust record and pin in this wallet is keyed on origin.
//
//  2. **A typo routes nowhere.** A mistyped constant produces a message the
//     background has no branch for, so `sendMessage` resolves `undefined` and
//     the page sees a shapeless failure with nothing pointing here.
//
// Neither is hypothetical: `provider.ts` inlined a second copy of the
// `BridgeMethod` union, and adding a method broke at its call site with an
// error naming every method but the new one. This reads the sources rather
// than importing them, because `content.ts` touches `chrome` at module scope.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const src = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../src/${name}`, import.meta.url)), "utf8");

const content = src("content.ts");
const protocol = src("bridge-protocol.ts");

/** `const NAME = "value"` / `export const NAME = "value" as const` → a map.
 *
 *  The value may sit on the following line: a long declaration is wrapped by
 *  the formatter, and a same-line-only pattern reported the first such constant
 *  as missing from bridge-protocol.ts entirely. A parse gap that reads as a
 *  drift is worse than no test, so `\s*` spans the break. */
function constants(source: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /^(?:export )?const (RUNTIME_[A-Z0-9_]+) =\s*"([^"]+)"/gm;
  for (const m of source.matchAll(re)) out.set(m[1]!, m[2]!);
  return out;
}

/** The identifiers listed in a `const NAME = [ … ] as const` array. */
function arrayMembers(source: string, name: string): string[] {
  const m = new RegExp(`const ${name} = \\[([^\\]]*)\\]`).exec(source);
  assert.ok(m, `${name} not found — this test is reading the wrong shape`);
  return m[1]!
    .split(",")
    .map((s) => s.replace(/\/\/.*$/gm, "").trim())
    .filter(Boolean);
}

/** `method: RUNTIME_CONST,` pairs from the content script's routing table. */
function routingTable(): Map<string, string> {
  const m = /RUNTIME_TYPE_BY_METHOD: Record<BridgeMethod, string> = \{([^}]*)\}/.exec(content);
  assert.ok(m, "RUNTIME_TYPE_BY_METHOD not found — this test is reading the wrong shape");
  const out = new Map<string, string>();
  for (const line of m[1]!.split("\n")) {
    const pair = /^\s*(\w+):\s*(RUNTIME_[A-Z0-9_]+),/.exec(line);
    if (pair) out.set(pair[1]!, pair[2]!);
  }
  return out;
}

const contentConsts = constants(content);
const protocolConsts = constants(protocol);
const table = routingTable();

test("the routing table is not empty", () => {
  // Every assertion below is vacuously true against an empty table, which is
  // exactly how a regex that stopped matching would pass silently.
  assert.ok(table.size >= 10, `routing table has only ${table.size} entries`);
  assert.ok(contentConsts.size >= 10, `parsed only ${contentConsts.size} constants`);
});

test("every constant the content script inlines matches bridge-protocol", () => {
  for (const [name, value] of contentConsts) {
    const canonical = protocolConsts.get(name);
    assert.ok(canonical, `content.ts declares ${name}, which bridge-protocol.ts does not`);
    assert.equal(
      value,
      canonical,
      `${name} has drifted: content.ts says "${value}", bridge-protocol.ts says "${canonical}"`,
    );
  }
});

test("every page-facing method routes to an origin-attested type", () => {
  const pageFacing = new Set(arrayMembers(protocol, "PAGE_FACING_RUNTIME_TYPES"));
  for (const [method, constName] of table) {
    assert.ok(
      pageFacing.has(constName),
      `window.vtaWallet.${method}() routes to ${constName}, which is absent from ` +
        `PAGE_FACING_RUNTIME_TYPES — the background would take that call's origin ` +
        `from the page's own message body instead of from the browser`,
    );
  }
});

test("every method in the BridgeMethod union has a route", () => {
  const union = /export type BridgeMethod =([\s\S]*?);/.exec(protocol);
  assert.ok(union, "BridgeMethod union not found");
  const methods = [...union[1]!.matchAll(/"(\w+)"/g)].map((m) => m[1]!);
  assert.ok(methods.length >= 10, `parsed only ${methods.length} methods`);
  for (const method of methods) {
    assert.ok(table.has(method), `BridgeMethod "${method}" has no entry in RUNTIME_TYPE_BY_METHOD`);
  }
});
