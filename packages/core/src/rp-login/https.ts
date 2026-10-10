// A relying party's HTTPS Trust Task binding, as a `TrustTaskSender`.
//
// Documents go to `{baseUrl}/trust-tasks`, the endpoint step-up already uses.
// No bearer is sent. The document's proof is the authorisation. That is what
// lets a login run here at all: `auth/challenge` and `auth/authenticate` come
// before there is a session to present.
//
// Two checks make the reply evidence rather than bytes. The request must be
// addressed to `rpDid` (the pinned relying party), and the reply must be
// signed by it and threaded to the request (`decodeTrustTaskHttpReply` with
// `expectedSigner` and `inReplyTo`). The page can choose the base URL, but it
// cannot make the wallet accept an answer from anyone else.

import type { SendOpts, TrustTaskSender } from "../vta/channel.js";
import { VtaClientError } from "../vta/errors.js";
import type { TrustTask } from "../vta/protocol.js";
import { decodeTrustTaskHttpReply } from "../vta/rest-channel.js";
import { asTaskSigner, signOutboundTask, type ChannelSigner } from "../vta/trust-task.js";
import { DEFAULT_FETCH_TIMEOUT_MS, isFetchTimeout, withFetchTimeout } from "../http/timeout-fetch.js";

export interface RpHttpsSenderOptions {
  /** The RP's Trust Task base. Documents are POSTed to `{baseUrl}/trust-tasks`. */
  baseUrl: string;
  /** The RP's DID. Every document must be addressed to it, and every reply
   *  signed by it. */
  rpDid: string;
  /** Signs every outbound document as its `issuer`: the holder's own key, or
   *  a persona whose key lives at the VTA (a `TaskSigner`). */
  signing: ChannelSigner;
  fetch?: typeof fetch;
}

/** Build a sender that carries Trust Tasks to one relying party over HTTPS. */
export function rpHttpsSender(opts: RpHttpsSenderOptions): TrustTaskSender {
  // The channel signs each document for the purpose its type requires
  // (`signOutboundTask`): `authentication` for the RP's operational requests,
  // `auth/authenticate` included. This sender used to force `authentication`
  // itself, because the channels signed `assertionMethod`; they no longer do.
  const signer = asTaskSigner(opts.signing);
  const fetchFn = withFetchTimeout(opts.fetch);
  const url = `${opts.baseUrl.replace(/\/+$/, "")}/trust-tasks`;

  return {
    async send<Res>(envelope: TrustTask<unknown>, sendOpts: SendOpts = {}): Promise<Res> {
      const label = sendOpts.operationLabel ?? envelope.type;
      // This channel is bound to one relying party. A document addressed to
      // another one would be signed for a party this channel never verifies.
      if (envelope.recipient !== opts.rpDid) {
        throw new VtaClientError(
          "e.client.identity",
          `${label}: the document is addressed to ${String(envelope.recipient)}, not the relying party ${opts.rpDid}`,
        );
      }
      await signOutboundTask(envelope, signer);

      let res: Response;
      try {
        res = await fetchFn(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(envelope),
        });
      } catch (err) {
        if (isFetchTimeout(err)) {
          throw new VtaClientError(
            "e.client.timeout",
            `${label}: the relying party did not respond within ${DEFAULT_FETCH_TIMEOUT_MS / 1000}s`,
          );
        }
        throw new VtaClientError("e.client.network", (err as Error).message);
      }
      return decodeTrustTaskHttpReply<Res>(res, {
        ...(sendOpts.expectedResponseType !== undefined
          ? { expectedResponseType: sendOpts.expectedResponseType }
          : {}),
        operationLabel: label,
        expectedSigner: opts.rpDid,
        inReplyTo: envelope,
      });
    },
  };
}
