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
  server: { port: 5173 },
});
