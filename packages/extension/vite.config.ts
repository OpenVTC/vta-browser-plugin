import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import wasm from "vite-plugin-wasm";
import topLevelAwait from "vite-plugin-top-level-await";
import { resolve } from "node:path";

export default defineConfig({
  plugins: [react(), wasm(), topLevelAwait()],
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
