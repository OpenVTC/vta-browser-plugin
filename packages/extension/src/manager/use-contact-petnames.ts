// The member's own petnames for people, by DID — read from their contacts in
// every context the console shows (`persona/contact/list/1.1`).
//
// A petname is the member's own name for someone, and only the member's agent
// holds it, so a surface that shows an author shows it first: before any name
// the author gives themselves (a member's name in a room, `memberProfile`) and
// before the DID. Reading it tells nobody anything — the agent sends contacts
// to no one.
//
// Silent when a context cannot be listed: a missing petname is the ordinary
// case, and the surface falls back to what it would show without one. Where two
// contexts give one DID different petnames, the first context's stands.

import { useEffect, useState } from "react";
import { listAllAnnotated } from "@openvtc/pnm-core/persona";
import { managerSender } from "./sender.js";
import type { Parties } from "./use-vta.js";

const EMPTY: ReadonlyMap<string, string> = new Map();

export function useContactPetnames(parties: Parties, contextIds: readonly string[]): ReadonlyMap<string, string> {
  const [petnames, setPetnames] = useState<ReadonlyMap<string, string>>(EMPTY);
  const key = contextIds.join("|");

  useEffect(() => {
    let live = true;
    const ids = key === "" ? [] : key.split("|");
    void Promise.all(
      ids.map((contextId) => listAllAnnotated(managerSender, { ...parties, contextId }).catch(() => [])),
    ).then((pages) => {
      if (!live) return;
      const out = new Map<string, string>();
      for (const contacts of pages) {
        for (const contact of contacts) {
          const did = contact.subjectDid;
          const petname = contact.petname;
          if (did && petname && !out.has(did)) out.set(did, petname);
        }
      }
      setPetnames(out);
    });
    return () => {
      live = false;
    };
  }, [parties, key]);

  return petnames;
}
