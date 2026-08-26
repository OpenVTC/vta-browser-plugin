// Matching an extended error code across the SPEC §4.10 re-casing.
//
// A Trust-Task extended error code is `<namespace>:<localPart>` — e.g.
// `provision/integration:contextRequired`. SPEC §4.10 rule 4 requires the local
// part to be lowerCamelCase, and trustoverip/dtgwg-trust-tasks-tf#279 re-cased
// ~200 registry declarations to comply (`sealed_secret_invalid` ->
// `sealedSecretInvalid`). Only the local part moved; the namespace is unchanged.
//
// **This package is on the matching side of that wire, never the declaring
// side.** It reads codes an agent sends it. It also ships into browsers and
// updates on the Chrome Web Store's schedule, not the agent's, so at any moment
// it is talking to agents on both sides of the rename — a wallet installed
// today will still be running against a months-old VTA next year, and a wallet
// that has not auto-updated will meet a VTA that took #279 this morning.
//
// So a swap to the new spelling and a refusal to move are the same bug pointed
// in opposite directions: each breaks silently against exactly one half of the
// deployed fleet, and an equality that quietly goes false does not raise an
// error — it just stops taking the branch that was the entire reason to look at
// the code. Accepting both is the only spelling-independent option, and it is
// what #124 already established for wire *field* names on the read path.
//
// TODO: drop the snake_case arm once every VTA this wallet can reach emits the
// #279 spelling — i.e. once the wallet's minimum supported vta-service floor is
// at or above the release that carries the re-cased codes, the way #125 made
// 0.18.0 a hard floor for the dispatcher path. Until a floor is *declared*, an
// old agent is still a supported peer and the fold has to stay.

/**
 * The pre-#279 snake_case spelling of a canonical lowerCamelCase code.
 *
 * Only the local part after the first `:` is transformed; the namespace is
 * returned verbatim, because #279 did not touch it. A code with no `:` is
 * treated as all local part, so this is still meaningful for a bare token.
 */
export function trustTaskCodeSnakeCase(canonical: string): string {
  const colon = canonical.indexOf(":");
  const namespace = colon === -1 ? "" : canonical.slice(0, colon + 1);
  const local = colon === -1 ? canonical : canonical.slice(colon + 1);
  return namespace + local.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

/**
 * Whether an error code received from an agent is `canonical`, in either the
 * post-#279 lowerCamelCase spelling or the pre-#279 snake_case one.
 *
 * `canonical` is always given in the **registry's current** spelling — the
 * camelCase one. That direction matters: it keeps the call sites reading as the
 * code the registry declares today, and confines the compatibility to here, so
 * removing the fold later is one edit rather than a sweep.
 *
 * ```ts
 * matchesTrustTaskCode(res.code, "provision/integration:contextRequired");
 * // true for "provision/integration:contextRequired"
 * // true for "provision/integration:context_required"
 * ```
 *
 * Note this is deliberately *not* a general case-insensitive compare. Two codes
 * that differ by more than the §4.10 re-casing are two different codes, and
 * folding them would turn a rename into a collision.
 */
export function matchesTrustTaskCode(
  actual: string | null | undefined,
  canonical: string,
): boolean {
  if (typeof actual !== "string" || actual.length === 0) return false;
  return actual === canonical || actual === trustTaskCodeSnakeCase(canonical);
}
