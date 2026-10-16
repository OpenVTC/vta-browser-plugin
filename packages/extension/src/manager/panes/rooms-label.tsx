// Your own name for a room — `rooms/keys/label`.
//
// A room's DID says nothing, and the names others give it — the room's own
// profile, the label on a community's offer — are theirs. A personal label is
// the member's: a name, a description, notes and tags, kept by their VTA beside
// the room's keys, for one member of one room. Nobody else ever sees it.
//
// ## What this form sends, and why it is a patch
//
// The task replaces each detail it is given, removes each one it is told to,
// and leaves the rest. So the form sends only what the member changed against
// what the list showed: a rename typed here does not overwrite notes written on
// another device since. A field emptied is a removal; an unchanged field is not
// sent at all. Removing the last detail removes the label.
//
// ## Where a label may go
//
// To this console and nowhere else. The pane asks for labels
// (`includePersonal`); the member portal's list never does, and nothing a room,
// a host or a community receives carries one.

import { useCallback, useState } from "react";
import { roomsKeysLabel, type HeldRoom, type PersonalLabel, type RoomLabelEdit } from "@openvtc/pnm-core/rooms";
import { Button, Note } from "../../ui.js";
import { c, t } from "../../theme.js";
import { managerSender } from "../sender.js";
import { ConsentRequiredError } from "../carrier.js";
import { ConsentCeremony, runMutation } from "../destructive.js";
import type { Parties } from "../use-vta.js";

const fieldStyle: React.CSSProperties = {
  boxSizing: "border-box",
  width: "100%",
  padding: "6px 9px",
  background: c.ground,
  color: c.text,
  border: `1px solid ${c.line}`,
  borderRadius: "var(--w-r-sm)",
  fontSize: t.sm,
  fontFamily: "inherit",
};

/** The form's fields, as the member typed them. */
export interface LabelForm {
  label: string;
  description: string;
  notes: string;
  /** Comma-separated. */
  tags: string;
}

/** The form a stored label starts from. */
export function formOf(personal: PersonalLabel | undefined): LabelForm {
  return {
    label: personal?.label ?? "",
    description: personal?.description ?? "",
    notes: personal?.notes ?? "",
    tags: (personal?.tags ?? []).join(", "),
  };
}

/** Tags as a set, in the order typed: trimmed, empty ones dropped, repeats once. */
export function tagsOf(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(",")) {
    const tag = raw.trim();
    if (tag && !out.includes(tag)) out.push(tag);
  }
  return out;
}

/**
 * The patch that turns `current` into what the form now says — only what
 * changed, a field emptied being its removal — or `null` when nothing did.
 *
 * Each value is trimmed first (`rooms/keys/label/0.1` producer item 2); tags
 * compare as a set, so reordering them is not a change.
 */
export function labelEdit(current: PersonalLabel | undefined, form: LabelForm): RoomLabelEdit | null {
  const edit: RoomLabelEdit = {};
  for (const key of ["label", "description", "notes"] as const) {
    const was = current?.[key];
    const now = form[key].trim();
    if (now === (was ?? "")) continue;
    if (now) edit[key] = now;
    else if (was !== undefined) {
      if (key === "label") edit.removeLabel = true;
      else if (key === "description") edit.removeDescription = true;
      else edit.removeNotes = true;
    }
  }
  const was: readonly string[] = current?.tags ?? [];
  const now = tagsOf(form.tags);
  const same = was.length === now.length && now.every((tag) => was.includes(tag));
  if (!same) {
    if (now.length > 0) edit.tags = now;
    else edit.removeTags = true;
  }
  return Object.keys(edit).length === 0 ? null : edit;
}

/** Every detail the label holds, removed — forgetting it altogether. */
export function forgetEdit(current: PersonalLabel | undefined): RoomLabelEdit | null {
  if (!current) return null;
  const edit: RoomLabelEdit = {};
  if (current.label !== undefined) edit.removeLabel = true;
  if (current.description !== undefined) edit.removeDescription = true;
  if (current.notes !== undefined) edit.removeNotes = true;
  if (current.tags !== undefined) edit.removeTags = true;
  return Object.keys(edit).length === 0 ? null : edit;
}

export function RoomLabel({
  parties,
  room,
  onSaved,
}: {
  parties: Parties;
  room: HeldRoom;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<LabelForm>(() => formOf(room.personal));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [pending, setPending] = useState<ConsentRequiredError | null>(null);

  const send = useCallback(
    async (edit: RoomLabelEdit | null) => {
      setError(null);
      setDone(null);
      setPending(null);
      if (!edit) {
        setDone("Nothing to change.");
        return;
      }
      setBusy(true);
      await runMutation(
        async () => {
          const res = await roomsKeysLabel(managerSender, {
            ...parties,
            roomId: room.roomId,
            member: room.member,
            ...edit,
          });
          setForm(formOf(res.personal));
          setDone(
            !res.changed
              ? "Your label already said that."
              : res.personal
                ? "Saved — for you alone."
                : "Your label is removed.",
          );
          onSaved();
        },
        { onConsent: setPending, onError: setError },
      );
      setBusy(false);
    },
    [parties, room, onSaved],
  );

  const field = (key: keyof LabelForm, title: string, hint: string, multiline = false) => (
    <label style={{ display: "grid", gap: 4 }}>
      <span style={{ fontSize: t.xs, color: c.muted }}>
        {title} <span style={{ color: c.faint }}>— {hint}</span>
      </span>
      {multiline ? (
        <textarea
          aria-label={title}
          rows={3}
          style={fieldStyle}
          value={form[key]}
          onChange={(e) => setForm({ ...form, [key]: e.target.value })}
        />
      ) : (
        <input
          aria-label={title}
          style={fieldStyle}
          value={form[key]}
          onChange={(e) => setForm({ ...form, [key]: e.target.value })}
        />
      )}
    </label>
  );

  return (
    <div style={{ display: "grid", gap: 8, marginTop: 10 }}>
      <span style={{ fontSize: t.sm, color: c.text }}>Your name for this room</span>
      {field("label", "NAME", "one line, up to 128 characters")}
      {field("description", "DESCRIPTION", "what it is to you", true)}
      {field("notes", "NOTES", "anything worth remembering about it", true)}
      {field("tags", "TAGS", "comma-separated, up to 16")}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Button disabled={busy} onClick={() => void send(labelEdit(room.personal, form))}>
          {busy ? "Saving…" : "Save my label"}
        </Button>
        {room.personal && (
          <Button disabled={busy} onClick={() => void send(forgetEdit(room.personal))}>
            Forget my label
          </Button>
        )}
      </div>
      <p style={{ margin: 0, fontSize: t.xs, color: c.faint }}>
        Kept by your agent for this member of this room, and shown only to you: never sent to
        the room, its host or a community, and never shared with a site unless you choose to.
      </p>
      {done && <Note tone="accent">{done}</Note>}
      {error && <Note tone="danger">{error}</Note>}
      {pending && <ConsentCeremony pending={pending} />}
    </div>
  );
}
