// The New DID form.
//
// Split out of `dids.tsx` because the two answer different questions: that file
// is about the identifiers a context has published, this one is about what a new
// one would be. The form had grown to a server id and a Portable tick, which is
// a fraction of what `vta/webvh/dids/create/1.0` accepts — so an operator who
// wanted a named path, a mediator entry or a template had to mint through the
// CLI and the console was a viewer wearing a form.
//
// **The order of the sections is the order of the decisions, and two of them
// cannot be taken back.** `portable` is committed in the first log entry and can
// never be added afterwards; a `preRotationCount` of 0 means a stolen key cannot
// be rotated away from. Both are drawn as choices with their consequence written
// beside them rather than as ticks, because a tick with a consequence is a tick
// nobody reads.
//
// **A template, if one is chosen, seeds the rest of the form and then gets out
// of the way.** `defaults` on a template is declared as hints for exactly this
// kind of wizard, so they are applied once at selection. They do not keep
// overriding the controls: a checkbox that springs back is a checkbox that lies
// about what will be sent.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  webvhDidCreate,
  webvhServerList,
  type WebvhServerRecord,
} from "@openvtc/pnm-core/webvh";
import {
  didTemplateList,
  keysList,
  servicesList,
  type DidTemplateRecord,
  type KeyRecord,
} from "@openvtc/pnm-core/admin";
import { Button, CopyButton, Did, Note, Panel, Pill } from "../../ui.js";
import { c, t, font } from "../../theme.js";
import { managerSender } from "../sender.js";
import { ConsentRequiredError } from "../carrier.js";
import { ConsentCeremony, runMutation } from "../destructive.js";
import { hasRole, type Authority, type Parties } from "../use-vta.js";
import type { ContextSelection } from "../context-column.js";
import {
  additionalServices,
  draftsReady,
  type ServiceDraft,
} from "../service-entries.js";
import {
  missingVars,
  seedVars,
  templateDefaults,
  templateVars,
  varsToSend,
  type TemplateVar,
} from "../template-vars.js";
import { mergeTemplates, scopeKey, scopeSelector, scopeWord } from "../template-scope.js";
import { keyLabel, mintKeys, stillOffered } from "../mint-keys.js";
import {
  agentMediators,
  Choice,
  choices,
  Field,
  fieldStyle,
  Label,
  PathPicker,
  pathMode,
  row,
  SERVER_CHOOSES,
  ServerSelect,
  type PathChoice,
} from "./rooms-create-parts.js";
import { ServiceDrafts } from "./did-service-editor.js";

/** A section of the form: what it decides, then the controls. */
function Section({
  title,
  why,
  children,
}: {
  title: string;
  why: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section style={{ display: "grid", gap: 9, minWidth: 0 }}>
      <div style={{ display: "grid", gap: 3 }}>
        <h3 style={{ margin: 0, fontSize: t.base, fontWeight: 640, color: c.text }}>{title}</h3>
        <p style={{ margin: 0, fontSize: t.sm, color: c.muted, lineHeight: 1.55, maxWidth: "82ch" }}>
          {why}
        </p>
      </div>
      {children}
    </section>
  );
}

const divider = (
  <div style={{ height: 1, background: c.lineSoft, margin: "2px 0" }} aria-hidden />
);

/** What the agent said when it minted, kept on screen afterwards. */
interface Minted {
  did: string;
  scid: string;
  portable: boolean;
  preRotationKeyCount: number;
  signingKeyId: string;
  kaKeyId: string;
  mnemonic?: string | undefined;
  logEntry?: string | undefined;
}

export function CreateDid({
  parties,
  contextId,
  authority,
  onCreated,
}: {
  parties: Parties;
  contextId: ContextSelection;
  authority: Authority | null;
  onCreated: () => void;
}) {
  // ── Where it is published ──
  const [serverId, setServerId] = useState("");
  const [servers, setServers] = useState<WebvhServerRecord[] | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [path, setPath] = useState<PathChoice>(SERVER_CHOOSES);
  const [domain, setDomain] = useState("");
  const [label, setLabel] = useState("");

  // ── What it commits to ──
  const [portable, setPortable] = useState(false);
  const [preRotation, setPreRotation] = useState<string>("");
  const [setPrimary, setSetPrimary] = useState(false);

  // ── What it advertises ──
  const [addMediator, setAddMediator] = useState(false);
  const [addTsp, setAddTsp] = useState(false);
  const [drafts, setDrafts] = useState<ServiceDraft[]>([]);
  const [mediatorDid, setMediatorDid] = useState<string | null>(null);

  // ── Which keys it is built on ──
  const [keys, setKeys] = useState<KeyRecord[] | null>(null);
  const [keysError, setKeysError] = useState<string | null>(null);
  const [signingKeyId, setSigningKeyId] = useState("");
  const [kaKeyId, setKaKeyId] = useState("");

  // ── What it is stamped from ──
  const [templates, setTemplates] = useState<DidTemplateRecord[] | null>(null);
  const [templateError, setTemplateError] = useState<string | null>(null);
  const [template, setTemplate] = useState("");
  const [varValues, setVarValues] = useState<Record<string, string>>({});

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<ConsentRequiredError | null>(null);
  const [minted, setMinted] = useState<Minted | null>(null);

  // The hosting servers the agent can publish through. Its failure is reported
  // rather than swallowed: an empty picker and an unaskable agent look the same,
  // and only one of them means "register a server first".
  useEffect(() => {
    let live = true;
    setServers(null);
    setServerError(null);
    webvhServerList(managerSender, parties).then(
      (res) => live && setServers(res.servers ?? []),
      (e: unknown) => live && setServerError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      live = false;
    };
  }, [parties]);

  // The templates in scope. Both namespaces are asked for, because a name can
  // exist in each and they are different templates — see `templateContext`.
  useEffect(() => {
    let live = true;
    setTemplates(null);
    setTemplateError(null);
    const global = didTemplateList(managerSender, parties);
    const scoped = contextId
      ? didTemplateList(managerSender, { ...parties, contextId })
      : Promise.resolve([] as DidTemplateRecord[]);
    Promise.all([global, scoped]).then(
      // Merged rather than concatenated: the agent may answer a context-scoped
      // listing with a global template of the same name, so the two sets
      // overlap — see `mergeTemplates`.
      ([g, s]) => live && setTemplates(mergeTemplates(s, g)),
      (e: unknown) => live && setTemplateError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      live = false;
    };
  }, [parties, contextId]);

  // The keys already held in this context, for the reuse control.
  //
  // Asked per context because a key's `contextId` is part of what makes it
  // usable here — see `mint-keys.ts`. `limit` is the page size to ask for, not
  // a cap: a context with more keys than this shows the first page and the
  // control says so, rather than a truncated list passing as complete.
  useEffect(() => {
    let live = true;
    setKeys(null);
    setKeysError(null);
    if (!contextId) return;
    keysList(managerSender, { ...parties, contextId, status: "active", limit: 200 }).then(
      (res) => live && setKeys(res.keys),
      (e: unknown) => live && setKeysError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      live = false;
    };
  }, [parties, contextId]);

  // Which mediator the agent would name, so the mediator tick can show it.
  // Read-only: `addMediatorService` says *whether*, and the agent decides which.
  useEffect(() => {
    let live = true;
    servicesList(managerSender, parties).then(
      (res) => {
        if (!live) return;
        const first = agentMediators(res)[0];
        setMediatorDid(first ? first.did : "");
      },
      () => live && setMediatorDid(""),
    );
    return () => {
      live = false;
    };
  }, [parties]);

  const offered = useMemo(
    () => (contextId && keys ? mintKeys(keys, contextId) : { signing: [], agreement: [] }),
    [keys, contextId],
  );

  // A selection the context no longer offers is dropped rather than sent.
  // Changing the tree changes which keys are usable, and a stale id would reach
  // the agent as a key belonging to a different context — refused, but only
  // after it had derived everything else.
  useEffect(() => {
    if (!stillOffered(signingKeyId, offered.signing)) setSigningKeyId("");
    if (!stillOffered(kaKeyId, offered.agreement)) setKaKeyId("");
  }, [offered, signingKeyId, kaKeyId]);

  const chosen = useMemo(
    () => templates?.find((tpl) => tpl.name === template) ?? null,
    [templates, template],
  );
  const vars: TemplateVar[] = useMemo(() => (chosen ? templateVars(chosen) : []), [chosen]);

  // Which namespace the chosen template came from. A context template and a
  // global one of the same name are different records, and sending the wrong
  // `templateContext` renders a different document — see `template-scope.ts`.
  const templateContext = chosen ? scopeSelector(chosen) : undefined;

  /** Choosing a template seeds the form from its hints, once. */
  const pickTemplate = useCallback(
    (name: string) => {
      setTemplate(name);
      const tpl = templates?.find((x) => x.name === name);
      if (!tpl) {
        setVarValues({});
        return;
      }
      const d = templateDefaults(tpl);
      if (d.portable !== undefined) setPortable(d.portable);
      if (d.addMediatorService !== undefined) setAddMediator(d.addMediatorService);
      if (d.addTspService !== undefined) setAddTsp(d.addTspService);
      if (d.preRotationCount !== undefined) setPreRotation(String(d.preRotationCount));
      setVarValues(
        seedVars(templateVars(tpl), {
          WEBVH_SERVER: serverId,
          MEDIATOR_DID: mediatorDid ?? "",
          CONTEXT: contextId ?? "",
        }),
      );
    },
    [templates, serverId, mediatorDid, contextId],
  );

  const missing = missingVars(vars, varValues);
  const servicesReady = draftsReady(drafts);
  const preRotationValue = preRotation.trim() === "" ? undefined : Number(preRotation);
  const preRotationBad =
    preRotationValue !== undefined &&
    (!Number.isInteger(preRotationValue) || preRotationValue < 0);

  const denied = authority && !hasRole(authority, "admin", "super-admin", "operator")
    ? "Creating a DID needs an administrative role at this agent."
    : !contextId
      ? "Select a context in the tree first — a DID is created inside one."
      : path.named && path.path.trim() === ""
        ? "Name the path, or let the hosting server choose one."
        : missing.length > 0
          ? `${chosen?.name} needs ${missing.join(", ")} — the agent refuses the render without ${missing.length === 1 ? "it" : "them"}, after it has already derived the keys.`
          : !servicesReady
            ? "One of the extra service entries is not ready."
            : preRotationBad
              ? "Pre-rotation is a whole number of successor keys, or blank for your agent's default."
              : null;

  const submit = useCallback(async () => {
    if (!contextId) return;
    setBusy(true);
    setError(null);
    setPending(null);
    setMinted(null);
    const ok = await runMutation(
      async () => {
        const res = await webvhDidCreate(managerSender, {
          ...parties,
          contextId,
          portable,
          // Said rather than defaulted. The agent's default is `true`, which
          // replaces whatever the context acted as before — so the quiet path
          // through this form must be the one that changes nothing.
          setPrimary,
          addMediatorService: addMediator,
          addTspService: addTsp,
          ...(serverId.trim() ? { serverId: serverId.trim() } : {}),
          ...pathMode(path),
          ...(domain.trim() ? { domain: domain.trim() } : {}),
          ...(label.trim() ? { label: label.trim() } : {}),
          ...(preRotationValue !== undefined ? { preRotationCount: preRotationValue } : {}),
          ...(signingKeyId ? { signingKeyId } : {}),
          ...(kaKeyId ? { kaKeyId } : {}),
          ...(drafts.length ? { additionalServices: additionalServices(drafts) } : {}),
          ...(chosen
            ? {
                template: chosen.name,
                ...(templateContext ? { templateContext } : {}),
                templateVars: varsToSend(vars, varValues),
              }
            : {}),
        });
        setMinted({
          did: res.did,
          scid: res.scid,
          portable: res.portable,
          preRotationKeyCount: res.preRotationKeyCount,
          signingKeyId: res.signingKeyId,
          kaKeyId: res.kaKeyId,
          mnemonic: res.mnemonic,
          logEntry: res.logEntry,
        });
      },
      { onConsent: setPending, onError: setError },
    );
    setBusy(false);
    if (ok) {
      // The identity decisions reset; where it publishes does not. Minting a
      // second DID on the same server is the common case, and clearing the
      // picker would make it a retyping exercise.
      setPath(SERVER_CHOOSES);
      setLabel("");
      setDrafts([]);
      // Cleared, unlike the hosting server. Reusing a key is a decision about
      // one DID, and leaving it set would silently build the *next* DID on the
      // same key — which is the correlation the control warns about, arrived at
      // by not touching anything.
      setSigningKeyId("");
      setKaKeyId("");
      onCreated();
    }
  }, [
    parties, contextId, serverId, path, domain, label, portable, setPrimary,
    addMediator, addTsp, drafts, chosen, templateContext, vars, varValues,
    preRotationValue, signingKeyId, kaKeyId, onCreated,
  ]);

  return (
    <Panel
      title="New DID"
      description={
        contextId ? (
          <>
            Created in <code style={{ fontFamily: font.mono }}>{contextId}</code> and published as
            a <code style={{ fontFamily: font.mono }}>did:webvh</code> log on a hosting server.
            Once published it is resolvable by anyone.
          </>
        ) : (
          "Select a context in the tree to create a DID inside it."
        )
      }
    >
      <div style={{ display: "grid", gap: 18, minWidth: 0 }}>
        <Section
          title="Where it is published"
          why={
            <>
              A hosting server serves the DID&apos;s log. Which server and which path the log sits
              at both become part of the identifier, so this is not only a storage choice — unless
              the DID is portable, it is the one place it can ever be served from.
            </>
          }
        >
          {serverError && (
            <Note tone="warn">
              Your agent would not list its hosting servers — {serverError}. That is a failure to
              ask, not an agent with none registered; minting without one publishes nothing and
              hands the log back for you to serve.
            </Note>
          )}
          <div style={row}>
            <Field label="HOSTING SERVER" hint="— blank serves the log yourself">
              <ServerSelect
                name="Hosting server"
                servers={servers}
                value={serverId}
                onChange={setServerId}
              />
            </Field>
            <Field label="DOMAIN" hint="— only where the server serves several">
              <input
                aria-label="Hosting domain"
                style={fieldStyle}
                value={domain}
                placeholder="the server's default"
                onChange={(e) => setDomain(e.target.value)}
              />
            </Field>
            <Field label="LABEL" hint="— your agent's own note, never published">
              <input
                aria-label="Label"
                style={fieldStyle}
                value={label}
                placeholder="optional"
                onChange={(e) => setLabel(e.target.value)}
              />
            </Field>
          </div>
          <PathPicker
            name="DID path"
            example="services/billing"
            value={path}
            onChange={setPath}
          />
        </Section>

        {divider}

        <Section
          title="What it commits to"
          why={
            <>
              Both of these are written into the log&apos;s first entry, which is append-only.
              Neither can be changed later by updating the document.
            </>
          }
        >
          <div style={choices}>
            <Choice
              name="portable"
              value="fixed"
              checked={!portable}
              onSelect={() => setPortable(false)}
              title="Tied to where it is published"
            >
              The identifier derives from this host, so the DID can never move. This is the usual
              choice.
            </Choice>
            <Choice
              name="portable"
              value="portable"
              checked={portable}
              onSelect={() => setPortable(true)}
              title="Portable"
            >
              It can be moved to another hosting domain later and keep its identity. Decided now —
              portability cannot be added afterwards.
            </Choice>
          </div>
          <div style={row}>
            <Field label="PRE-ROTATION KEYS" hint="— blank uses your agent's default">
              <input
                aria-label="Pre-rotation keys"
                style={{ ...fieldStyle, width: "12ch" }}
                value={preRotation}
                inputMode="numeric"
                placeholder="default"
                onChange={(e) => setPreRotation(e.target.value)}
              />
            </Field>
            <span style={{ fontSize: t.xs, color: c.muted, maxWidth: "58ch", paddingBottom: 7, lineHeight: 1.5 }}>
              Successor keys committed in advance.{" "}
              {preRotationValue === 0 ? (
                <strong style={{ color: c.danger }}>
                  0 switches pre-rotation off: with no successor committed, whoever steals the
                  current key can rotate to their own as convincingly as you can, so a compromise
                  cannot be recovered from.
                </strong>
              ) : (
                <>Rotating to an uncommitted key is what a thief would also be able to do.</>
              )}
            </span>
          </div>
          <label style={{ display: "flex", gap: 10, alignItems: "flex-start", fontSize: t.sm, cursor: "pointer" }}>
            <input
              type="checkbox"
              aria-label="Make this the context's own DID"
              checked={setPrimary}
              onChange={(e) => setSetPrimary(e.target.checked)}
              style={{ margin: "3px 0 0" }}
            />
            <span style={{ display: "grid", gap: 2, minWidth: 0 }}>
              <span style={{ fontWeight: 600, color: c.text }}>
                Make this the context&apos;s own DID
              </span>
              <span style={{ fontSize: t.xs, color: c.muted, lineHeight: 1.5 }}>
                Replaces whatever <code style={{ fontFamily: font.mono }}>{contextId ?? "this context"}</code>{" "}
                currently acts as. Anything that resolves the context&apos;s DID to find its keys —
                a room host reading them at startup — follows this one instead.
              </span>
            </span>
          </label>
        </Section>

        {divider}

        <Section
          title="Which keys it is built on"
          why={
            <>
              A DID publishes one key that signs — its own log entries, and anything it issues —
              and one that others encrypt to. Your agent mints both unless you name keys it
              already holds.
            </>
          }
        >
          {keysError && (
            <Note tone="warn">
              Your agent would not list this context&apos;s keys — {keysError}. Fresh keys can
              still be minted; what is unavailable is reusing one you already hold.
            </Note>
          )}
          {!keysError && keys === null && contextId && (
            <span style={{ fontSize: t.sm, color: c.faint }}>
              Reading the keys in {contextId}…
            </span>
          )}
          {/* With no context there is nothing to read, so the pickers are not
              drawn at all rather than drawn saying "Reading…" — a control
              claiming to be waiting on an agent nobody asked is the same false
              claim as an empty list standing in for a failed one, one notch
              quieter. Absent rather than hidden, because a hidden control is
              still read out by a screen reader and still found by a search. */}
          {contextId ? (
            <div style={row}>
              <Field label="SIGNING KEY" hint="— blank mints a fresh one" grow="1 1 22rem">
                <KeySelect
                  name="Signing key"
                  keys={offered.signing}
                  ready={keys !== null}
                  value={signingKeyId}
                  onChange={setSigningKeyId}
                />
              </Field>
              <Field label="KEY-AGREEMENT KEY" hint="— blank mints a fresh one" grow="1 1 22rem">
                <KeySelect
                  name="Key-agreement key"
                  keys={offered.agreement}
                  ready={keys !== null}
                  value={kaKeyId}
                  onChange={setKaKeyId}
                />
              </Field>
            </div>
          ) : (
            <span style={{ fontSize: t.sm, color: c.muted }}>
              Keys belong to a context. Choose one in the tree to see what is already held there.
            </span>
          )}
          {/* The filter's own reasoning, said where it has an effect. A person
              looking for a key they know exists should find out why it is not
              here, rather than concluding the list is broken. */}
          {contextId && (
            <span style={{ fontSize: t.xs, color: c.muted, lineHeight: 1.55, maxWidth: "82ch" }}>
              Only active keys in{" "}
              <code style={{ fontFamily: font.mono }}>{contextId}</code> are offered, and only ones
              that can fill the role: a key-agreement key cannot sign, so a DID given one could
              never update its own log — including the first entry, which is written now.
            </span>
          )}
          {(signingKeyId || kaKeyId) && (
            <Note tone="warn">
              Anyone who sees both documents can tell that this DID and every other one publishing
              the same key are held by you. That link is the point where reuse is deliberate — a
              service replacing its own identifier — and a correlation nobody chose where it is
              not.
            </Note>
          )}
        </Section>

        {divider}

        <Section
          title="What it advertises"
          why={
            <>
              Service entries in the document are how anyone else reaches whoever holds this DID.
              Each one is a claim: a transport advertised here is one clients will choose, and
              nothing later checks that something behind the DID actually speaks it.
            </>
          }
        >
          <label style={{ display: "flex", gap: 10, alignItems: "flex-start", fontSize: t.sm, cursor: "pointer" }}>
            <input
              type="checkbox"
              aria-label="Advertise a DIDComm mediator"
              checked={addMediator}
              onChange={(e) => setAddMediator(e.target.checked)}
              style={{ margin: "3px 0 0" }}
            />
            <span style={{ display: "grid", gap: 2, minWidth: 0 }}>
              <span style={{ fontWeight: 600, color: c.text }}>Advertise a DIDComm mediator</span>
              <span style={{ fontSize: t.xs, color: c.muted, lineHeight: 1.5 }}>
                {mediatorDid === null
                  ? "Your agent's own mediator — asking which one…"
                  : mediatorDid === ""
                    ? "Your agent routes nothing through a mediator, so ticking this publishes no endpoint it can name."
                    : "Your agent's own mediator, which it names itself. Without this entry the DID is reachable only by whoever already knows how."}
              </span>
              {/* Inside the checkbox's label: no QR button, which would be a
                  control inside a control. */}
              {mediatorDid ? <Did value={mediatorDid} size={t.xs} qr={false} /> : null}
            </span>
          </label>
          <label style={{ display: "flex", gap: 10, alignItems: "flex-start", fontSize: t.sm, cursor: "pointer" }}>
            <input
              type="checkbox"
              aria-label="Also advertise TSP"
              checked={addTsp}
              onChange={(e) => setAddTsp(e.target.checked)}
              style={{ margin: "3px 0 0" }}
            />
            <span style={{ display: "grid", gap: 2, minWidth: 0 }}>
              <span style={{ fontWeight: 600, color: c.text }}>
                Also advertise TSP at that mediator
              </span>
              <span style={{ fontSize: t.xs, color: c.muted, lineHeight: 1.5 }}>
                Off by default, which is your agent&apos;s own posture. Tick it only if whoever
                holds this DID decodes TSP — a DID advertising a transport nothing behind it
                decodes is one clients will choose and cannot use.
              </span>
            </span>
          </label>
          {addTsp && !addMediator && (
            <Note tone="warn">
              TSP is advertised <em>at the mediator the document names for DIDComm</em>, and this
              document names none. Tick the mediator entry above, or the TSP entry has no endpoint
              to sit beside.
            </Note>
          )}
          <ServiceDrafts drafts={drafts} onChange={setDrafts} />
        </Section>

        {divider}

        <Section
          title="What it is stamped from"
          why={
            <>
              A template is a DID document with placeholders — the method, the service entries and
              the key shapes for a <em>kind</em> of thing, authored once. Choosing one replaces the
              document this form would otherwise compose, and its hints seed the choices above.
            </>
          }
        >
          {templateError && (
            <Note tone="warn">
              Your agent would not list DID templates — {templateError}. Minting without one
              composes the document from the choices above, which is what happens anyway when no
              template is chosen.
            </Note>
          )}
          {templates === null && !templateError && (
            <span style={{ fontSize: t.sm, color: c.faint }}>Reading your agent&apos;s templates…</span>
          )}
          {templates !== null && templates.length === 0 && (
            <span style={{ fontSize: t.sm, color: c.muted }}>
              Your agent holds no DID templates. The document is composed from the choices above.
            </span>
          )}
          {templates !== null && templates.length > 0 && (
            <div style={choices}>
              <Choice
                name="template"
                value=""
                checked={template === ""}
                onSelect={() => pickTemplate("")}
                title="No template"
              >
                Your agent composes the document from the choices above.
              </Choice>
              {templates.map((tpl) => (
                <Choice
                  key={`${scopeKey(tpl)}:${tpl.name}`}
                  name="template"
                  value={tpl.name}
                  checked={template === tpl.name}
                  onSelect={() => pickTemplate(tpl.name)}
                  title={
                    <span style={{ display: "inline-flex", gap: 7, alignItems: "center", flexWrap: "wrap" }}>
                      {tpl.name}
                      <Pill tone="off">{scopeWord(tpl)}</Pill>
                    </span>
                  }
                >
                  <span>{tpl.description || `A ${tpl.kind} DID.`}</span>
                  {(tpl.requiredVars ?? []).length > 0 && (
                    <span style={{ color: c.faint }}>
                      Asks for {(tpl.requiredVars ?? []).join(", ")}.
                    </span>
                  )}
                </Choice>
              ))}
            </div>
          )}
          {vars.length > 0 && (
            <div style={{ display: "grid", gap: 8 }}>
              <Label hint="— the agent fills in the DID, the keys and the context itself">
                TEMPLATE VARIABLES
              </Label>
              <div style={row}>
                {vars.map((v) => (
                  <Field
                    key={v.name}
                    label={v.name}
                    hint={v.required ? "— required" : "— has a default"}
                    grow="1 1 20rem"
                  >
                    <input
                      aria-label={v.name}
                      style={{
                        ...fieldStyle,
                        width: "100%",
                        fontFamily: font.mono,
                        ...(v.required && (varValues[v.name] ?? "").trim() === ""
                          ? { borderColor: c.danger }
                          : {}),
                      }}
                      value={varValues[v.name] ?? ""}
                      placeholder={v.fallback ?? ""}
                      spellCheck={false}
                      onChange={(e) =>
                        setVarValues((prev) => ({ ...prev, [v.name]: e.target.value }))
                      }
                    />
                  </Field>
                ))}
              </div>
              {missing.length > 0 && (
                <span style={{ fontSize: t.xs, color: c.danger }}>
                  {missing.join(", ")} {missing.length === 1 ? "is" : "are"} still empty. The agent
                  checks these <em>after</em> it derives the DID&apos;s keys, so a refusal here is
                  not free.
                </span>
              )}
            </div>
          )}
        </Section>

        {error && <Note tone="danger">{error}</Note>}
        {pending && <ConsentCeremony pending={pending} />}
        {minted && <MintedCard minted={minted} />}

        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <Button
            kind="primary"
            disabled={busy || Boolean(denied)}
            {...(denied ? { title: denied } : {})}
            onClick={() => void submit()}
          >
            {busy ? "Creating…" : "Create DID"}
          </Button>
          {denied && <span style={{ fontSize: t.sm, color: c.muted }}>{denied}</span>}
        </div>
      </div>
    </Panel>
  );
}

/**
 * One of the agent's existing keys, or a fresh one.
 *
 * The empty option is first and is the default, because minting a fresh key is
 * what a DID should normally do — the reuse is the exception and reads as one.
 * An empty list says *why* it is empty rather than offering a picker with
 * nothing in it: a context with no key of that type and a context whose keys
 * could not be read are different facts, and only one of them means "make one
 * first".
 */
function KeySelect({
  name,
  keys,
  ready,
  value,
  onChange,
}: {
  name: string;
  keys: KeyRecord[];
  ready: boolean;
  value: string;
  onChange: (id: string) => void;
}) {
  if (ready && keys.length === 0) {
    return (
      <span style={{ fontSize: t.sm, color: c.muted, paddingBottom: 7 }}>
        No key of this kind here yet — your agent will mint one.
      </span>
    );
  }
  return (
    <select
      aria-label={name}
      style={{ ...fieldStyle, width: "100%" }}
      value={value}
      disabled={!ready}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">{ready ? "Mint a fresh key" : "Reading…"}</option>
      {keys.map((k) => (
        <option key={k.keyId} value={k.keyId}>
          {keyLabel(k)}
        </option>
      ))}
    </select>
  );
}

/**
 * What the agent answered, kept after the form resets.
 *
 * **`logEntry` is the reason this survives the submit.** For a serverless mint
 * it is not a receipt — it is the only copy of the thing that has to be served,
 * and the DID does not resolve until someone serves it. A form that cleared
 * itself on success would throw it away.
 */
function MintedCard({ minted }: { minted: Minted }) {
  return (
    <Note tone="accent">
      <div style={{ display: "grid", gap: 9, minWidth: 0 }}>
        <strong>Minted.</strong>
        <div style={{ display: "flex", gap: 8, alignItems: "flex-start", flexWrap: "wrap" }}>
          <Did value={minted.did} />
          <CopyButton value={minted.did} title="Copy this DID" />
        </div>
        <span style={{ fontSize: t.xs, color: c.muted, lineHeight: 1.6 }}>
          {minted.portable ? "Portable" : "Tied to where it is published"} ·{" "}
          {minted.preRotationKeyCount === 0
            ? "pre-rotation off"
            : `${minted.preRotationKeyCount} successor key${minted.preRotationKeyCount === 1 ? "" : "s"} committed`}
          {minted.mnemonic ? ` · hosted as ${minted.mnemonic}` : ""}
        </span>
        <span style={{ fontFamily: font.mono, fontSize: t.xs, color: c.muted, wordBreak: "break-all" }}>
          signing {minted.signingKeyId} · key agreement {minted.kaKeyId}
        </span>
        {minted.logEntry && (
          <div style={{ display: "grid", gap: 6 }}>
            <span style={{ fontSize: t.sm }}>
              No hosting server was named, so this DID does not resolve until you serve its log.
              This is the first entry — the whole log so far.
            </span>
            <div>
              <CopyButton
                value={minted.logEntry}
                label="Copy the log entry"
                kind="default"
                title="Copy this DID's first log entry"
              />
            </div>
          </div>
        )}
      </div>
    </Note>
  );
}
