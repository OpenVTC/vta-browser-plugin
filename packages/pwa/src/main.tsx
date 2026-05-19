import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  didcommCrateVersion,
  smokeAuthcryptRoundtrip,
  smokeBuildDidcommEnrollChallenge,
  smokeDidcommVtaTransportRoundtrip,
  smokeWsBridgeDemux,
} from "@pnm/core";
import { App } from "./App.js";
import "./styles.css";

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, retry: 1 } },
});

if (import.meta.env.DEV) {
  (window as unknown as { pnm?: unknown }).pnm = {
    smokeAuthcryptRoundtrip,
    smokeBuildDidcommEnrollChallenge,
    smokeDidcommVtaTransportRoundtrip,
    smokeWsBridgeDemux,
    didcommCrateVersion,
  };
}

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
