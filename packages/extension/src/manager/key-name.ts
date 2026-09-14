// What a key may be called, and what the console must say before it renames one.
//
// `keys/rename/0.1` says only that `newKeyId` is a non-empty string — the
// agent's gate is narrower than the specification's, and it is the one that
// answers. `vti_common::identifier::validate_identifier` accepts
// `[A-Za-z0-9._-]` up to 64 bytes and rejects everything else, because a key id
// lands as a store key and a caller who can inject `:` or `/` collides with an
// adjacent keyspace.
//
// So this module exists for the same reason `grant-command.ts` does: the rule
// is the agent's, but a console that does not apply it hands the operator a
// refusal instead of a form. It is a **pre-flight, not the decision** — the
// agent still answers, and its refusal is still rendered. Nothing here may
// widen the rule; a value this module accepts and the agent refuses is a
// message the operator can act on, while the reverse is a name the agent would
// have taken and the console pretended it would not.
//
// The shape that made this necessary: every key this agent mints for a DID is
// named by a DID URL (`did:webvh:…#key-0`), which is 86 bytes of `:` and `#` —
// not a name the rename gate can ever accept. The old editor pre-filled the
// field with exactly that, so the only thing pressing Save could produce was
// `new_key_id is 86 bytes; maximum is 64`.

/** The agent's cap, in bytes — `validate_identifier`'s `MAX_IDENTIFIER_LEN`. */
export const MAX_KEY_NAME_BYTES = 64;

const ALLOWED = /^[A-Za-z0-9._-]+$/;

/**
 * Why the agent would refuse this name, or `null` if it would take it.
 *
 * Phrased for the operator rather than as the agent's own wording: the agent
 * reports bytes and a character class, which is an accurate description of a
 * gate and a poor description of what to type instead.
 */
export function keyNameProblem(name: string): string | null {
  if (name === "") return "A name cannot be empty.";
  // The common mistake is pasting the id that is already on screen. It fails
  // the character rule *and* the length one, and neither message says the
  // thing worth knowing: a name is not an address.
  if (name.startsWith("did:")) {
    return "A name is not a DID URL — your agent stores one as a plain label: letters, digits, and . - _ only.";
  }
  if (!ALLOWED.test(name)) {
    return "Your agent accepts letters, digits, and . - _ only.";
  }
  const bytes = new TextEncoder().encode(name).length;
  if (bytes > MAX_KEY_NAME_BYTES) {
    return `That is ${bytes} characters; your agent accepts at most ${MAX_KEY_NAME_BYTES}.`;
  }
  return null;
}

/** Whether a key's current id is one the agent would accept as a new name —
 *  false for every DID-bound key, which is most of them. */
export function isNameable(keyId: string): boolean {
  return keyNameProblem(keyId) === null;
}

/**
 * A name to offer for a key that has none — derived from the DID URL it is
 * addressed by today.
 *
 * `did:webvh:Qm…:webvh.storm.ws:vdr-host#key-0` becomes `vdr-host-key-0`: the
 * last path segment, which is what a person calls that identity, and the
 * fragment, which is what distinguishes its keys from each other. Offered as a
 * *placeholder* rather than a value — a pre-filled suggestion is one press away
 * from a rename nobody chose, and a rename detaches the key from the document
 * that names it.
 *
 * Returns `""` when nothing usable survives, which the caller must treat as
 * "no suggestion" rather than as a name.
 */
export function suggestKeyName(keyId: string): string {
  const hash = keyId.indexOf("#");
  const address = hash === -1 ? keyId : keyId.slice(0, hash);
  const fragment = hash === -1 ? "" : keyId.slice(hash + 1);
  const tail = address.split(":").filter(Boolean).pop() ?? "";
  const joined = [tail, fragment].filter(Boolean).join("-");
  const cleaned = joined
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "");
  // Cleaned is ASCII, so bytes and characters agree and a slice is safe.
  return cleaned.slice(0, MAX_KEY_NAME_BYTES).replace(/[-._]+$/, "");
}
