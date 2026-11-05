// `skeleton()` of Unicode Technical Standard #39 (*Unicode Security Mechanisms*,
// section 4): two strings are confusable when their skeletons are equal.
//
// The algorithm, as the standard states it:
//
//   1. convert the string to NFD;
//   2. remove every Default_Ignorable_Code_Point;
//   3. replace each character by its prototype from `confusables.txt`, where it
//      has one;
//   4. convert the result to NFD again.
//
// The mappings are Unicode's own file, generated whole into
// `confusables-data.ts` by `scripts/sync-confusables.mjs` and checked against
// the published file's SHA-256 — not a selection made here. NFD is the
// runtime's. A skeleton is for comparing only: never shown, and never a name.

import { CONFUSABLES_DATA, CONFUSABLES_VERSION } from "./confusables-data.js";

export { CONFUSABLES_VERSION };

let table: Map<number, string> | undefined;

/** The prototype of each mapped code point, parsed on first use. */
function prototypes(): Map<number, string> {
  if (table !== undefined) return table;
  const map = new Map<number, string>();
  for (const chunk of CONFUSABLES_DATA) {
    for (const entry of chunk.split(",")) {
      const colon = entry.indexOf(":");
      const source = Number.parseInt(entry.slice(0, colon), 16);
      const target = entry
        .slice(colon + 1)
        .split(" ")
        .map((h) => String.fromCodePoint(Number.parseInt(h, 16)))
        .join("");
      map.set(source, target);
    }
  }
  table = map;
  return map;
}

const DEFAULT_IGNORABLE = /\p{Default_Ignorable_Code_Point}/gu;

/** UTS #39 `skeleton(X)`. */
export function skeleton(text: string): string {
  const map = prototypes();
  let out = "";
  for (const ch of text.normalize("NFD").replace(DEFAULT_IGNORABLE, "")) {
    out += map.get(ch.codePointAt(0)!) ?? ch;
  }
  return out.normalize("NFD");
}

/** Whether `a` and `b` are confusable: their skeletons are equal. */
export function confusable(a: string, b: string): boolean {
  return skeleton(a) === skeleton(b);
}
