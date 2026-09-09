// Persona — the holder's own identity, and the one pane in this console that
// sits ABOVE every trust context.
//
// ## What this pane is for
//
// Everywhere else in the console, a context is the compartment: keys, DIDs,
// memory and app-state all live inside one. The attribute pool and the profiles
// over it do not. There is one person here, with one set of attributes about
// themselves, and the contexts are the places they choose to be known.
//
// So the pane is a picture rather than a filtered list — the identity map in
// `persona-map.tsx`: attributes on top, faces in the middle, contexts below, with the
// one-way line drawn between. And for the holder who has nothing yet, the
// guided setup in `persona-setup.tsx`: an attribute, a face, a context, in the order
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
// On screen: an attribute, a face, a context, a persona that wears a face. See
// `design-docs/persona-vocabulary.md`. In code the spec's names stay where they
// name wire records.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  personaAttributeList,
  personaDisclosureHistory,
  personaFacetList,
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
// `claim-types/list` is `Reach::Any` and describes the agent's vocabulary, not
// the holder — so it lives in the wallet half of the SDK, not the operator half
// the rest of this pane imports.
import { listClaimTypes, unappliedClaimTypes } from "@openvtc/pnm-core/persona";
import { IdentityMap } from "./persona-map.js";
import { AttributeList } from "./persona-list.js";
import { GuidedSetup } from "./persona-setup.js";
import { showsGuide, suggestsWorlds } from "../persona-flow.js";
import { revealAttributeValue, type RevealTarget } from "../reveal-value.js";
import { AttributeEditor, DisclosureHistoryPanel } from "./persona-editors.js";

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

/**
 * Map or list, over the same model.
 *
 * Two words and nothing else. It is not a settings control and must not read
 * as one: the views answer different questions rather than showing more or less
 * of the same answer, so neither is a "detail level" and neither is default in
 * a way the other has to argue with.
 */
/**
 * The three views over one pool.
 *
 * **Worlds is deliberately not one of them.** It was, and it was the wrong
 * shape: a grouping you cannot see beside the things it groups is a list of
 * names, and arranging faces on one screen while looking at them on another is
 * the same act performed twice. Worlds now live on the map, as the bubbles the
 * faces sit inside, and are edited there.
 *
 * **Released is new, and it is a promotion rather than an addition.** The
 * disclosure history used to render below every view as a footer — the single
 * most important privacy answer this product has, "what has left and to whom",
 * reachable only by scrolling past the entire map. It is a peer of the other
 * two because it answers a question of the same size.
 */
export type PersonaView = "map" | "list" | "released";

function ViewToggle({
  view,
  onView,
}: {
  view: PersonaView;
  onView: (v: PersonaView) => void;
}) {
  const item = (v: PersonaView, label: string) => (
    <button
      key={v}
      onClick={() => onView(v)}
      aria-pressed={view === v}
      style={{
        font: "inherit",
        fontSize: "var(--w-t-sm)",
        padding: "5px 12px",
        cursor: "pointer",
        border: `1px solid ${view === v ? "var(--w-accent)" : "var(--w-line)"}`,
        background: view === v ? "var(--w-accent-soft)" : "var(--w-surface)",
        color: view === v ? "var(--w-text)" : "var(--w-muted)",
        borderRadius: "var(--w-r-sm)",
      }}
    >
      {label}
    </button>
  );
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
      {item("map", "Map")}
      {item("list", "List")}
      {item("released", "Released")}
      <span style={{ fontSize: "var(--w-t-xs)", color: "var(--w-faint)" }}>
        {view === "map"
          ? "Select anything to see where it reaches."
          : view === "list"
            ? "Tick several to delete them or add them to a face."
            : "Everything your agent has handed over on your behalf, across every context."}
      </span>
    </div>
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
  // Values are asked for, sensitive ones are not. `includeSensitive` is the
  // half that is not cosmetic (see `reveal-value.ts`): without it the agent
  // answers with the metadata of every `sensitivity: high` attribute and the
  // plaintext of none, which is exactly the state this pane should be in until
  // a person presses *Show* on one of them.
  const attributes = useAsync(
    async () => personaAttributeList(managerSender, { ...parties, includeValues: true }),
    [parties.holder.did, parties.service.did],
  );
  const reveal = useCallback(
    (target: RevealTarget) => revealAttributeValue(managerSender, parties, target),
    [parties],
  );
  const profiles = useAsync(
    async () => personaProfileList(managerSender, parties),
    [parties.holder.did, parties.service.did],
  );
  // Its own load, and its failure is its own. A worlds listing that refused
  // must not blank the map: an arrangement the console could not read is not
  // an absence of arrangement, and drawing one as the other is the same error
  // as an unreadable context reported as an empty one.
  const worlds = useAsync(
    async () => personaFacetList(managerSender, parties),
    [parties.holder.did, parties.service.did],
  );
  const contexts = useAsync(
    async () => loadContexts(parties, records),
    [parties.holder.did, parties.service.did, records.map((r) => r.id).join(" ")],
  );
  // The claim-type table, read from THIS agent rather than compiled in.
  //
  // **It needs a failure branch of its own, and the note here used to say it
  // did not.** The reasoning was that the same agent answers both, so a refusal
  // would take the attributes with it — but they are two different tasks, and an
  // agent that lists a pool perfectly while declining or not implementing
  // `persona/claim-types/list` is exactly what a live wallet hit. Every value
  // then falls to the floor and is masked, which is the right *behaviour* and a
  // silent one: the screen said the table did not declare these tokens, which is
  // a claim about the tokens that nobody had checked.
  const registry = useAsync(
    async () => listClaimTypes(managerSender, parties),
    [parties.holder.did, parties.service.did],
  );
  const history = useAsync(
    async () => personaDisclosureHistory(managerSender, parties),
    [parties.holder.did, parties.service.did],
  );

  const reloadAll = useCallback(() => {
    attributes.reload();
    profiles.reload();
    contexts.reload();
    worlds.reload();
    history.reload();
    // Reloaded with the rest. Left out, a table that failed once stayed failed
    // for the life of the tab, and every value stayed masked with it.
    registry.reload();
  }, [attributes, profiles, contexts, worlds, history, registry]);

  // Guide or map — derived, with two flags that each fix a different way the
  // naive version is wrong.
  //
  // **Derived**, because "no face" is the state the guide exists for, and the
  // holder can arrive at it at any time — most obviously by deleting their last
  // face, which is how anyone explores what this pane does. Deciding once on
  // first load left them on an empty map with no way back but a reload.
  //
  // **`guiding`** holds the guide open once it is showing. Without it, step two
  // creating a face flips straight to the map — past step three, which is the
  // step the whole guide leads to.
  //
  // **`skipped`** is sticky for the session: a holder who said they would build
  // it themselves must not be put back in the guide by deleting their last
  // face, which is a thing they might well do next.
  const [guiding, setGuiding] = useState(false);
  const [skipped, setSkipped] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  /**
   * Which view of the same graph is on screen.
   *
   * Two views, one model — the map answers "what reaches what", the list is the
   * shape you tidy in. Session state rather than stored: a person who came here
   * to delete four numbers wants the list *now*, and would not thank a console
   * that remembered that choice a week later when they came to look at reach.
   */
  const [view, setView] = useState<PersonaView>("map");
  /** The attribute the list asked to edit, by id. Held as an id rather than a
   *  record so a reload cannot leave the editor holding a stale copy. */
  const [editingId, setEditingId] = useState<string | null>(null);
  const showGuide = showsGuide({ faces: profiles.data?.length ?? null, guiding, skipped });
  useEffect(() => {
    if (showGuide) setGuiding(true);
  }, [showGuide]);

  const editing = useMemo(
    () => (attributes.data ?? []).find((a) => a.attributeId === editingId),
    [attributes.data, editingId],
  );

  const graph = useMemo(
    () => buildGraph(attributes.data ?? [], profiles.data ?? [], contexts.data ?? []),
    [attributes.data, profiles.data, contexts.data],
  );

  if (attributes.error) {
    return (
      <div style={{ display: "grid", gap: 12 }}>
        <LoadError what="your attributes" error={attributes.error} />
      </div>
    );
  }
  if (profiles.error && !profiles.data) {
    // Without the faces there is no deciding guide from map, and waiting for
    // data that refused to come would read as a page that never loads.
    return <LoadError what="your faces" error={profiles.error} />;
  }
  if (!attributes.data || !profiles.data) return <Loading what="your identity" />;

  // No face means nothing for the map to draw. A holder with attributes and no face
  // lands on step two; one with nothing on step one.
  if (showGuide) {
    return (
      <GuidedSetup registry={registry.data}
        onReveal={reveal}
        parties={parties}
        authority={authority}
        records={records}
        attributes={attributes.data}
        profiles={profiles.data}
        onChanged={reloadAll}
        onFinished={(outcome) => {
          setBanner(outcome);
          setGuiding(false);
          reloadAll();
        }}
        onSkip={() => {
          setGuiding(false);
          setSkipped(true);
        }}
      />
    );
  }

  return (
    <div style={{ display: "grid", gap: 20, alignContent: "start" }}>
      {profiles.error && <LoadError what="your faces" error={profiles.error} />}
      {contexts.error && <LoadError what="who is known where" error={contexts.error} />}
      {/* What the agent could not apply from its own claim-type file.
          Loud, and at the top, because the failure is otherwise invisible: a
          refused row leaves its token resolving from the core table, so the
          screen looks entirely normal while a tightening the operator believes
          is in force is not. The agent reports its refusals so somebody can be
          told; this is where they are told. */}
      {(() => {
        const unapplied = unappliedClaimTypes(registry.data ?? null);
        if (unapplied.rejected.length === 0 && !unapplied.fileError) return null;
        return (
          <Note tone="danger">
            <div style={{ display: "grid", gap: 6 }}>
              <strong>
                {unapplied.fileError
                  ? "Your agent could not read its claim-type file."
                  : `Your agent could not apply ${unapplied.rejected.length} of its own claim ${
                      unapplied.rejected.length === 1 ? "type" : "types"
                    }.`}
              </strong>
              <span>
                {unapplied.fileError
                  ? "None of the types this deployment declares are in force."
                  : "Those types are treated as the most private kind, as though they had never been declared. Fix or remove the declaration."}
              </span>
              {unapplied.fileError && (
                <span style={{ fontFamily: "var(--w-mono)", fontSize: "var(--w-t-xs)" }}>
                  {unapplied.fileError}
                </span>
              )}
              {unapplied.rejected.map((r) => (
                <span key={r.type} style={{ fontSize: "var(--w-t-sm)" }}>
                  <strong style={{ fontFamily: "var(--w-mono)" }}>{r.type}</strong> — {r.reason}
                </span>
              ))}
            </div>
          </Note>
        );
      })()}
      {registry.error && (
        <Note tone="warn">
          Your agent would not give its claim-type table — {registry.error}. Until it does, every
          value here is hidden as the most private kind, whatever kind it actually is. What you have
          decided for yourself still stands.
        </Note>
      )}
      {/* Worlds are optional and late, so nothing mentions them until the face
          list is starting to be the wall they fix. Below the threshold a world
          would be an arrangement of one thing; the guide deliberately does not
          raise them at all, since a holder finishing setup has one face. */}
      {suggestsWorlds({
        faces: profiles.data?.length ?? null,
        worlds: worlds.data?.length ?? null,
      }) && (
        <Note tone="accent">
          <div style={{ display: "grid", gap: 6 }}>
            <strong>You have {profiles.data.length} faces now.</strong>
            <span>
              Worlds group them by the part of your life they belong to — Work, Home, Play — and
              they are how your agent can tell a link you arranged from one you did not.
            </span>
            <div>
              <button
                onClick={() => setView("map")}
                style={{ border: "none", background: "none", padding: 0, color: "var(--w-accent)", cursor: "pointer", font: "inherit", textDecoration: "underline" }}
              >
                Make one on the map
              </button>
            </div>
          </div>
        </Note>
      )}
      <ViewToggle view={view} onView={setView} />
      {worlds.error && view === "map" && (
        <LoadError what="your worlds" error={worlds.error} />
      )}
      {view === "released" ? (
        <DisclosureHistoryPanel parties={parties} authority={authority} records={records} />
      ) : view === "list" ? (
        editing ? (
          <AttributeEditor
            // Keyed on the record. `AttributeEditor` seeds `useState` from
            // `existing`, which runs on mount and never again — so without this
            // React reuses the instance when the list opens a second attribute
            // and the form shows the first one's value. On a *put*, which
            // replaces, that is not a stale form: it is one attribute's value
            // written over another's.
            key={editing.attributeId}
            registry={registry.data}
            parties={parties}
            authority={authority}
            existing={editing}
            onDone={() => {
              setEditingId(null);
              reloadAll();
            }}
            onCancel={() => setEditingId(null)}
          />
        ) : (
          <AttributeList
            attributes={graph.attributes}
            faces={graph.faces}
            worlds={worlds.data ?? []}
            registry={registry.data}
            parties={parties}
            reveal={reveal}
            onChanged={reloadAll}
            onEdit={(a) => setEditingId(a.id)}
          />
        )
      ) : (
      <IdentityMap registry={registry.data}
        worlds={worlds.data ?? []}
        parties={parties}
        authority={authority}
        graph={graph}
        attributes={attributes.data}
        profiles={profiles.data}
        records={records}
        history={history.data?.disclosures ?? null}
        onReveal={reveal}
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
      )}
    </div>
  );
}
