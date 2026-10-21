// The contact-method registry: which DID methods this reader can take as a
// trigger link's contact (VTI-LNK-102 / 112), how each qualifies, and how its
// document is resolved and verified (VTI-LNK-052).
//
// The policy half of each entry (route, whether its documents list services,
// syntax, the host it names) is `links/trigger-link.ts`'s
// `ContactMethodPolicy`, kept there so the link parser stays pure. This module
// adds the resolver, and its registry is a `ContactMethodTable`: the flow hands
// it to the parser, to `allowsContact` and to resolution, so all three ask the
// same table.
//
// `did:webvh`, `did:web` and `did:scid` (a `did:scid:vh:1` DID URL with
// `src`) are registered, all host-named (route A). A domain-linked method (a
// ledger DID) is added by registering a policy with `route: "domain-linked"`
// and a resolver; the flow then confirms the portal's DIF DID Configuration
// after the person continues (`vtc/domain-linkage.ts`) without any change to
// it.
//
// A did:scid contact is a DID URL — `did:scid:vh:1:<scid>?src=…` — but its
// identity, and its document's `id`, is the bare DID (VTI-KEY-160, 161): the
// document checks below compare against the identity, not the text.

import { resolve as vtiResolve, stripScidSrc } from "@openvtc/vti-didcomm-js";

import {
  BUILTIN_CONTACT_POLICIES,
  SCID_CONTACT_POLICY,
  WEBVH_CONTACT_POLICY,
  WEB_CONTACT_POLICY,
  meetsHostRules,
  type ContactKind,
  type ContactMethodPolicy,
  type ContactMethodTable,
  type ContactRoute,
} from "../links/trigger-link.js";
import { assertResolvableScidHost, assertResolvableWebvhHost } from "./egress-guard.js";
import type { ResolveDidOptions } from "./verify.js";

/** A verified DID document, or why there is none. */
export type ContactDocumentResult =
  | { ok: true; doc: Record<string, unknown> }
  | { ok: false; reason: "did-document-unverified" };

/** A contact method this reader can resolve. */
export interface ContactMethod extends ContactMethodPolicy {
  /**
   * Resolve `did` and verify its document (VTI-LNK-052). Called only for a
   * DID of this method, and — for a host-named method — only once the host it
   * names meets the host rules. Must return a document whose `id` is `did`'s
   * identity (for a did:scid DID URL, the bare DID);
   * may throw, which counts as `did-document-unverified`. `opts.resolveDid`,
   * when given, is the resolver to use (tests inject one).
   */
  resolve?: (did: string, opts: ResolveDidOptions) => Promise<ContactDocumentResult>;
}

/** A DID's method as a {@link ContactKind}, or `undefined` if it is not a DID. */
export function contactKindOf(did: string): ContactKind | undefined {
  if (!did.startsWith("did:")) return undefined;
  const end = did.indexOf(":", 4);
  return end > 4 ? `did:${did.slice(4, end)}` : undefined;
}

/**
 * Resolve through the shared resolver (or `opts.resolveDid`) and require a
 * document whose `id` is the DID asked for. The resolver verifies what the
 * method defines: for `did:webvh` it walks the log, checking the SCID, the
 * hash chain and every entry's proof.
 */
export async function resolveThroughResolver(did: string, opts: ResolveDidOptions): Promise<ContactDocumentResult> {
  const res = (await (opts.resolveDid ?? ((d: string) => vtiResolve(d, {})))(did)) as {
    didDocument?: Record<string, unknown>;
    didResolutionMetadata?: { error?: string };
  };
  if (res?.didResolutionMetadata?.error) return { ok: false, reason: "did-document-unverified" };
  const doc = res?.didDocument;
  if (!doc || doc.id !== didIdentity(did)) return { ok: false, reason: "did-document-unverified" };
  return { ok: true, doc };
}

/** `did:webvh`, route A. A host that is local-only or not a public address is
 *  refused before anything is fetched. */
export const WEBVH_CONTACT_METHOD: ContactMethod = {
  ...WEBVH_CONTACT_POLICY,
  resolve: async (did, opts) => {
    assertResolvableWebvhHost(did);
    return resolveThroughResolver(did, opts);
  },
};

/** `did:scid:vh:1` with `src`, route A. The `src` host is judged like a
 *  did:webvh host before anything is fetched; the resolver verifies the
 *  did:webvh log it names and returns the did:scid's own document. */
export const SCID_CONTACT_METHOD: ContactMethod = {
  ...SCID_CONTACT_POLICY,
  resolve: async (did, opts) => {
    assertResolvableScidHost(did);
    return resolveThroughResolver(did, opts);
  },
};

/** The identity of a DID or DID URL: a did:scid without its `src` locator
 *  (VTI-KEY-160); any other DID as written. Compare identities with this,
 *  never the text a contact or proof arrived as. */
export function didIdentity(did: string): string {
  return stripScidSrc(did);
}

/** `did:web`, route A. */
export const WEB_CONTACT_METHOD: ContactMethod = {
  ...WEB_CONTACT_POLICY,
  resolve: resolveThroughResolver,
};

/**
 * The registry. A {@link ContactMethodTable}, so it can be handed straight to
 * `parseTriggerLink` and `allowsContact`.
 *
 * A method with a route must come with a resolver: one without is refused at
 * registration, rather than accepted by the parser and then failing to
 * resolve.
 */
export class ContactMethodRegistry implements ContactMethodTable {
  private readonly byKind = new Map<string, ContactMethod>();

  constructor(methods: Iterable<ContactMethod> = []) {
    for (const m of methods) this.register(m);
  }

  /** Add or replace a method. Returns the registry, for chaining. */
  register(method: ContactMethod): this {
    if (!/^did:[a-z0-9]+$/.test(method.kind)) throw new Error(`not a DID method: ${method.kind}`);
    if (method.route !== undefined && typeof method.resolve !== "function") {
      throw new Error(`${method.kind}: a method with a route needs a resolver`);
    }
    this.byKind.set(method.kind, method);
    return this;
  }

  policyFor(kind: string): ContactMethod | undefined {
    return this.byKind.get(kind);
  }

  /** The method of `did`, if registered. */
  methodOf(did: string): ContactMethod | undefined {
    const kind = contactKindOf(did);
    return kind ? this.byKind.get(kind) : undefined;
  }

  /** The route a contact `did` qualifies by, or `undefined`. */
  routeOf(did: string): ContactRoute | undefined {
    const m = this.methodOf(did);
    if (m?.route === undefined || !m.listsServices || !m.verified || !m.resolve) return undefined;
    // A host-named contact that names no host (a bare did:scid) has no route.
    if (m.route === "host-named" && m.hostPath && m.hostPath(did) === undefined) return undefined;
    return m.route;
  }

  /** The registered kinds, in registration order. */
  kinds(): ContactKind[] {
    return [...this.byKind.keys()] as ContactKind[];
  }
}

/** A fresh registry holding the built-in methods: `did:webvh`, `did:web` and
 *  `did:scid` (route A, with resolvers), and the policies of `did:key` and `did:peer`,
 *  which no route qualifies. */
export function defaultContactMethods(): ContactMethodRegistry {
  const resolvers: ReadonlyMap<string, ContactMethod> = new Map([
    [WEBVH_CONTACT_METHOD.kind, WEBVH_CONTACT_METHOD],
    [WEB_CONTACT_METHOD.kind, WEB_CONTACT_METHOD],
    [SCID_CONTACT_METHOD.kind, SCID_CONTACT_METHOD],
  ]);
  return new ContactMethodRegistry(BUILTIN_CONTACT_POLICIES.map((p) => resolvers.get(p.kind) ?? p));
}

/** The registry the wallet uses unless a caller passes its own. */
export const CONTACT_METHODS: ContactMethodRegistry = defaultContactMethods();

export interface ResolveContactOptions extends ResolveDidOptions {
  /** Defaults to {@link CONTACT_METHODS}. */
  methods?: ContactMethodRegistry;
}

export type ResolveContactResult =
  | { ok: true; doc: Record<string, unknown>; route: ContactRoute }
  | { ok: false; reason: "unsupported-vid" | "did-document-unverified" };

/**
 * Resolve and verify a contact's DID document through its registered method.
 *
 * - No registered method with a route and a resolver: `unsupported-vid`.
 * - A host-named method whose host fails the host rules (VTI-LNK-060) — where
 *   `did:web:example.com%3A8443` is refused — or any resolution or
 *   verification failure: `did-document-unverified`. Nothing is sent.
 */
export async function resolveContactDocument(did: string, opts: ResolveContactOptions = {}): Promise<ResolveContactResult> {
  const methods = opts.methods ?? CONTACT_METHODS;
  const method = methods.methodOf(did);
  const route = methods.routeOf(did);
  if (!method?.resolve || route === undefined) return { ok: false, reason: "unsupported-vid" };
  const unverified = { ok: false as const, reason: "did-document-unverified" as const };
  if (route === "host-named") {
    const host = method.hostPath?.(did)?.[0];
    if (host === undefined || !meetsHostRules(host)) return unverified;
  }
  try {
    const res = await method.resolve(did, opts.resolveDid ? { resolveDid: opts.resolveDid } : {});
    if (!res.ok || res.doc.id !== didIdentity(did)) return unverified;
    return { ok: true, doc: res.doc, route };
  } catch {
    return unverified;
  }
}
