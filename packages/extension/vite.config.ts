import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import wasm from "vite-plugin-wasm";
import topLevelAwait from "vite-plugin-top-level-await";
import { resolve } from "node:path";
import { writeFileSync } from "node:fs";
// Plain .mjs, and unlisted in tsconfig's `include` (which is `src/**/*`), so
// it is bundled by vite's esbuild config loader and never typechecked.
import { buildManifest } from "./scripts/manifest.mjs";

/**
 * Emit `dist/manifest.json` from `manifest.json` + `package.json`.
 *
 * This runs inside the vite build rather than as a `&&`-chained script step
 * so that `npm run dev` (`vite build --watch`) keeps the manifest in `dist/`
 * on every rebuild. A chained step would run once and then be wiped by the
 * next watch rebuild's `emptyOutDir`, leaving an unloadable extension.
 *
 * `includeKey: true` — this output is what you load unpacked. The Store zip
 * is produced by `scripts/package.mjs` with the key omitted; see
 * `scripts/manifest.mjs` for why the two differ.
 */
function emitManifest() {
  return {
    name: "pnm-emit-manifest",
    writeBundle() {
      const manifest = buildManifest({ includeKey: true });
      writeFileSync(
        resolve(__dirname, "dist/manifest.json"),
        `${JSON.stringify(manifest, null, 2)}\n`,
      );
    },
  };
}

export default defineConfig({
  plugins: [react(), wasm(), topLevelAwait(), emitManifest()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // es2022 (native top-level await) — required since esbuild 0.28 refuses
    // to down-level some destructuring emitted by vite-plugin-top-level-await
    // to vite's default low targets (chrome87/es2020). Safe for an MV3
    // extension, whose runtime is a current Chromium.
    target: "es2022",
    rollupOptions: {
      input: {
        popup: resolve(__dirname, "popup.html"),
        options: resolve(__dirname, "options.html"),
        confirm: resolve(__dirname, "confirm.html"),
        offscreen: resolve(__dirname, "offscreen.html"),
        content: resolve(__dirname, "src/content.ts"),
        provider: resolve(__dirname, "src/provider.ts"),
      },
      output: {
        // Fixed names for the files the manifest references by path.
        // `content.js` is injected as a classic content script and
        // `provider.js` as a page-world script, so both must be
        // self-contained (no shared-chunk `import`s).
        //
        // `background.js` is built separately (vite.config.background.ts)
        // because an MV3 service worker forbids dynamic `import()`, so it
        // must be a single inlined bundle — incompatible with the
        // multi-entry build here.
        entryFileNames: (chunk) =>
          chunk.name === "content"
            ? "content.js"
            : chunk.name === "provider"
              ? "provider.js"
              : "assets/[name]-[hash].js",
        manualChunks: undefined,
      },
    },
  },
});
