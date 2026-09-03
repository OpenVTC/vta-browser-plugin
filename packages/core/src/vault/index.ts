export * from "./get.js";
export * from "./list.js";
export * from "./upsert.js";
export * from "./delete.js";
export * from "./release.js";
export * from "./proxy-login.js";
export * from "./sign-trust-task.js";
// The credential vault — the credentials a holder *holds*. Shares this slug
// and the agent's keyspace with the secrets surface above, and is otherwise a
// different store; see the module header.
export * from "./credentials.js";
export * from "./task-signer.js";
export type { VtaAuthInputs } from "../vta/auth.js";
