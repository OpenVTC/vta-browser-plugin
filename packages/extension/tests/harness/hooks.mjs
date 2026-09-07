// Module hooks that let `node --test` import the console's `.tsx` sources.
//
// Node strips types from `.ts` and `.mts` on its own, which is why every
// testable module in this package is plain `.ts` — `profile-entries.ts`,
// `identity-graph.ts`, `persona-flow.ts`. Node cannot strip JSX, so the
// components themselves were untestable, and every bug that reached the live
// console today lived in exactly that gap: a render loop, a form that opened
// empty, a selection the form ignored. Each is invisible to a type checker and
// obvious within a second of rendering.
//
// Two hooks, and the second exists because of how this repo writes imports.
//
//   **resolve** — the sources import `./persona-editors.js` for a file that is
//   `persona-editors.tsx` on disk (TypeScript's `Bundler` resolution, which the
//   bundler honours and Node does not). Existing tests sidestepped it by
//   importing `../src/.../thing.ts` with the real extension; a component cannot,
//   because its own imports are written the other way. So a `.js` specifier
//   that does not exist is retried as `.tsx` and then `.ts`.
//
//   **load** — `.tsx` goes through esbuild, which the build already depends on
//   and which strips types and JSX in one pass. Not `typescript`: this repo is
//   on TypeScript 7, whose JS API is the native port's small surface —
//   `transpileModule` and the `JsxEmit` enum are simply not on it, and a hook
//   written against the 5.x compiler API fails at load with an undefined enum
//   rather than anything that names the cause.
//
// Deliberately NOT a general test bundler. It resolves and transforms; it does
// not bundle, mock, or rewrite anything else. A test that needs an agent stubs
// the agent (`tests/harness/dom.mjs`), rather than this file inventing a module
// graph the real build never has.

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

// Required rather than imported: esbuild is CJS, and the sync transform is what
// keeps this hook simple — no service to start on a loader thread.
const esbuild = createRequire(import.meta.url)("esbuild");

/** `./x.js` → `./x.tsx` → `./x.ts`, when the `.js` is not on disk. */
export async function resolve(specifier, context, nextResolve) {
  if (specifier.endsWith(".js") && (specifier.startsWith(".") || specifier.startsWith("/"))) {
    const base = context.parentURL ?? pathToFileURL(`${process.cwd()}/`).href;
    const asJs = new URL(specifier, base);
    if (!existsSync(fileURLToPath(asJs))) {
      for (const ext of [".tsx", ".ts"]) {
        const candidate = new URL(specifier.slice(0, -3) + ext, base);
        if (existsSync(fileURLToPath(candidate))) {
          // No `format` here on purpose. Node classifies a `.ts` in a
          // `type: module` package as `module-typescript` and strips its types
          // itself; declaring `module` overrides that, and the file arrives at
          // the runtime with `export interface` still in it.
          return { url: candidate.href, shortCircuit: true };
        }
      }
    }
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (!url.endsWith(".tsx")) return nextLoad(url, context);
  const path = fileURLToPath(url);
  const source = await readFile(path, "utf8");
  const { code } = esbuild.transformSync(source, {
    loader: "tsx",
    // The automatic runtime, matching `tsconfig.base.json`'s `jsx: react-jsx`,
    // so a component needs no React import here that it does not need there.
    jsx: "automatic",
    target: "es2022",
    format: "esm",
    sourcefile: path,
  });
  return { format: "module", source: code, shortCircuit: true };
}
