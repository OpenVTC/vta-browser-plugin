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
    rollupOptions: {
      input: {
        popup: resolve(__dirname, "popup.html"),
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
