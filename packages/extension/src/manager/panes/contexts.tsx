// Contexts — the pane behind the tree.
//
// Reads and writes the same records the tree navigates, so the two are driven
// from one fetch in the shell rather than each holding its own copy: a rename
// that updated the pane but not the tree would leave the operator looking at
// two names for one context and no way to tell which is current.

import { useCallback, useState } from "react";
import {
  contextsCreate,
  contextsUpdate,
  contextsUpdateDid,
  type ContextRecord,
} from "@openvtc/pnm-core";
import { contextDelete, contextPreviewDelete } from "@openvtc/pnm-core/admin";
import { Button, Did, Empty, Note, Panel } from "../../ui.js";
import { LoadError } from "../table.js";
import { c, t, font } from "../../theme.js";
import { managerSender } from "../sender.js";
// `webvhDidList`, not `vtaListDids`. The latter is typed on `Identity` —
// it wants key material — and this console deliberately holds none; that
// type is the guard, not an inconvenience (see CLAUDE.md on `TaskParty`).
import { webvhDidList } from "@openvtc/pnm-core/webvh";
import { useAsync } from "../use-async.js";
import { ConsentRequiredError } from "../carrier.js";
import { Destructive, ConsentCeremony, runMutation } from "../destructive.js";
import { hasRole, type Authority, type Parties } from "../use-vta.js";
import { formatInstant } from "../format.js";
import type { ContextSelection } from "../context-column.js";

const fieldStyle: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  padding: "7px 10px",
  background: c.ground,
  color: c.text,
  border: `1px solid ${c.line}`,
  borderRadius: "var(--w-r-sm)",
  fontSize: t.sm,
};

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span style={{ fontSize: t.xs, color: c.muted, textTransform: "uppercase", letterSpacing: 0.4 }}>
      {children}
    </span>
  );
}

/** What deleting a context would destroy, in the agent's own words. */
interface DeletePreview {
  id: string;
  keys: string[];
  webvhDids: string[];
}

function CreateContext({
  parties,
  parent,
  authority,
  onCreated,
}: {
  parties: Parties;
  parent: ContextSelection;
  authority: Authority | null;
  onCreated: () => void;
}) {
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<ConsentRequiredError | null>(null);

  // `contexts/create` is super-admin at the agent — it also applies a finer
  // check on the parent. Disabled-with-a-reason rather than hidden: an operator
  // who cannot create needs to know that is the rule, not that the console
  // forgot the feature.
  const denied = authority && !hasRole(authority, "admin", "super-admin")
    ? "Creating a context needs the admin role at this agent."
    : null;

  const submit = useCallback(async () => {
    setBusy(true);
    setError(null);
    setPending(null);
    const ok = await runMutation(
      async () => {
        await contextsCreate(managerSender, {
          ...parties,
          id: id.trim(),
          ...(name.trim() ? { name: name.trim() } : {}),
          ...(description.trim() ? { description: description.trim() } : {}),
          ...(parent ? { parent } : {}),
        });
      },
      { onConsent: setPending, onError: setError },
    );
    setBusy(false);
    if (ok) {
      setId("");
      setName("");
      setDescription("");
      onCreated();
    }
  }, [parties, id, name, description, parent, onCreated]);

  return (
    <Panel
      title="New context"
      description={
        parent ? (
          <>
            Nested under <code style={{ fontFamily: font.mono }}>{parent}</code>. A context is a
            sealed compartment: the keys and DIDs inside it are isolated from every other one, so
            a compromise stops at its edge.
          </>
        ) : (
          <>
            Top-level. Select a context in the tree first to nest inside it. A context is a sealed
            compartment: the keys and DIDs inside it are isolated from every other one, so a
            compromise stops at its edge.
          </>
        )
      }
    >
      <div style={{ display: "grid", gap: 10, maxWidth: 520 }}>
        <label style={{ display: "grid", gap: 4 }}>
          <Label>Id {parent ? "(leaf segment)" : ""}</Label>
          <input
            style={fieldStyle}
            value={id}
            onChange={(e) => setId(e.target.value)}
            placeholder={parent ? "payroll" : "work"}
          />
        </label>
        <label style={{ display: "grid", gap: 4 }}>
          <Label>Name (optional)</Label>
          <input style={fieldStyle} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label style={{ display: "grid", gap: 4 }}>
          <Label>Description (optional)</Label>
          <input
            style={fieldStyle}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>

        {error && <Note tone="danger">{error}</Note>}
        {pending && <ConsentCeremony pending={pending} />}

        <div>
          <Button
            kind="primary"
            disabled={busy || !id.trim() || Boolean(denied)}
            {...(denied ? { title: denied } : {})}
            onClick={() => void submit()}
          >
            {busy ? "Creating…" : "Create context"}
          </Button>
        </div>
        {denied && <span style={{ fontSize: t.sm, color: c.muted }}>{denied}</span>}
      </div>
    </Panel>
  );
}

function EditContext({
  parties,
  record,
  authority,
  onChanged,
}: {
  parties: Parties;
  record: ContextRecord;
  authority: Authority | null;
  onChanged: () => void;
}) {
  const [name, setName] = useState(record.name ?? "");
  const [description, setDescription] = useState(record.description ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<ConsentRequiredError | null>(null);

  const denied = authority && !hasRole(authority, "admin", "super-admin", "operator")
    ? "Editing a context needs an administrative role at this agent."
    : null;

  const save = useCallback(async () => {
    setBusy(true);
    setError(null);
    setPending(null);
    const ok = await runMutation(
      async () => {
        // `policy` is deliberately not sent. `contextsUpdate` replaces it whole
        // rather than merging, so writing it from a form that never read it
        // would silently drop every constraint the form does not know about.
        await contextsUpdate(managerSender, {
          ...parties,
          id: record.id,
          name: name.trim(),
          description: description.trim(),
        });
      },
      { onConsent: setPending, onError: setError },
    );
    setBusy(false);
    if (ok) onChanged();
  }, [parties, record.id, name, description, onChanged]);

  const dirty = name !== (record.name ?? "") || description !== (record.description ?? "");

  return (
    <Panel title={record.name || record.id} description={<code style={{ fontFamily: font.mono }}>{record.basePath}</code>}>
      <dl
        style={{
          margin: 0,
          display: "grid",
          gridTemplateColumns: "auto 1fr",
          gap: "6px 18px",
          fontSize: t.sm,
          alignItems: "baseline",
        }}
      >
        <dt style={{ color: c.muted }}>Id</dt>
        <dd style={{ margin: 0, fontFamily: font.mono }}>{record.id}</dd>
        <dt style={{ color: c.muted }}>DID</dt>
        <dd style={{ margin: 0 }}>
          {record.did ? <Did value={record.did} /> : <span style={{ color: c.faint }}>none bound</span>}
        </dd>
        <dt style={{ color: c.muted }}>Created</dt>
        <dd style={{ margin: 0, color: c.muted }}>{formatInstant(record.createdAt)}</dd>
        <dt style={{ color: c.muted }}>Updated</dt>
        <dd style={{ margin: 0, color: c.muted }}>{formatInstant(record.updatedAt)}</dd>
      </dl>

      <div style={{ display: "grid", gap: 10, maxWidth: 520, marginTop: 6 }}>
        <label style={{ display: "grid", gap: 4 }}>
          <Label>Name</Label>
          <input style={fieldStyle} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label style={{ display: "grid", gap: 4 }}>
          <Label>Description</Label>
          <input
            style={fieldStyle}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>

        {error && <Note tone="danger">{error}</Note>}
        {pending && <ConsentCeremony pending={pending} />}

        <div>
          <Button
            disabled={busy || !dirty || Boolean(denied)}
            {...(denied ? { title: denied } : {})}
            onClick={() => void save()}
          >
            {busy ? "Saving…" : "Save changes"}
          </Button>
        </div>
      </div>
    </Panel>
  );
}

function DeleteContext({
  parties,
  record,
  authority,
  onDeleted,
}: {
  parties: Parties;
  record: ContextRecord;
  authority: Authority | null;
  onDeleted: () => void;
}) {
  const denied = authority && !hasRole(authority, "admin", "super-admin")
    ? "Deleting a context needs the admin role at this agent."
    : null;

  return (
    <Panel
      title="Delete this context"
      description="The keys and DIDs a context holds do not come back. Your agent is asked what
        this would destroy before anything is sent."
    >
      <Destructive<DeletePreview>
        label="Delete context"
        disabledReason={denied}
        preview={() => contextPreviewDelete(managerSender, { ...parties, id: record.id })}
        needsForce={(p) => p.keys.length > 0 || p.webvhDids.length > 0}
        forceLabel="Delete anyway, destroying the keys and DIDs listed above"
        renderPreview={(p) => (
          <>
            <strong>
              Deleting {record.name || record.id} is irreversible.
            </strong>
            {p.keys.length === 0 && p.webvhDids.length === 0 ? (
              <span>Your agent reports it holds no keys and no DIDs.</span>
            ) : (
              <>
                {p.keys.length > 0 && (
                  <div>
                    <div style={{ color: c.muted, marginBottom: 3 }}>
                      {p.keys.length} key{p.keys.length === 1 ? "" : "s"} destroyed:
                    </div>
                    <ul style={{ margin: 0, paddingLeft: 18, fontFamily: font.mono, fontSize: t.xs }}>
                      {p.keys.map((k) => (
                        <li key={k}>{k}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {p.webvhDids.length > 0 && (
                  <div>
                    <div style={{ color: c.muted, marginBottom: 3 }}>
                      {p.webvhDids.length} DID{p.webvhDids.length === 1 ? "" : "s"} destroyed:
                    </div>
                    <ul style={{ margin: 0, paddingLeft: 18 }}>
                      {p.webvhDids.map((d) => (
                        <li key={d}>
                          <Did value={d} size={t.xs} />
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </>
            )}
          </>
        )}
        commit={async (force) => {
          await contextDelete(managerSender, { ...parties, id: record.id, force });
        }}
        onDone={onDeleted}
      />
    </Panel>
  );
}


/**
 * Assign, reassign or clear the DID a context acts as.
 *
 * This existed in `pnm-core` and nowhere in the console, which put the
 * operator in an odd spot: deleting a DID that a context depends on fails
 * with the agent's own instruction to `pnm contexts update <ctx> --did
 * <new-did>` — an instruction the console could carry out and did not offer.
 * Being told the fix and handed no way to apply it is worse than not being
 * told.
 *
 * A separate panel from name/description on purpose. Those are labels; this
 * changes which identity the context presents to every counterparty, and the
 * agent refuses to delete a DID while a context still points at it. Same
 * form, same Save button would have made a rename and an identity change look
 * like one decision.
 */
function ContextDid({
  parties,
  record,
  authority,
  onChanged,
}: {
  parties: Parties;
  record: ContextRecord;
  authority: Authority | null;
  onChanged: () => void;
}) {
  const [did, setDid] = useState(record.did ?? "");

  const dids = useAsync(
    () => webvhDidList(managerSender, { ...parties, contextId: record.id }),
    [parties.holder.did, parties.service.did, record.id],
  );

  // The current DID is always offered, even if the agent no longer lists it
  // under this context — otherwise selecting nothing would silently look like
  // a deliberate change.
  const options = Array.from(
    new Set([
      ...(dids.data?.dids ?? []).map((d) => d.did),
      ...(record.did ? [record.did] : []),
    ]),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<ConsentRequiredError | null>(null);

  const denied =
    authority && !hasRole(authority, "admin", "super-admin")
      ? "Changing a context's DID needs the admin role at this agent."
      : null;

  const save = useCallback(async () => {
    setBusy(true);
    setError(null);
    setPending(null);
    const ok = await runMutation(
      async () => {
        await contextsUpdateDid(managerSender, {
          ...parties,
          id: record.id,
          did: did.trim(),
        });
      },
      { onConsent: setPending, onError: setError },
    );
    setBusy(false);
    if (ok) onChanged();
  }, [parties, record.id, did, onChanged]);

  const unchanged = did.trim() === (record.did ?? "");

  return (
    <Panel
      title="Identity"
      description="The DID this context acts as. Counterparties see this one, so changing it changes
        who the context presents itself as — not just what it is called."
    >
      <div style={{ display: "grid", gap: 10 }}>
        {!record.did && (
          <Note tone="accent">
            This context has no DID of its own yet. That is a state, not a fault — it simply has no
            identity to present until one is assigned.
          </Note>
        )}

        {/* A list, not a paste box.
            The console already knows which DIDs exist — asking an operator to
            copy a `did:webvh:Qm…` out of another pane and paste it here made
            them do the lookup by hand, and a mistyped identifier is not
            something they could spot by reading it back.

            Scoped to this context's own DIDs, which is what a context acts as.
            The current value is added to the list even when it is not among
            them, so a DID assigned from elsewhere is never silently dropped
            from the options and replaced by whatever happened to be first. */}
        <label style={{ display: "grid", gap: 4 }}>
          <span style={{ fontSize: t.xs, color: c.muted }}>DID</span>
          <select
            style={{
              boxSizing: "border-box",
              padding: "6px 9px",
              background: c.ground,
              color: c.text,
              border: `1px solid ${c.line}`,
              borderRadius: "var(--w-r-sm)",
              fontSize: t.sm,
              fontFamily: font.mono,
            }}
            value={did}
            onChange={(e) => setDid(e.target.value)}
            disabled={dids.loading && !dids.data}
          >
            <option value="">— none —</option>
            {options.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </label>
        {dids.error && <LoadError what="this context's DIDs" error={dids.error} />}
        {dids.data && options.length === 0 && (
          <span style={{ fontSize: t.xs, color: c.faint }}>
            This context holds no DIDs yet. Create one under <b>DIDs</b> and it will appear here.
          </span>
        )}
        <span style={{ fontSize: t.xs, color: c.faint }}>
          Choosing <b>none</b> leaves the context with no identity of its own.
        </span>

        {error && <Note tone="danger">{error}</Note>}
        {pending && <ConsentCeremony pending={pending} />}

        <div>
          <Button
            kind="primary"
            disabled={busy || unchanged || Boolean(denied)}
            {...(denied ? { title: denied } : {})}
            onClick={() => void save()}
          >
            {busy ? "Saving…" : record.did ? "Reassign DID" : "Assign DID"}
          </Button>
        </div>
        {denied && <span style={{ fontSize: t.sm, color: c.muted }}>{denied}</span>}
      </div>
    </Panel>
  );
}

export function ContextsPane({
  parties,
  authority,
  records,
  selected,
  onChanged,
}: {
  parties: Parties;
  authority: Authority | null;
  records: ContextRecord[];
  selected: ContextSelection;
  onChanged: () => void;
}) {
  const record = selected ? records.find((r) => r.id === selected) : undefined;

  return (
    <div style={{ display: "grid", gap: 16, alignContent: "start" }}>
      {selected && !record && (
        <Empty>
          That context is no longer in your agent's list. It may have been deleted, or your access
          to it revoked.
        </Empty>
      )}

      {record && (
        <>
          {/* `key` is load-bearing, not decoration.
              `EditContext` seeds its `name` and `description` fields with
              `useState(record.name)`, which runs on mount and never again.
              This panel is a single instance that swaps records as the
              operator moves through the tree, so without a key React reuses
              it — and every context showed the FIRST context's name in an
              editable field sitting above the right id and DID. An operator
              pressing Save would have renamed the context they were looking
              at to the name of one they were not.

              Keying on the record's id makes selecting a different context a
              different component, which is what re-runs the initialisers.
              The sibling editors in `keys.tsx` and `access.tsx` use the same
              seeding pattern and are fine, because `Table` renders them per
              row under `rowKey` — the key is already there. */}
          <EditContext
            key={record.id}
            parties={parties}
            record={record}
            authority={authority}
            onChanged={onChanged}
          />
          <ContextDid
            key={`did:${record.id}`}
            parties={parties}
            record={record}
            authority={authority}
            onChanged={onChanged}
          />
          <DeleteContext
            parties={parties}
            record={record}
            authority={authority}
            onDeleted={onChanged}
          />
        </>
      )}

      <CreateContext
        parties={parties}
        parent={selected}
        authority={authority}
        onCreated={onChanged}
      />
    </div>
  );
}
