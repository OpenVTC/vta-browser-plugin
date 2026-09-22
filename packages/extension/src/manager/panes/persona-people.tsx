// People — what others have told the holder about themselves.
//
// The mirror of the Released view. That one answers "what has left, and to
// whom"; this one answers "what has arrived, and from whom". Both are per
// context, because a contact is filed in the context it was received in and
// against the persona that received it — "who was I when they told me this" is
// part of the record, not metadata about it.
//
// ## A card is a revision, never an overwrite
//
// `persona/contact/put` files a new revision and keeps what it superseded while
// anything still references it. So this pane shows the revision number, offers
// the history, and says when a contact changed something the holder has not
// looked at. A list that showed only the current card would quietly answer
// "what do they say" while the holder was asking "what did they say".
//
// ## Nothing here is signed
//
// What the holder types is their note of what someone said. The wire record
// carries `provenance` per claim and this pane sends none: claiming one on a
// peer's behalf would turn a note into an assertion about them.

import { useCallback, useState } from "react";
import {
  deleteContact,
  getContact,
  listContacts,
  putContact,
} from "@openvtc/pnm-core/persona";
import { Button, Note, Panel } from "../../ui.js";
import { managerSender } from "../sender.js";
import { Loading, LoadError } from "../table.js";
import { useAsync } from "../use-async.js";
import { Destructive } from "../destructive.js";
import type { Parties } from "../use-vta.js";

/** One fact on a card being recorded. */
interface FactDraft {
  type: string;
  value: string;
}

/**
 * The contacts filed in one context.
 *
 * `personaDid` is who a new card is filed against. It is required rather than
 * chosen here: the persona this context knows is the one that received the
 * disclosure, and offering a picker would invite filing a card against an
 * identity that was never in the room.
 */
export function PeoplePanel({
  parties,
  contextId,
  contextLabel,
  personaDid,
}: {
  parties: Parties;
  contextId: string;
  /** What the surrounding view calls this context, so the heading matches it. */
  contextLabel: string;
  personaDid: string | null;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [nonce, setNonce] = useState(0);

  const contacts = useAsync(
    () => listContacts(managerSender, { ...parties, contextId }),
    [parties, contextId, nonce],
  );
  const reload = useCallback(() => setNonce((n) => n + 1), []);

  return (
    <Panel
      title={`People in ${contextLabel}`}
      description="What they told you, kept as they said it. A new card does not replace the old one — what they said in March survives them changing it in April."
    >
      <div style={{ display: "grid", gap: 12 }}>
        {contacts.loading && <Loading what="who has told you something" />}
        {contacts.error && <LoadError what="your contacts" error={contacts.error} />}
        {contacts.data?.contacts.length === 0 && !recording && (
          <span style={{ fontSize: "var(--w-t-sm)", color: "var(--w-faint)" }}>
            Nobody here has told you anything yet.
          </span>
        )}
        {contacts.data?.contacts.map((c) => (
          <div key={c.contactId} style={{ display: "grid", gap: 6 }}>
            <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
              <strong style={{ fontSize: "var(--w-t-sm)" }}>
                {/* Their own display-name claim, or the DID said as a DID. The
                    spec forbids substituting one for the other silently, and a
                    DID rendered where a name goes reads as a name. */}
                {c.displayName ?? c.subjectDid}
              </strong>
              <span style={{ fontSize: "var(--w-t-xs)", color: "var(--w-faint)" }}>
                {c.claimCount ?? 0} fact{(c.claimCount ?? 0) === 1 ? "" : "s"} · revision {c.rev}
              </span>
              <Button
                kind="quiet"
                onClick={() => setOpenId(openId === c.contactId ? null : c.contactId)}
              >
                {openId === c.contactId ? "Close" : "What they said"}
              </Button>
              <Destructive
                label="Forget"
                preview={() => Promise.resolve(c)}
                renderPreview={(p) => (
                  <span>
                    Forgetting {p.displayName ?? p.subjectDid} takes every revision of what they
                    told you with it. Nothing you have already shown them is affected — that has
                    left.
                  </span>
                )}
                commit={async () => {
                  await deleteContact(managerSender, {
                    ...parties,
                    contextId,
                    contactId: c.contactId,
                  });
                }}
                onDone={() => {
                  setOpenId(null);
                  reload();
                }}
              />
            </div>
            {c.hasUnreviewedChange && (
              <Note tone="warn">
                They changed something since you last looked. Open the card to see what.
              </Note>
            )}
            {openId === c.contactId && (
              <ContactCard parties={parties} contextId={contextId} contactId={c.contactId} />
            )}
          </div>
        ))}
        {recording ? (
          <RecordContact
            parties={parties}
            contextId={contextId}
            personaDid={personaDid}
            onDone={() => {
              setRecording(false);
              reload();
            }}
            onCancel={() => setRecording(false)}
          />
        ) : (
          <div>
            <Button
              onClick={() => setRecording(true)}
              disabled={personaDid === null}
              {...(personaDid === null
                ? {
                    title:
                      "No persona of yours is known here yet, and a card has to be filed against one.",
                  }
                : {})}
            >
              Record someone
            </Button>
          </div>
        )}
      </div>
    </Panel>
  );
}

/** One card, with what they said before it. */
function ContactCard({
  parties,
  contextId,
  contactId,
}: {
  parties: Parties;
  contextId: string;
  contactId: string;
}) {
  const detail = useAsync(
    () =>
      getContact(managerSender, {
        ...parties,
        contextId,
        contactId,
        includeHistory: true,
      }),
    [parties, contextId, contactId],
  );
  if (detail.loading) return <Loading what="their card" />;
  if (detail.error) return <LoadError what="their card" error={detail.error} />;
  if (!detail.data) return null;
  const claims = detail.data.document?.claims ?? [];
  const history = detail.data.history ?? [];
  return (
    <div
      style={{
        display: "grid",
        gap: 8,
        padding: 10,
        border: "1px solid var(--w-line)",
        borderRadius: "var(--w-r-sm)",
      }}
    >
      {claims.map((claim, i) => (
        <div key={`${claim.type}-${i}`} style={{ display: "flex", gap: 10 }}>
          <span
            style={{
              fontFamily: "var(--w-mono)",
              fontSize: "var(--w-t-xs)",
              color: "var(--w-muted)",
              minWidth: 160,
            }}
          >
            {claim.type}
          </span>
          <span style={{ fontSize: "var(--w-t-sm)" }}>{renderValue(claim.value)}</span>
        </div>
      ))}
      {detail.data.notes && (
        <span style={{ fontSize: "var(--w-t-xs)", color: "var(--w-faint)" }}>
          Your note: {detail.data.notes}
        </span>
      )}
      {history.length > 0 && (
        <div style={{ display: "grid", gap: 4 }}>
          <strong style={{ fontSize: "var(--w-t-xs)", color: "var(--w-muted)" }}>
            What they said before
          </strong>
          {history.map((rev) => (
            <div key={rev.rev} style={{ fontSize: "var(--w-t-xs)", color: "var(--w-faint)" }}>
              revision {rev.rev} · {rev.receivedAt} ·{" "}
              {(rev.document?.claims ?? [])
                .map((c) => `${c.type}: ${renderValue(c.value)}`)
                .join(", ")}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Someone else's value, rendered.
 *
 * Whatever shape it arrived in is shown as that shape rather than coerced: a
 * number they sent as a string is still what they said.
 */
function renderValue(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** Recording what someone told the holder. */
function RecordContact({
  parties,
  contextId,
  personaDid,
  onDone,
  onCancel,
}: {
  parties: Parties;
  contextId: string;
  personaDid: string | null;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [subjectDid, setSubjectDid] = useState("");
  const [facts, setFacts] = useState<FactDraft[]>([{ type: "", value: "" }]);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setFact = (i: number, patch: Partial<FactDraft>) =>
    setFacts((rows) => rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const save = async () => {
    if (personaDid === null) return;
    const filled = facts.filter((f) => f.type.trim() !== "" || f.value.trim() !== "");
    // Half a row is a typo, not a fact. Refused here rather than filed as
    // something they did not say.
    if (filled.some((f) => f.type.trim() === "" || f.value.trim() === "")) {
      setError("Each fact needs both what it is and what they said.");
      return;
    }
    if (subjectDid.trim() === "" || filled.length === 0) {
      setError("Whose card is this, and what did they tell you?");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await putContact(managerSender, {
        ...parties,
        contextId,
        subjectDid: subjectDid.trim(),
        knownByPersona: personaDid,
        document: {
          // Typed as a string and nothing more. The holder is copying what a
          // peer showed them, so asserting a richer type — or any provenance —
          // would be this console claiming something nobody said.
          claims: filled.map((f) => ({
            type: f.type.trim(),
            valueType: "string" as const,
            value: f.value.trim(),
          })),
        },
        ...(notes.trim() === "" ? {} : { notes: notes.trim() }),
      });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: "grid", gap: 8 }}>
      <Note tone="accent">
        This is your note of what they said. Nothing here is signed by them, and your agent does not
        treat it as though it were.
      </Note>
      <label style={{ display: "grid", gap: 4, fontSize: "var(--w-t-xs)", color: "var(--w-muted)" }}>
        Their DID
        <input
          value={subjectDid}
          onChange={(e) => setSubjectDid(e.target.value)}
          style={{ font: "inherit", fontFamily: "var(--w-mono)", fontSize: "var(--w-t-sm)" }}
        />
      </label>
      {facts.map((f, i) => (
        <div key={i} style={{ display: "flex", gap: 8 }}>
          <input
            placeholder="what it is (name.display)"
            value={f.type}
            onChange={(e) => setFact(i, { type: e.target.value })}
            style={{ font: "inherit", fontFamily: "var(--w-mono)", fontSize: "var(--w-t-sm)", flex: 1 }}
          />
          <input
            placeholder="what they said"
            value={f.value}
            onChange={(e) => setFact(i, { value: e.target.value })}
            style={{ font: "inherit", fontSize: "var(--w-t-sm)", flex: 1 }}
          />
        </div>
      ))}
      <div style={{ display: "flex", gap: 8 }}>
        <Button kind="quiet" onClick={() => setFacts((r) => [...r, { type: "", value: "" }])}>
          Add a fact
        </Button>
      </div>
      <label style={{ display: "grid", gap: 4, fontSize: "var(--w-t-xs)", color: "var(--w-muted)" }}>
        Your note — never disclosed
        <input
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          style={{ font: "inherit", fontSize: "var(--w-t-sm)" }}
        />
      </label>
      {error && <Note tone="danger">{error}</Note>}
      <div style={{ display: "flex", gap: 8 }}>
        <Button onClick={() => void save()} disabled={busy}>
          {busy ? "Recording…" : "Record"}
        </Button>
        <Button kind="quiet" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
