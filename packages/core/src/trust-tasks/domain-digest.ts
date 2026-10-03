// A digest that binds one operation: its type and its payload, under a domain
// tag, optionally salted.
//
// The construction is `vti_common::task_consent::domain_digest`, byte for byte:
//
//   SHA-256( domain
//          ‖ u64be(len(type)) ‖ type
//          ‖ u64be(len(JCS(payload))) ‖ JCS(payload)
//          ‖ salt )
//
// as a base58btc multibase multihash (`z` + base58btc(0x12 0x20 ‖ digest)).
// Lengths are **UTF-8 byte** lengths, as Rust's `str::len` is — a JS string's
// `length` counts UTF-16 units and would disagree on the first non-ASCII
// character. The type URI is inside the digest and length-prefixed so two tasks
// sharing a payload shape cannot share a digest, and so the URI/payload
// boundary cannot shift.
//
// The VTC's operation-bound step-up uses it under `vtc/step-up/v1\0`, salted
// with the approve-request's `challenge`: that value is the request's
// `boundTo`, and a step-up approver recomputes it from the operation it is
// shown before signing anything (`auth/step-up/approver/attest/0.1`).
//
// Task consent uses it under `vta/task-consent/v1\0` (the tag predates the
// module's move out of the VTA and is kept on purpose), salted with the
// pending request's `challenge`: that is the `payloadDigest` a
// `task-consent/decision` echoes — the *wire* digest, which a VTC also salts
// per approver, since each approver of an action is issued its own challenge.
// A step-up approver vouching for a decision (`purpose: decision`) recomputes
// it from the action it shows before signing.

import { base58btcEncode, jcsCanonicalize } from "./canonical.js";

/** Domain tag of the VTC's operation-bound step-up digest
 *  (`vtc-service/src/acl/bound_step_up.rs` `DIGEST_DOMAIN`). */
export const VTC_STEP_UP_DOMAIN = "vtc/step-up/v1\0";

/** Domain tag of the task-consent digest
 *  (`vti_common::task_consent::DIGEST_DOMAIN`). Not the step-up tag: a decision
 *  is bound under this one, an operation-bound step-up under
 *  {@link VTC_STEP_UP_DOMAIN}. */
export const TASK_CONSENT_DOMAIN = "vta/task-consent/v1\0";

const MULTIHASH_SHA2_256_32 = [0x12, 0x20] as const;

function u64be(n: number): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(n));
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** `vti_common::task_consent::domain_digest`, in the wallet. */
export async function domainDigest(
  domain: string,
  typeUri: string,
  payload: unknown,
  salt?: string,
): Promise<string> {
  const enc = new TextEncoder();
  const typeBytes = enc.encode(typeUri);
  const canonical = enc.encode(jcsCanonicalize(payload));
  const preimage = concat([
    enc.encode(domain),
    u64be(typeBytes.length),
    typeBytes,
    u64be(canonical.length),
    canonical,
    ...(salt !== undefined ? [enc.encode(salt)] : []),
  ]);
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", preimage as BufferSource),
  );
  return "z" + base58btcEncode(Uint8Array.from([...MULTIHASH_SHA2_256_32, ...digest]));
}

/** The `boundTo` a VTC puts on the step-up it refuses `type`/`payload` with:
 *  the operation's digest salted with the request's `challenge`. */
export function vtcStepUpBoundTo(
  typeUri: string,
  payload: unknown,
  challenge: string,
): Promise<string> {
  return domainDigest(VTC_STEP_UP_DOMAIN, typeUri, payload, challenge);
}

/** The `payloadDigest` a `task-consent/decision` carries:
 *  `vti_common::task_consent::wire_digest` — the task's digest salted with the
 *  `challenge` issued to this approver for it. */
export function taskConsentWireDigest(
  typeUri: string,
  payload: unknown,
  challenge: string,
): Promise<string> {
  return domainDigest(TASK_CONSENT_DOMAIN, typeUri, payload, challenge);
}
