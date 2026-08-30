// A `TaskSigner` whose key lives at the VTA.
//
// A per-site persona's signing key is generated at the agent and never leaves
// it — that is the security property the whole persona design rests on, and it
// is why the browser cannot put a proof on a document issued by one. So it
// asks: `vault/sign-trust-task/0.2` canonicalises and signs the envelope with
// the entry's key and hands it back.
//
// From the channel's side this is indistinguishable from a local key, which is
// the point of `TaskSigner`. From the RP's side it is indistinguishable too: it
// verifies a Data Integrity proof against the issuer's DID document and never
// learns where the bytes were produced.
//
// ## The signing channel is not the channel being signed for
//
// `vaultSignTrustTask` is itself a Trust Task, sent to the **VTA** over the
// wallet's own holder-signed session. The document it signs is bound for a
// **relying party** over a different channel. Passing the RP channel here would
// send a vault task to a party that has no vault — and there is no recursion in
// the arrangement that is correct, because the VTA channel signs locally.

import type { TrustTaskSender } from "../vta/channel.js";
import type { RemoteDidcommEndpoint } from "../vta/didcomm.js";
import type { TaskSigner } from "../vta/trust-task.js";
import type { Identity } from "../didcomm/index.js";

import { vaultSignTrustTask } from "./sign-trust-task.js";

export interface VaultTaskSignerOptions {
  /** Channel to the **VTA** — not to the party the signed document is for. */
  session: TrustTaskSender;
  /** The wallet's holder identity: the issuer of the `vault/sign-trust-task`
   *  request itself, which the VTA authenticates in the ordinary way. */
  holder: Identity;
  /** The VTA's endpoint — the request's `recipient`. */
  service: RemoteDidcommEndpoint;
  /** The vault entry holding the persona's key. */
  entryId: string;
  /** The persona DID the proof will verify under. Read from the entry's
   *  `principalDid`, never assumed: it is maintainer-derived, and an entry
   *  rotated at the VTA signs as something the wallet never chose. */
  did: string;
}

/**
 * Sign outbound documents as a vault entry's persona.
 *
 * The VTA refuses with `envelope_issuer_mismatch` when the envelope's `issuer`
 * is not the entry's `principalDid`, so `did` and the envelope must already
 * agree — `signOutboundTask` checks that before calling this, which turns a
 * remote refusal into a local error naming both DIDs.
 */
export function vaultTaskSigner(opts: VaultTaskSignerOptions): TaskSigner {
  return {
    did: opts.did,
    sign: async (envelope) => {
      const { signedEnvelope } = await vaultSignTrustTask(opts.session, {
        holder: opts.holder,
        service: opts.service,
        entryId: opts.entryId,
        unsignedEnvelope: envelope as unknown as Record<string, unknown>,
      });
      const proof = (signedEnvelope as { proof?: unknown }).proof;
      if (!proof) {
        // The VTA answered without putting a proof on it. Returning quietly
        // would send an unsigned document the RP refuses as `proofRequired`,
        // with nothing pointing at the step that dropped it.
        throw new Error(
          `vault/sign-trust-task: the VTA returned an envelope with no proof for ${opts.did}`,
        );
      }
      // Mutate in place: `signOutboundTask` returns void because every channel
      // sends the envelope it already holds, so a signer that returned a new
      // object would have its signature silently discarded.
      (envelope as { proof?: unknown }).proof = proof;
    },
  };
}
