// Trigger links (VTI spec chapter 7a): the reader's parser and validator.
//
// Dependency-free and pure, so it sits at the bottom of the layering beside
// `util`: the content script, the service worker and any server-side reader can
// all run the identical rule.

export * from "./trigger-link.js";
