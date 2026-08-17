/// <reference types="chrome" />

// Resolve the agent names a set of DIDs claim.
//
// One hook rather than a per-screen effect, because every surface that shows a
// DID wants the same thing and the rule is easy to get subtly wrong: a name is
// only shown when the *resolved document* claims it via `alsoKnownAs`. Nothing
// here derives a name from a DID's host or path — see `agent-name.ts`.

import { useEffect, useState } from "react";
import {
  RUNTIME_VERIFY_RP_DID,
  type RuntimeVerifyRpDidResponse,
} from "./bridge-protocol.js";
import { extractAgentNames, type AgentName } from "./agent-name.js";

/**
 * Map of DID → the first agent name its document claims.
 *
 * Absent keys mean "no name" — which covers a document that claims none, a
 * DID that didn't resolve, and a lookup still in flight. Callers fall back to
 * showing the DID, so the three are indistinguishable *and should be*: none of
 * them licenses displaying a name.
 *
 * Resolution failure is deliberately silent. A missing name is the ordinary
 * case, and an error banner for it would train people to ignore banners.
 *
 * @param dids DIDs to resolve. Falsy entries are skipped, so callers can pass
 *   optional fields straight in.
 */
export function useAgentNames(
  dids: readonly (string | undefined)[],
): Record<string, AgentName> {
  const [names, setNames] = useState<Record<string, AgentName>>({});

  // Join into a stable dependency: the array identity changes every render,
  // but its contents rarely do, and re-resolving on every render would put a
  // DID resolution behind each keystroke elsewhere on the page.
  const key = dids.filter(Boolean).join("|");

  useEffect(() => {
    const targets = key.split("|").filter(Boolean);
    if (targets.length === 0) {
      setNames({});
      return;
    }
    let cancelled = false;

    void Promise.all(
      targets.map(async (did): Promise<[string, AgentName] | null> => {
        try {
          const reply = (await chrome.runtime.sendMessage({
            type: RUNTIME_VERIFY_RP_DID,
            did,
          })) as RuntimeVerifyRpDidResponse;
          if (!reply.ok || !reply.result.resolved) return null;
          const name = extractAgentNames(reply.result.alsoKnownAs)[0];
          return name ? [did, name] : null;
        } catch {
          return null;
        }
      }),
    ).then((pairs) => {
      if (cancelled) return;
      setNames(Object.fromEntries(pairs.filter((p): p is [string, AgentName] => p !== null)));
    });

    return () => {
      cancelled = true;
    };
  }, [key]);

  return names;
}
