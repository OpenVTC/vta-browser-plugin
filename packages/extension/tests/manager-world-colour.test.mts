// The eight colours a world may wear, checked against the three that mean
// something.
//
// `manager-theme.css` sets the rule that `--w-ok` / `--w-warn` / `--w-danger`
// are the only colours carrying meaning. A world colour is the first
// categorical set in this console chosen by a *person*, and that is what makes
// it worth asserting rather than eyeballing: a holder who names a world "Work"
// and picks something close to `--w-danger` would have every card in it reading
// as an alarm, with nothing on screen to explain why and nobody to blame but a
// palette somebody once approved by looking at it.
//
// So the distance is computed, in both themes, from the values the stylesheet
// actually ships — not from a copy of them kept here, which would pass forever
// after someone edited the CSS.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { WORLD_COLOURS, worldHue, worldColourName } from "../src/manager/world-colour.ts";

const css = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../src/${name}`, import.meta.url)), "utf8");

const MANAGER = css("manager-theme.css");
const BASE = css("theme.css");

/** Every `--token: #hex;` in a stylesheet, as a list of (token, hex, blockIndex).
 *  The block index separates the light `:root` from the dark media query, so a
 *  light world colour is never compared against a dark semantic one. */
function declarations(text: string): { token: string; hex: string; dark: boolean }[] {
  const darkAt = text.indexOf("@media (prefers-color-scheme: dark)");
  const out: { token: string; hex: string; dark: boolean }[] = [];
  const re = /(--[a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{6})\s*;/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push({ token: m[1]!, hex: m[2]!.toLowerCase(), dark: darkAt >= 0 && m.index > darkAt });
  }
  return out;
}

function rgb(hex: string): [number, number, number] {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

/** Perceptual-ish distance. Not a true ΔE — the redmean approximation, which is
 *  well behaved for exactly this question (is this obviously a different colour)
 *  and needs no colour library in a test that must run in plain Node. */
function distance(a: string, b: string): number {
  const [r1, g1, b1] = rgb(a);
  const [r2, g2, b2] = rgb(b);
  const rmean = (r1 + r2) / 2;
  const dr = r1 - r2;
  const dg = g1 - g2;
  const db = b1 - b2;
  return Math.sqrt(
    (2 + rmean / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rmean) / 256) * db * db,
  );
}

/**
 * How far a world colour must sit from a semantic one.
 *
 * Chosen by measuring the closest legitimate pair in the shipped palette and
 * leaving headroom, rather than picked as a round number: the point is to catch
 * a *new* colour drifting into the semantic channel, so the threshold has to be
 * tight enough to fire before a person would notice and loose enough not to
 * fire on the palette as approved.
 */
const MIN_DISTANCE = 60;

const SEMANTIC = ["--w-ok", "--w-warn", "--w-danger"];

test("every world colour is defined in both themes", () => {
  const decls = declarations(MANAGER);
  for (const colour of WORLD_COLOURS) {
    const token = `--m-world-${colour}`;
    assert.ok(
      decls.some((d) => d.token === token && !d.dark),
      `${token} has no light-theme value`,
    );
    assert.ok(
      decls.some((d) => d.token === token && d.dark),
      `${token} has no dark-theme value — it would inherit the light one on a dark ground`,
    );
  }
});

test("no world colour is near a colour that means something", () => {
  // The assertion the palette exists for. Run per theme, because a light world
  // colour sitting far from the light danger red says nothing about the dark
  // pair, and both ship.
  const worlds = declarations(MANAGER).filter((d) => d.token.startsWith("--m-world-"));
  const semantic = declarations(BASE).filter((d) => SEMANTIC.includes(d.token));
  assert.ok(semantic.length >= 6, "the semantic three were not found in both themes");

  for (const w of worlds) {
    for (const s of semantic) {
      if (w.dark !== s.dark) continue;
      const d = distance(w.hex, s.hex);
      assert.ok(
        d >= MIN_DISTANCE,
        `${w.token} (${w.hex}) is ${d.toFixed(1)} from ${s.token} (${s.hex}) in the ` +
          `${w.dark ? "dark" : "light"} theme — a holder picking it would have every card ` +
          `in that world read as ${s.token.replace("--w-", "")}`,
      );
    }
  }
});

test("the picker offers exactly what the wire accepts", () => {
  // `WORLD_COLOURS` is typed against the generated union, so a ninth colour
  // published in the specification is a compile error rather than an option
  // silently missing from the picker. This asserts the count so a *removal*
  // is caught too.
  assert.equal(WORLD_COLOURS.length, 8);
  assert.equal(new Set(WORLD_COLOURS).size, 8, "a colour is offered twice");
});

test("a hue is a token reference, never a value", () => {
  // A component reaching for a hex would be correct in exactly one theme.
  for (const colour of WORLD_COLOURS) {
    assert.equal(worldHue(colour), `var(--m-world-${colour})`);
  }
});

test("every colour has a word, and none of the words carry a meaning", () => {
  // A swatch alone is not a choice anyone can make with a screen reader. The
  // words name a colour and must not acquire connotations — "danger red" in a
  // picker would reintroduce the exact confusion the palette prevents.
  const banned = /danger|warn|error|success|ok\b|alert|caution/i;
  for (const colour of WORLD_COLOURS) {
    const name = worldColourName(colour);
    assert.ok(name.length > 0, `${colour} has no word`);
    assert.doesNotMatch(name, banned, `"${name}" gives a colour a meaning it must not have`);
  }
});
