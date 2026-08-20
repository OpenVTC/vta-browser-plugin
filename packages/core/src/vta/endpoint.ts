// Trust-Task endpoint discovery.
//
// The HTTPS binding fixes the request path at `/trust-tasks` but, until
// binding 0.2, never said what that path was relative to. Two conformant
// implementations therefore composed the URL differently — one appending
// `/api/trust-tasks` to an advertised origin, the other appending
// `/trust-tasks` — and both were right, because there was no contract.
//
// Binding 0.2 §6 settles it: the advertised `serviceEndpoint` is the
// **Trust-Task base**, and the request URL is `<base> + "/trust-tasks"`.
// This module turns a DID document into that base.
//
// Pure and network-free apart from `resolveTrustTaskBase`, which is a thin
// compose over the shared resolver. Out-of-band configuration remains
// conformant (§6.3) — a configured `baseUrl` is a Trust-Task base and needs
// none of this.

import { VtaClientError } from "./errors.js";

/**
 * DID-document service `type` for a Trust-Task HTTPS endpoint
 * (binding 0.2 §6.2).
 *
 * The name states an **interface** — "this party accepts Trust Task documents
 * over the HTTPS binding" — not a product. It is deliberately not `VTARest`:
 * "is a VTA's REST API" and "accepts Trust Tasks" are different claims that
 * merely coincide while every Trust-Task server we run happens to be a VTA.
 * A consumer that conflates them posts Trust Tasks to an endpoint that never
 * agreed to accept them.
 */
export const TRUST_TASK_HTTPS_SERVICE_TYPE = "TrustTaskHTTPS";

/** The path the binding owns. Callers compose `base + TRUST_TASK_PATH`. */
export const TRUST_TASK_PATH = "/trust-tasks";

interface DidService {
  id?: string;
  type?: string | string[];
  serviceEndpoint?: unknown;
}

/** Normalise the several shapes DID Core permits for `serviceEndpoint` down
 *  to a single URI, or `undefined` if none is usable.
 *
 *  A map form (`{ uri }`) is what the DIDComm entries in this codebase use,
 *  so it is accepted here too rather than assuming the string form that the
 *  binding's examples happen to show. */
function endpointUri(raw: unknown): string | undefined {
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const found = endpointUri(item);
      if (found) return found;
    }
    return undefined;
  }
  if (raw && typeof raw === "object") {
    const uri = (raw as { uri?: unknown }).uri;
    if (typeof uri === "string") return uri;
  }
  return undefined;
}

/** `type` may be a string or an array of them (DID Core allows both). */
function hasType(service: DidService, wanted: string): boolean {
  const t = service.type;
  if (typeof t === "string") return t === wanted;
  if (Array.isArray(t)) return t.includes(wanted);
  return false;
}

/**
 * Extract the Trust-Task base from an already-resolved DID document.
 *
 * Matches on the service **`type`** and never on the `id` fragment: the
 * fragment is an arbitrary label chosen by the DID controller (binding 0.2
 * §6.2), so matching it would make interoperability depend on a naming
 * convention nobody agreed. This is the same rule the Rust side applies for
 * `DIDCommMessaging`/`TSPTransport` — a peer naming its entry `#tt` and one
 * naming it `#trust-tasks` are both conformant.
 *
 * Returns `undefined` when the document advertises no such entry, which is
 * not an error: §6.3 keeps out-of-band configuration conformant, so a caller
 * with a configured base should simply use it.
 *
 * A non-`https:` endpoint is rejected rather than returned. The binding is
 * named HTTPS and requires TLS in front of the receiver; silently accepting
 * `http:` would downgrade a transport whose security profile is the reason
 * bearer tokens are safe to carry on it at all.
 */
export function trustTaskBaseFromDocument(doc: unknown): string | undefined {
  if (!doc || typeof doc !== "object") return undefined;
  const services = (doc as { service?: unknown }).service;
  if (!Array.isArray(services)) return undefined;

  for (const entry of services as DidService[]) {
    if (!entry || typeof entry !== "object") continue;
    if (!hasType(entry, TRUST_TASK_HTTPS_SERVICE_TYPE)) continue;

    const uri = endpointUri(entry.serviceEndpoint);
    if (!uri) continue;

    let parsed: URL;
    try {
      parsed = new URL(uri);
    } catch {
      continue;
    }
    if (parsed.protocol !== "https:") {
      throw new VtaClientError(
        "e.client.parse",
        `trust-task endpoint: ${TRUST_TASK_HTTPS_SERVICE_TYPE} endpoint must be https:, got ${parsed.protocol}`,
      );
    }
    // A trailing slash is ignored rather than producing `//trust-tasks`
    // (binding 0.2 §6.1).
    return uri.replace(/\/+$/, "");
  }
  return undefined;
}

/**
 * Compose the dispatcher URL from a Trust-Task base.
 *
 * Kept as a function rather than inlined so the one place that knows the
 * binding owns the suffix is the one place that has to change if it ever
 * moves — which is exactly the drift that produced the `/api/trust-tasks`
 * divergence in the first place.
 */
export function trustTaskUrl(base: string): string {
  return `${base.replace(/\/+$/, "")}${TRUST_TASK_PATH}`;
}
