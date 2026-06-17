import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import wasm from "vite-plugin-wasm";
import topLevelAwait from "vite-plugin-top-level-await";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    wasm(),
    topLevelAwait(),
    VitePWA({
      registerType: "autoUpdate",
      manifest: {
        name: "PNM Browser Wallet",
        short_name: "PNM",
        description:
          "Bridge between WebAuthn passkeys and VTA-managed DIDs.",
        theme_color: "#0f172a",
        background_color: "#0f172a",
        display: "standalone",
        start_url: "/",
        icons: [],
      },
    }),
  ],
  // es2022 — see packages/extension/vite.config.ts: esbuild 0.28 won't
  // down-level the top-level-await plugin's destructuring to vite's default
  // low targets (chrome87/es2020).
  build: { target: "es2022" },
  server: { port: 5173 },
});
