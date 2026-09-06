// `persona/renderers/list/1.0` — the output formats this agent can produce,
// and what each one DISCARDS.
//
// Worth calling before a preview rather than after. Lossiness is *declared*,
// not discovered: a renderer that drops provenance turns "my employer attested
// this number" into an unattributed number, and the holder is owed that before
// choosing a format, not after a verifier has already been handed one.
//
// Open to any authenticated caller. The response is a constant naming the
// agent's own capabilities — nothing about the holder, and nothing about any
// context — which is why it takes no `contextId` and why a context-scoped
// wallet can ask.

import type { TaskParty, TrustTaskSender } from "../vta/channel.js";

import {
  TYPE_URI as RENDERERS_LIST,
  RESPONSE_TYPE_URI as RENDERERS_LIST_RESPONSE,
  type PersonaRenderersListPayload,
  type PersonaRenderersListResponsePayload,
} from "@openvtc/trust-tasks/persona/renderers/list/1.0/payload";

import { call } from "./call.js";

export type PersonaRenderer =
  PersonaRenderersListResponsePayload["renderers"][number];

export interface ListRenderersParams {
  holder: TaskParty;
  service: TaskParty;
}

/** List the agent's renderers. */
export async function listRenderers(
  sender: TrustTaskSender,
  params: ListRenderersParams,
): Promise<PersonaRenderersListResponsePayload> {
  const payload: PersonaRenderersListPayload = {};
  return call<PersonaRenderersListPayload, PersonaRenderersListResponsePayload>(
    sender,
    params,
    RENDERERS_LIST,
    RENDERERS_LIST_RESPONSE,
    "persona/renderers/list",
    payload,
  );
}

/**
 * What `rendererId` would discard, or `undefined` if the agent does not offer
 * it.
 *
 * `undefined` and `[]` mean different things and a caller must not conflate
 * them: `[]` is a lossless renderer, `undefined` is a renderer this agent
 * cannot produce. Rendering the second as "discards nothing" would tell a
 * holder a format is safe when the disclosure is about to be refused.
 */
export function dropsOf(
  renderers: readonly PersonaRenderer[],
  rendererId: string,
): readonly string[] | undefined {
  return renderers.find((r) => r.id === rendererId)?.drops;
}
