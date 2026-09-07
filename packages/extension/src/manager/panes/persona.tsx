// Persona — the holder's own identity, and the one pane in this console that
// sits ABOVE every trust context.
//
// ## What this pane is for
//
// Everywhere else in the console, a context is the compartment: keys, DIDs,
// memory and app-state all live inside one. The attribute pool and the profiles
// over it do not. There is one person here, with one set of facts about
// themselves, and the contexts are the places they choose to be known.
//
// So the pane is a picture rather than a filtered list — the identity map in
// `persona-map.tsx`: facts on top, faces in the middle, contexts below, with the
// one-way line drawn between. And for the holder who has nothing yet, the
// guided setup in `persona-setup.tsx`: a fact, a face, a context, in the order
// the model runs. This file loads what both need and decides which to show.
//
// ## The boundary runs through the middle of it
//
// Every task on this page is holder-scoped: the agent gates them on an
// *unscoped holder* credential — `Admin` AND unrestricted scope — and refuses a
// context-scoped administrator exactly as it refuses an application. That is
// why `isUnscopedHolder` and not `hasRole(authority, "admin")`; see its
// docstring for the emptiness trap that makes the two different tests.
//
// The one call that crosses the boundary is `personaBindingSet`, and it crosses
// **downwards**: the agent resolves the profile up here and pushes a
// materialised copy of the values into the context. The context receives
// claims, never a reference, so nothing inside it can address the pool
// afterwards. Nothing on this page reads upwards out of a context, and there is
// no task that would let it.
//
// ## Why the console, and not the wallet
//
// The wallet half of `persona/*` ships in `@openvtc/pnm-core/persona` and is
// deliberately the context-scoped half only. The console holds the credential
// that can author a persona — it administers the agent rather than acting as
// one inside it — which is what makes this pane possible at all, and why the CI
// guard on those ten URIs names `manager.js` as its single exception rather
// than banning them outright.
//
// ## Words
//
// On screen: a fact, a face, a context, a persona that wears a face. See
// `design-docs/persona-vocabulary.md`. In code the spec's names stay where they
// name wire records.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  personaAttributeList,
  personaDisclosureHistory,
  personaProfileList,
} from "@openvtc/pnm-core/admin";
import { getBinding, listBindings } from "@openvtc/pnm-core/persona";
import type { ContextRecord } from "@openvtc/pnm-core";
import { Note } from "../../ui.js";
import { managerSender } from "../sender.js";
import { Loading, LoadError } from "../table.js";
import { useAsync } from "../use-async.js";
import { contextHeading } from "../format.js";
import type { Authority, Parties } from "../use-vta.js";
import { buildGraph, type ContextInput } from "../identity-graph.js";
import { IdentityMap } from "./persona-map.js";
import { GuidedSetup } from "./persona-setup.js";
import { DisclosureHistoryPanel } from "./persona-editors.js";

/**
 * Who is known in each context, with the face they wear resolved to an id.
 *
 * `binding/list` is thin by construction — a name and a count, never contents
 * and never a `profileId` — so drawing an edge from a face to a persona needs
 * one `binding/get` per bound persona. That is the cost of the picture, and it
 * is bounded by how many personas actually wear something, not by the size of
 * the store.
 *
 * One context refusing must not blank the others: a partial picture that says
 * where it is partial is useful; a context that silently reads as "nobody is
 * known here" is the one wrong answer this page must never give.
 */
async function loadContexts(parties: Parties, records: ContextRecord[]): Promise<ContextInput[]> {
  return Promise.all(
    records.map(async (r): Promise<ContextInput> => {
      const label = contextHeading(r, r.id);
      try {
        const listed = await listBindings(managerSender, { ...parties, contextId: r.id });
        const personas = await Promise.all(
          listed.personas.map(async (p) => {
            if (!p.bound) return { did: p.personaDid, faceId: null, claimCount: 0 };
            try {
              const exact = await getBinding(managerSender, { ...parties, contextId: r.id, personaDid: p.personaDid });
              return {
                did: p.personaDid,
                faceId: exact.profileId ?? null,
                faceName: exact.profileName ?? p.profileName,
                claimCount: exact.claimCount ?? p.claimCount ?? 0,
              };
            } catch {
              // Bound, but to a face we could not resolve. Kept as bound with
              // no edge rather than dropped — dropping it would draw a context
              // that holds less than it does.
              return { did: p.personaDid, faceId: null, faceName: p.profileName, claimCount: p.claimCount ?? 0 };
            }
          }),
        );
        return { id: r.id, label, bindings: { ok: true, personas } };
      } catch (e) {
        return { id: r.id, label, bindings: { ok: false, error: e instanceof Error ? e.message : String(e) } };
      }
    }),
  );
}

export function PersonaPane({
  parties,
  authority,
  records,
}: {
  parties: Parties;
  authority: Authority | null;
  /** The contexts the shell already loaded. Shared rather than refetched, so a
   *  binding names a context by the same label the tree does. */
  records: ContextRecord[];
}) {
  // Values are asked for deliberately. This pane is the holder looking at
  // their own pool from a surface holding an unscoped holder credential —
  // the one place where showing them is the job — and a map of types with
  // no values cannot answer "is this the right phone number".
  const attributes = useAsync(
    async () => personaAttributeList(managerSender, { ...parties, includeValues: true }),
    [parties.holder.did, parties.service.did],
  );
  const profiles = useAsync(
    async () => personaProfileList(managerSender, parties),
    [parties.holder.did, parties.service.did],
  );
  const contexts = useAsync(
    async () => loadContexts(parties, records),
    [parties.holder.did, parties.service.did, records.map((r) => r.id).join(" ")],
  );
  const history = useAsync(
    async () => personaDisclosureHistory(managerSender, parties),
    [parties.holder.did, parties.service.did],
  );

  const reloadAll = useCallback(() => {
    attributes.reload();
    profiles.reload();
    contexts.reload();
    history.reload();
  }, [attributes, profiles, contexts, history]);

  // Decided once, when the data first arrives, and changed only by the guide
  // itself. Deriving it from `profiles.length === 0` on every render would
  // switch to the map the instant step two created a face — before step three,
  // which is the step the whole guide leads to.
  const [mode, setMode] = useState<"undecided" | "guide" | "map">("undecided");
  const [banner, setBanner] = useState<string | null>(null);
  useEffect(() => {
    if (mode === "undecided" && profiles.data) setMode(profiles.data.length === 0 ? "guide" : "map");
  }, [mode, profiles.data]);

  const graph = useMemo(
    () => buildGraph(attributes.data ?? [], profiles.data ?? [], contexts.data ?? []),
    [attributes.data, profiles.data, contexts.data],
  );

  if (attributes.error) {
    return (
      <div style={{ display: "grid", gap: 12 }}>
        <LoadError what="your facts" error={attributes.error} />
      </div>
    );
  }
  if (profiles.error && !profiles.data) {
    // Without the faces there is no deciding guide from map, and waiting for
    // data that refused to come would read as a page that never loads.
    return <LoadError what="your faces" error={profiles.error} />;
  }
  if (!attributes.data || !profiles.data) return <Loading what="your identity" />;

  // The first-run rule: no face yet means nothing for the map to draw. A holder
  // with facts and no face lands on step two; one with nothing on step one.
  if (mode === "undecided") return <Loading what="your identity" />;

  if (mode === "guide") {
    return (
      <GuidedSetup
        parties={parties}
        authority={authority}
        records={records}
        attributes={attributes.data}
        profiles={profiles.data}
        onChanged={reloadAll}
        onFinished={(outcome) => {
          setBanner(outcome);
          setMode("map");
          reloadAll();
        }}
        onSkip={() => setMode("map")}
      />
    );
  }

  return (
    <div style={{ display: "grid", gap: 20, alignContent: "start" }}>
      {profiles.error && <LoadError what="your faces" error={profiles.error} />}
      {contexts.error && <LoadError what="who is known where" error={contexts.error} />}
      <IdentityMap
        parties={parties}
        authority={authority}
        graph={graph}
        attributes={attributes.data}
        profiles={profiles.data}
        records={records}
        history={history.data?.disclosures ?? null}
        onChanged={reloadAll}
        banner={
          banner ? (
            <Note tone="accent">
              <div style={{ display: "grid", gap: 6 }}>
                <strong>You're set up.</strong>
                <span>{banner} This is your identity map — select anything to see where it reaches.</span>
                <div>
                  <button
                    onClick={() => setBanner(null)}
                    style={{ border: "none", background: "none", padding: 0, color: "var(--w-accent)", cursor: "pointer", font: "inherit", textDecoration: "underline" }}
                  >
                    Got it
                  </button>
                </div>
              </div>
            </Note>
          ) : undefined
        }
      />
      <DisclosureHistoryPanel parties={parties} authority={authority} records={records} />
    </div>
  );
}
