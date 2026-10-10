import { defineConfig } from "vite";
import { resolve } from "node:path";

// Separate build for the content script, for the same reason the service
// worker has one (vite.config.background.ts): Chrome injects `content.js` as a
// *classic* script, which cannot `import`, so it must be one self-contained
// file. In the main multi-entry build Rollup is free to hoist a module shared
// with the popup or the confirm window into a common chunk and leave an
// `import` behind — harmless there, a dead content script here. Building it
// alone with `codeSplitting: false` makes "one file" structural.
//
// That is what lets the content script import the trigger-link parser from
// `@openvtc/pnm-core/links` rather than carrying a hand-copied second reader
// (which would answer differently from the worker sooner or later).
//
// `emptyOutDir: false` so it does not wipe the main build's output, which runs
// first.
export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: false,
    target: "es2022",
    rollupOptions: {
      input: { content: resolve(__dirname, "src/content.ts") },
      output: {
        entryFileNames: "content.js",
        format: "iife",
        codeSplitting: false,
      },
    },
  },
});
