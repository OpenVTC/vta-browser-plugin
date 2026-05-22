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
        background: resolve(__dirname, "src/background.ts"),
        content: resolve(__dirname, "src/content.ts"),
        provider: resolve(__dirname, "src/provider.ts"),
      },
      output: {
        // Fixed names for the files the manifest references by path.
        // `content.js` is injected as a classic content script and
        // `provider.js` as a page-world script, so both must be
        // self-contained (no shared-chunk `import`s) — see `manualChunks`.
        entryFileNames: (chunk) =>
          chunk.name === "background"
            ? "background.js"
            : chunk.name === "content"
              ? "content.js"
              : chunk.name === "provider"
                ? "provider.js"
                : "assets/[name]-[hash].js",
        // Keep the content/provider entries dependency-free: inline their
        // (tiny) shared `bridge-protocol` constants rather than emitting a
        // shared chunk a classic content script could not `import`.
        manualChunks: undefined,
      },
    },
  },
});
