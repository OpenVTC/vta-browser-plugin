/// <reference types="chrome" />

// The management console's entry point.
//
// A separate bundle from every other extension surface, and the separation is
// load-bearing rather than tidy: `@openvtc/pnm-core/admin` is operator
// authority — granting it, revoking it, destroying contexts — and CI asserts
// that none of it reaches the wallet's own bundles. Its own vite config
// (`vite.config.manager.ts`) with `codeSplitting: false` is what makes that
// assertion structural instead of a promise: Rollup cannot emit a shared chunk
// between this entry and the popup, offscreen or service worker, because it
// does not build them together.
//
// Reached from the popup and options page via `chrome.tabs.create`. Deliberately
// NOT `options_ui` (the wallet's settings are the options page, and this is not
// settings) and deliberately not a `web_accessible_resource` — no page should
// be able to frame or navigate to it.

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ManagerShell } from "./manager/shell.js";
import "./theme.css";
import "./manager-theme.css";

const root = document.getElementById("root");
if (!root) throw new Error("manager.html is missing its #root element");

createRoot(root).render(
  <StrictMode>
    <ManagerShell />
  </StrictMode>,
);
