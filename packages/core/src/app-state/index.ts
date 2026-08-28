// Agent-held application state — `vta/app-state/*`.
//
// Durable key/value records scoped to a VTA context, so a wallet can keep
// something that must be true on every device the holder uses. Distinct from
// `../store`, which is this browser profile's own state and invisible
// everywhere else.

export * from "./records.js";
