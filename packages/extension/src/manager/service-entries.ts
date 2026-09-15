// Extra service entries on a minted DID, as a form rather than as JSON.
//
// `additionalServices` on `vta/webvh/dids/create` is written into the document
// **verbatim**: the agent composes nothing and checks nothing. That is why this
// module exists rather than a textarea. Two facts make a raw editor the wrong
// shape here:
//
//   - A bad entry is not a failed call. It succeeds, and the document that
//     carries it is a log entry, which is append-only — the repair is a further
//     update that supersedes it, never a removal. Whatever is published stays
//     in the history.
//   - The people who reach for this are publishing an endpoint others will
//     dial. A typo in `serviceEndpoint` is a service nobody can reach, and
//     nothing on the wire will say so.
//
// So the console composes the object and this module decides whether it is
// well-formed first. **What it does not do is vouch for the endpoint**: a
// syntactically perfect `https://` URL to a host that serves nothing passes
// every check here, and no client-side check could say otherwise.
//
// A plain module rather than part of the form so a test can reach it.

/** One row of the editor. `key` is local and never published — React needs a
 *  stable identity for a list whose rows are reordered and removed. */
export interface ServiceDraft {
  key: string;
  /** The fragment after `#`, not the whole id: the DID is not known until the
   *  agent mints it, so an operator cannot type a full id here even if they
   *  wanted to. The agent resolves `{DID}` — see `serviceEntry`. */
  fragment: string;
  type: string;
  endpoint: string;
}

export const emptyDraft = (key: string): ServiceDraft => ({
  key,
  fragment: "",
  type: "",
  endpoint: "",
});

/** Whether a row has been touched at all. An untouched row is not an error —
 *  it is the blank one at the bottom of the list. */
export const isBlank = (d: ServiceDraft): boolean =>
  d.fragment.trim() === "" && d.type.trim() === "" && d.endpoint.trim() === "";

/** What is wrong with a row, per field, or an empty object. */
export interface DraftProblems {
  fragment?: string;
  type?: string;
  endpoint?: string;
}

/**
 * Why this entry would not do, field by field.
 *
 * Per-field rather than one message because the form draws each beside its own
 * input: one combined string means the operator fixes the first fault, resends
 * and discovers the second.
 */
export function draftProblems(draft: ServiceDraft, others: ServiceDraft[]): DraftProblems {
  const problems: DraftProblems = {};
  const fragment = draft.fragment.trim();
  const type = draft.type.trim();
  const endpoint = draft.endpoint.trim();

  if (fragment === "") {
    problems.fragment = "Give the entry a name — it becomes the part of its id after “#”.";
  } else if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(fragment)) {
    problems.fragment = "Letters, digits, “.”, “-” and “_”, starting with a letter or digit.";
  } else if (
    others.some((o) => o.key !== draft.key && o.fragment.trim() === fragment)
  ) {
    // Two entries at one id is not a rejection — it is a document with an
    // ambiguous service, and which one a resolver picks is its own business.
    problems.fragment = "Another entry already uses this name, and an id has to be unique.";
  }

  if (type === "") {
    problems.type = "Say what kind of service this is, e.g. LinkedDomains.";
  }

  if (endpoint === "") {
    problems.endpoint = "Give the endpoint others will dial.";
  } else {
    const scheme = endpointProblem(endpoint);
    if (scheme) problems.endpoint = scheme;
  }

  return problems;
}

/**
 * Why an endpoint would not do.
 *
 * `did:` is accepted deliberately — a mediator entry names a DID, not a URL,
 * and refusing one would make this editor unable to express the commonest
 * non-HTTP service there is. `http:` is refused on the same reasoning as
 * `walletNetPolicy`: what is written here is published for other people to
 * dial, and a cleartext endpoint in a DID document is one they will.
 */
export function endpointProblem(endpoint: string): string | null {
  if (endpoint.startsWith("did:")) {
    return endpoint.length > "did:".length ? null : "That is a `did:` prefix with no DID after it.";
  }
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return "That is not a URL. Use https://…, wss://… or a DID.";
  }
  if (url.protocol === "http:" || url.protocol === "ws:") {
    return "Use https:// or wss:// — this endpoint is published for other people to dial.";
  }
  if (url.protocol !== "https:" && url.protocol !== "wss:") {
    return `“${url.protocol}” endpoints are not published from here — use https://, wss:// or a DID.`;
  }
  if (url.username !== "" || url.password !== "") {
    return "Credentials do not belong in a published endpoint.";
  }
  return null;
}

/** Whether every non-blank row is well-formed. Blank rows are ignored, so a
 *  form with one empty row at the bottom is submittable. */
export function draftsReady(drafts: ServiceDraft[]): boolean {
  const filled = drafts.filter((d) => !isBlank(d));
  return filled.every((d) => Object.keys(draftProblems(d, filled)).length === 0);
}

/**
 * One row as the document will carry it.
 *
 * `{DID}` is the ambient placeholder the agent substitutes — the same one a DID
 * template uses for `document.id` — because the DID does not exist until the
 * entry naming it has been written, so nothing on this side can spell the id.
 */
export function serviceEntry(draft: ServiceDraft): Record<string, unknown> {
  return {
    id: `{DID}#${draft.fragment.trim()}`,
    type: draft.type.trim(),
    serviceEndpoint: draft.endpoint.trim(),
  };
}

/** Every filled row, ready for `additionalServices`. */
export function additionalServices(drafts: ServiceDraft[]): Record<string, unknown>[] {
  return drafts.filter((d) => !isBlank(d)).map(serviceEntry);
}
