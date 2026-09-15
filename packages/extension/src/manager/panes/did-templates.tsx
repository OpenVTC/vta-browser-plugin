// DID templates — the shapes this agent stamps DIDs from.
//
// **A template is a document that will be published under someone's identity,
// authored once and then used without being read again.** That is what makes it
// worth a pane and what makes the pane cautious: the operator who writes
// `room-host` is rarely the one who mints from it a month later, and a wrong
// service entry in a template is a wrong service entry in every DID stamped
// after it — each one a log entry, append-only, corrected only by superseding it.
//
// So three things are structural rather than nice to have:
//
//   - **Render before save is offered on every template**, not only on new ones.
//     `didTemplateRender` performs the agent's own substitution and creates
//     nothing, and it is the only way to see what a template means. A local
//     preview would be this console's guess at the agent's renderer.
//   - **Update is a whole-template write, not a patch.** Anything the editor
//     omits is omitted from the stored record, so the editor loads the record
//     and sends it back entire. The same replace semantics the persona editor
//     documents, with the same failure: a save that silently drops what it never
//     read.
//   - **Built-ins are not editable and say so.** `room` and `room-host` ship with
//     the agent and the rooms flow stamps from them. The agent refuses the write;
//     the button refuses first, which is the difference between a disabled
//     control and a refusal after the form was filled in.
//
// Scope handling is in `template-scope.ts` and the reasoning is there — the
// short version is that a name in three namespaces is three templates.

import { useCallback, useMemo, useState } from "react";
import {
  didTemplateCreate,
  didTemplateDelete,
  didTemplateList,
  didTemplateRender,
  didTemplateUpdate,
  type DidTemplate,
  type DidTemplateRecord,
} from "@openvtc/pnm-core/admin";
import { Button, CopyButton, Note, Panel, Pill } from "../../ui.js";
import { c, t, font } from "../../theme.js";
import { managerSender } from "../sender.js";
import { ConsentRequiredError } from "../carrier.js";
import { ConsentCeremony, Destructive, runMutation } from "../destructive.js";
import { Loading, LoadError, Table, type Column } from "../table.js";
import { useAsync } from "../use-async.js";
import { hasRole, type Authority, type Parties } from "../use-vta.js";
import type { ContextSelection } from "../context-column.js";
import {
  isEditable,
  mergeTemplates,
  scopeKey,
  scopeSelector,
  scopeWord,
} from "../template-scope.js";
import { AMBIENT_VARS } from "../template-vars.js";
import { Field, fieldStyle, Label, row } from "./rooms-create-parts.js";

const areaStyle: React.CSSProperties = {
  ...fieldStyle,
  width: "100%",
  fontFamily: font.mono,
  lineHeight: 1.55,
  minHeight: 220,
  resize: "vertical",
};

const pre: React.CSSProperties = {
  margin: 0,
  padding: 11,
  background: c.ground,
  border: `1px solid ${c.line}`,
  borderRadius: "var(--w-r-sm)",
  fontFamily: font.mono,
  fontSize: t.xs,
  lineHeight: 1.55,
  whiteSpace: "pre-wrap",
  wordBreak: "break-all",
  maxHeight: 340,
  overflowY: "auto",
};

/** The editor's own state. Text, not a parsed template: the document is edited
 *  as JSON and a half-typed object is not one. */
interface Draft {
  /** The record being replaced, or `null` for a new template. Carried rather
   *  than re-looked-up by name, because `name` is editable on a new template
   *  and looking one up by the edited value would find the wrong record. */
  original: DidTemplateRecord | null;
  name: string;
  kind: string;
  description: string;
  methods: string;
  requiredVars: string;
  document: string;
  /** Which namespace to write into. For an existing record this is the one it
   *  is already in and is not editable — moving a template between namespaces
   *  is a create and a delete, not an update. */
  contextId: string | undefined;
}

function draftFrom(record: DidTemplateRecord): Draft {
  return {
    original: record,
    name: record.name,
    kind: record.kind,
    description: record.description ?? "",
    methods: (record.methods ?? []).join(", "),
    requiredVars: (record.requiredVars ?? []).join(", "),
    document: JSON.stringify(record.document, null, 2),
    contextId: scopeSelector(record),
  };
}

function blankDraft(contextId: string | undefined): Draft {
  return {
    original: null,
    name: "",
    kind: "",
    description: "",
    methods: "webvh",
    requiredVars: "",
    // Seeded rather than empty, because `document.id` MUST carry `{DID}` and a
    // blank box gives no hint that the id is a placeholder the agent fills in.
    document: JSON.stringify(
      {
        id: "{DID}",
        verificationMethod: [
          {
            id: "{DID}#key-1",
            type: "Multikey",
            controller: "{DID}",
            publicKeyMultibase: "{SIGNING_KEY_MB}",
          },
        ],
        authentication: ["{DID}#key-1"],
        service: [],
      },
      null,
      2,
    ),
    contextId,
  };
}

const list = (text: string): string[] =>
  text.split(",").map((s) => s.trim()).filter((s) => s !== "");

/** Why this draft is not ready, or `null`. Checked in the order the operator
 *  would meet the fields, so the message names the first thing to fix. */
function draftProblem(draft: Draft): string | null {
  if (draft.name.trim() === "") return "Give the template a name.";
  if (!/^[a-z0-9-]+$/.test(draft.name.trim())) {
    return "A template name is lowercase letters, digits and hyphens.";
  }
  if (draft.kind.trim() === "") {
    return "Say what kind of thing this provisions — mediator, app, did-host-http.";
  }
  const ambient = list(draft.requiredVars).filter((v) => AMBIENT_VARS.includes(v));
  if (ambient.length > 0) {
    // The specification says requiredVars MUST NOT name these. Refusing here
    // rather than at the agent is worth it: the agent injects them anyway, so a
    // template declaring one asks an operator for a value that is then thrown
    // away, and nothing on screen would ever say so.
    return `${ambient.join(", ")} ${ambient.length === 1 ? "is" : "are"} filled in by your agent and cannot be asked for.`;
  }
  let document: unknown;
  try {
    document = JSON.parse(draft.document);
  } catch (e) {
    return `The document is not valid JSON — ${e instanceof Error ? e.message : String(e)}`;
  }
  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    return "The document has to be a JSON object.";
  }
  const id = (document as Record<string, unknown>)["id"];
  if (typeof id !== "string" || !id.includes("{DID}")) {
    return "The document's `id` must contain `{DID}` — that is where your agent writes the DID it mints.";
  }
  return null;
}

function templateFrom(draft: Draft): DidTemplate {
  const methods = list(draft.methods);
  const requiredVars = list(draft.requiredVars);
  return {
    schemaVersion: 1,
    name: draft.name.trim(),
    kind: draft.kind.trim(),
    ...(draft.description.trim() ? { description: draft.description.trim() } : {}),
    ...(methods.length ? { methods } : {}),
    ...(requiredVars.length ? { requiredVars } : {}),
    // Carried through untouched. The editor does not draw `optionalVars` or
    // `defaults`, and an update is a REPLACE — so a template that had them would
    // lose them on every save from this pane, silently, with the agent
    // reporting success.
    ...(draft.original?.optionalVars ? { optionalVars: draft.original.optionalVars } : {}),
    ...(draft.original?.defaults ? { defaults: draft.original.defaults } : {}),
    document: JSON.parse(draft.document) as Record<string, unknown>,
  };
}

export function DidTemplatesPane({
  parties,
  authority,
  contextId,
  contextHeading,
}: {
  parties: Parties;
  authority: Authority | null;
  contextId: ContextSelection;
  contextHeading?: string | undefined;
}) {
  // Both namespaces, always. A context template and the global one of the same
  // name are different records, and showing only one of them is how an operator
  // edits the wrong one.
  const templates = useAsync(async () => {
    const global = await didTemplateList(managerSender, parties);
    const scoped = contextId
      ? await didTemplateList(managerSender, { ...parties, contextId })
      : [];
    return mergeTemplates(scoped, global);
  }, [parties.holder.did, parties.service.did, contextId]);

  const [draft, setDraft] = useState<Draft | null>(null);

  const denied = authority && !hasRole(authority, "admin", "super-admin")
    ? "Writing DID templates needs the admin role at this agent."
    : null;

  const columns: Column<DidTemplateRecord>[] = [
    {
      key: "name",
      header: "Template",
      width: "22ch",
      render: (tpl) => (
        <div style={{ display: "grid", gap: 3, minWidth: 0 }}>
          <span style={{ fontFamily: font.mono, fontWeight: 620 }}>{tpl.name}</span>
          <Pill tone={isEditable(tpl) ? "off" : "accent"}>{scopeWord(tpl)}</Pill>
        </div>
      ),
    },
    {
      key: "kind",
      header: "Kind",
      render: (tpl) => <span style={{ color: c.muted }}>{tpl.kind}</span>,
    },
    {
      key: "description",
      header: "What it provisions",
      render: (tpl) => (
        <span style={{ color: c.muted, lineHeight: 1.5 }}>
          {tpl.description || <span style={{ color: c.faint }}>—</span>}
        </span>
      ),
    },
    {
      key: "vars",
      header: "Asks for",
      render: (tpl) =>
        (tpl.requiredVars ?? []).length === 0 ? (
          <span style={{ color: c.faint }}>nothing</span>
        ) : (
          <span style={{ fontFamily: font.mono, fontSize: t.xs, color: c.muted }}>
            {(tpl.requiredVars ?? []).join(", ")}
          </span>
        ),
    },
    {
      key: "actions",
      header: "",
      render: (tpl) => (
        <div style={{ display: "grid", gap: 8, minWidth: 170 }}>
          <Button onClick={() => setDraft(draftFrom(tpl))}>
            {isEditable(tpl) ? "Edit" : "Inspect"}
          </Button>
          {isEditable(tpl) && (
            <Destructive<DidTemplateRecord>
              label="Delete"
              disabledReason={denied}
              preview={async () => tpl}
              forceLabel="Delete anyway"
              renderPreview={(p) => (
                <>
                  <strong>Deleting this template cannot be undone.</strong>
                  <span>
                    Nothing already minted from <code style={{ fontFamily: font.mono }}>{p.name}</code>{" "}
                    changes — a DID is a published log and does not refer back to the template it was
                    stamped from. What stops working is minting another one: anything that names this
                    template, a setup flow or a script, is refused from now on.
                  </span>
                </>
              )}
              commit={async () => {
                await didTemplateDelete(managerSender, {
                  ...parties,
                  name: tpl.name,
                  ...(scopeSelector(tpl) ? { contextId: scopeSelector(tpl)! } : {}),
                });
              }}
              onDone={() => {
                if (draft?.original?.name === tpl.name) setDraft(null);
                templates.reload();
              }}
            />
          )}
        </div>
      ),
    },
  ];

  return (
    <div style={{ display: "grid", gap: 16, alignContent: "start" }}>
      <Panel
        title={
          contextHeading ? `DID templates for ${contextHeading}` : "DID templates at this agent"
        }
        description={
          <>
            The document shapes your agent stamps DIDs from — a method, service entries and key
            shapes for a kind of thing, authored once. Global templates and this context&apos;s are
            both shown: the same name in two scopes is two different templates, and the badge says
            which you are looking at.
          </>
        }
      >
        {templates.error && <LoadError what="DID templates" error={templates.error} />}
        {templates.loading && !templates.data && <Loading what="DID templates" />}
        {templates.data && (
          <Table
            columns={columns}
            rows={templates.data}
            rowKey={(tpl) => `${scopeKey(tpl)}:${tpl.name}`}
            empty="Your agent holds no DID templates. New DIDs are composed from the choices on the DIDs pane instead."
          />
        )}
        <div style={{ marginTop: 12 }}>
          <Button
            kind="primary"
            disabled={Boolean(denied)}
            {...(denied ? { title: denied } : {})}
            onClick={() => setDraft(blankDraft(contextId ?? undefined))}
          >
            New template
          </Button>
          {denied && (
            <span style={{ fontSize: t.sm, color: c.muted, marginLeft: 10 }}>{denied}</span>
          )}
        </div>
      </Panel>

      {draft && (
        <TemplateEditor
          parties={parties}
          draft={draft}
          onChange={setDraft}
          denied={denied}
          onClose={() => setDraft(null)}
          onSaved={() => {
            setDraft(null);
            templates.reload();
          }}
        />
      )}
    </div>
  );
}

function TemplateEditor({
  parties,
  draft,
  onChange,
  denied,
  onClose,
  onSaved,
}: {
  parties: Parties;
  draft: Draft;
  onChange: (next: Draft) => void;
  denied: string | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<ConsentRequiredError | null>(null);
  const [rendered, setRendered] = useState<string | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [renderVars, setRenderVars] = useState<Record<string, string>>({});

  const existing = draft.original;
  const editable = existing === null || isEditable(existing);
  const problem = useMemo(() => draftProblem(draft), [draft]);
  const patch = (fields: Partial<Draft>) => onChange({ ...draft, ...fields });

  const save = useCallback(async () => {
    setBusy(true);
    setError(null);
    setPending(null);
    const scoped = draft.contextId ? { contextId: draft.contextId } : {};
    const template = templateFrom(draft);
    const ok = await runMutation(
      async () => {
        if (existing) {
          await didTemplateUpdate(managerSender, {
            ...parties,
            ...scoped,
            name: existing.name,
            template,
          });
        } else {
          await didTemplateCreate(managerSender, { ...parties, ...scoped, template });
        }
      },
      { onConsent: setPending, onError: setError },
    );
    setBusy(false);
    if (ok) onSaved();
  }, [parties, draft, existing, onSaved]);

  /**
   * Ask the agent what this template renders to.
   *
   * **Against the stored template, not the draft on screen.** `render` takes a
   * name, so it can only render what the agent holds — which means on an edited
   * draft it previews the version currently saved. Said on the button rather
   * than hidden, because a preview that silently showed the old document while
   * the operator read it as the new one is worse than no preview.
   */
  const preview = useCallback(async () => {
    if (!existing) return;
    setRenderError(null);
    setRendered(null);
    try {
      const doc = await didTemplateRender(managerSender, {
        ...parties,
        name: existing.name,
        ...(draft.contextId ? { contextId: draft.contextId } : {}),
        vars: renderVars,
      });
      setRendered(JSON.stringify(doc, null, 2));
    } catch (e) {
      setRenderError(e instanceof Error ? e.message : String(e));
    }
  }, [parties, existing, draft.contextId, renderVars]);

  const askFor = (existing?.requiredVars ?? []).filter((v) => !AMBIENT_VARS.includes(v));

  return (
    <Panel
      title={existing ? `Template · ${existing.name}` : "New template"}
      description={
        editable ? (
          <>
            Saving replaces the whole template — this is not a patch, and anything left out of the
            form is left out of the stored record.{" "}
            {existing ? "Nothing already minted from it changes." : null}
          </>
        ) : (
          <>
            A built-in. It ships with your agent and the rooms flow stamps from it, so it cannot be
            edited or deleted here — shown so you can read what it publishes.
          </>
        )
      }
    >
      <div style={{ display: "grid", gap: 12, minWidth: 0 }}>
        <div style={row}>
          <Field label="NAME" hint="— lowercase, digits and hyphens">
            <input
              aria-label="Template name"
              style={{ ...fieldStyle, width: "20ch", fontFamily: font.mono }}
              value={draft.name}
              disabled={existing !== null}
              title={existing ? "A template is renamed by creating a new one and deleting this." : undefined}
              spellCheck={false}
              onChange={(e) => patch({ name: e.target.value })}
            />
          </Field>
          <Field label="KIND" hint="— mediator, app, did-host-http">
            <input
              aria-label="Template kind"
              style={{ ...fieldStyle, width: "20ch" }}
              value={draft.kind}
              disabled={!editable}
              spellCheck={false}
              onChange={(e) => patch({ kind: e.target.value })}
            />
          </Field>
          <Field label="DID METHODS" hint="— comma separated">
            <input
              aria-label="DID methods"
              style={{ ...fieldStyle, width: "18ch", fontFamily: font.mono }}
              value={draft.methods}
              disabled={!editable}
              spellCheck={false}
              onChange={(e) => patch({ methods: e.target.value })}
            />
          </Field>
          <Field label="DESCRIPTION" grow="1 1 24rem">
            <input
              aria-label="Description"
              style={{ ...fieldStyle, width: "100%" }}
              value={draft.description}
              disabled={!editable}
              placeholder="What a DID stamped from this is for"
              onChange={(e) => patch({ description: e.target.value })}
            />
          </Field>
        </div>

        <Field label="REQUIRED VARIABLES" hint="— comma separated; whoever mints must supply every one">
          <input
            aria-label="Required variables"
            style={{ ...fieldStyle, width: "100%", fontFamily: font.mono }}
            value={draft.requiredVars}
            disabled={!editable}
            placeholder="WEBVH_SERVER, MEDIATOR_DID"
            spellCheck={false}
            onChange={(e) => patch({ requiredVars: e.target.value })}
          />
        </Field>
        <span style={{ fontSize: t.xs, color: c.muted, lineHeight: 1.5, maxWidth: "82ch" }}>
          Your agent fills in <code style={{ fontFamily: font.mono }}>{AMBIENT_VARS.join(", ")}</code>{" "}
          itself, so these are never asked for. The check runs after it has derived the DID&apos;s
          keys, which is why a variable declared and not supplied is not a free refusal.
        </span>

        <div style={{ display: "grid", gap: 5 }}>
          <Label hint="— {TOKEN} placeholders; `id` must contain {DID}">DOCUMENT</Label>
          <textarea
            aria-label="Template document"
            style={areaStyle}
            value={draft.document}
            disabled={!editable}
            spellCheck={false}
            onChange={(e) => patch({ document: e.target.value })}
          />
        </div>

        {problem && editable && <Note tone="warn">{problem}</Note>}
        {error && <Note tone="danger">{error}</Note>}
        {pending && <ConsentCeremony pending={pending} />}

        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          {editable && (
            <Button
              kind="primary"
              disabled={busy || Boolean(problem) || Boolean(denied)}
              {...(denied ? { title: denied } : {})}
              onClick={() => void save()}
            >
              {busy ? "Saving…" : existing ? "Replace template" : "Create template"}
            </Button>
          )}
          {existing && (
            <Button
              onClick={() => void preview()}
              title="Renders the template as your agent holds it — not the edits above, which it has not seen."
            >
              Render the stored version
            </Button>
          )}
          <CopyButton
            value={draft.document}
            label="Copy the document"
            title={`Copy the document of ${draft.name || "this template"}`}
          />
          <Button kind="quiet" onClick={onClose}>
            Close
          </Button>
        </div>

        {existing && askFor.length > 0 && (
          <div style={{ display: "grid", gap: 6 }}>
            <Label hint="— used only for the render above, nothing is created">
              VARIABLES FOR THE RENDER
            </Label>
            <div style={row}>
              {askFor.map((name) => (
                <Field key={name} label={name} grow="1 1 18rem">
                  <input
                    aria-label={`Render variable ${name}`}
                    style={{ ...fieldStyle, width: "100%", fontFamily: font.mono }}
                    value={renderVars[name] ?? ""}
                    spellCheck={false}
                    onChange={(e) =>
                      setRenderVars((prev) => ({ ...prev, [name]: e.target.value }))
                    }
                  />
                </Field>
              ))}
            </div>
          </div>
        )}

        {renderError && <LoadError what="the rendered document" error={renderError} />}
        {rendered && (
          <div style={{ display: "grid", gap: 6, minWidth: 0 }}>
            <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <strong style={{ fontSize: t.sm }}>What your agent renders this to</strong>
              <CopyButton value={rendered} title="Copy the rendered document" />
              <span style={{ fontSize: t.xs, color: c.muted }}>
                Nothing was created — this is the same substitution a mint would perform.
              </span>
            </div>
            <pre style={pre}>{rendered}</pre>
          </div>
        )}
      </div>
    </Panel>
  );
}
