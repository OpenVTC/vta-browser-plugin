import { defineConfig } from "vite";
import wasm from "vite-plugin-wasm";
import topLevelAwait from "vite-plugin-top-level-await";
import { resolve } from "node:path";

// Separate build for the MV3 service worker. A service worker may not call
// dynamic `import()` (HTML spec; see w3c/ServiceWorker#1356), so the entry
// must be a single self-contained bundle — `inlineDynamicImports` folds all
// code-split chunks (e.g. the shared ed25519 chunk, didwebvh-ts's `fs`
// browser stub) into one file. `emptyOutDir: false` so it doesn't wipe the
// main build's output (popup/confirm/content/provider) that runs first.
export default defineConfig({
  plugins: [wasm(), topLevelAwait()],
  build: {
    outDir: "dist",
    emptyOutDir: false,
    // es2022 — see vite.config.ts: esbuild 0.28 won't down-level the
    // top-level-await plugin's destructuring to vite's default targets.
    target: "es2022",
    rollupOptions: {
      input: { background: resolve(__dirname, "src/background.ts") },
      output: {
        entryFileNames: "background.js",
        inlineDynamicImports: true,
      },
    },
  },
});
