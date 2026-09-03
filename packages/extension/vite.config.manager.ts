import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import wasm from "vite-plugin-wasm";
import topLevelAwait from "vite-plugin-top-level-await";
import { resolve } from "node:path";

// Separate build for the management console — the one surface allowed to import
// `@openvtc/pnm-core/admin`.
//
// That module is operator authority: granting it at an agent, revoking it,
// destroying contexts. CI asserts no admin task URI appears anywhere in `dist/`
// **except** `manager.js`, and this config is what makes that assertion
// structural rather than a convention someone has to remember.
//
// Two properties do the work, and both would be lost by folding this entry into
// `vite.config.ts`:
//
//  - **Its own Rollup graph.** The main build emits popup, options, confirm and
//    offscreen together, and Rollup is free to hoist code they share into a
//    common `assets/*.js` chunk. An admin symbol reaching such a chunk would
//    land in a file the wallet's surfaces load. Building the console alone
//    means there is no other entry to share with.
//  - **`codeSplitting: false`.** One output file, so "which file may contain
//    admin" has a single answer that a `grep` can check. If this option is ever
//    lost the build emits extra chunks and the guard fails loudly — which is
//    the point; the same option protects the service worker for a different
//    reason (see `vite.config.background.ts`).
//
// `emptyOutDir: false` so it does not wipe the main build's output; it runs
// after both other builds, and the manifest assembly that runs in the main
// build has already happened by then.
export default defineConfig({
  plugins: [react(), wasm(), topLevelAwait()],
  build: {
    outDir: "dist",
    emptyOutDir: false,
    // es2022 — see vite.config.ts: esbuild 0.28 won't down-level the
    // top-level-await plugin's destructuring to vite's default targets.
    target: "es2022",
    rollupOptions: {
      input: { manager: resolve(__dirname, "manager.html") },
      output: {
        entryFileNames: "manager.js",
        // Named so the guard can address it, and so a stray second chunk is
        // visible as `assets/*` rather than hiding among the main build's.
        chunkFileNames: "manager-split-[name].js",
        codeSplitting: false,
      },
    },
  },
});
