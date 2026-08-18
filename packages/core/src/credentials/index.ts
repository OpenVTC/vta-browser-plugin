// Credential issuance and presentation.
//
// Reachable by a wallet as well as a console — unlike `admin/`, this is
// holder-side surface.
//
// The threaded steps of an exchange take a `TrustTaskNotifier` and resolve on
// delivery: they define no response, so there is nothing to await. The
// `pending/*` calls are request/response and take a sender. Which one a
// function takes is the honest statement of what it can tell you.

export * from "./exchange.js";
