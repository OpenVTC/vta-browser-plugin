// Issuing in a room's name — the owner's side of admitting someone.
//
// Three verbs that all mean "the room says so", and the reason they are three
// rather than one is the whole membership model:
//
//   - An **invitation** is consent. Without it an owner seals a room key to
//     somebody's agent and they are simply *in* — holding keys to material they
//     may not want, having agreed to nothing, and on a `private` room with
//     nobody outside able to tell them they are there. Single-use, consumed on
//     entry.
//   - A **membership credential** is what a member presents afterwards. It does
//     not collapse into the invitation: a VIC names its subject, so presenting
//     one per access would disclose the member to the host on every read, which
//     is exactly what the sealed tiers exist to prevent.
//   - An **authority credential** is what they may *do*. Membership is not
//     permission — a room admits a party and then says separately whether they
//     may write, curate, or admin.
//
// ## Nothing here is stored, by anyone
//
// The agent signs and returns; it keeps no record of having issued, because a
// room's membership and authority live in the credentials themselves and a list
// kept here would be the roster the design keeps away from any single party.
//
// The consequence is real and belongs on screen rather than in a comment: **the
// owner is the only party who knows what they have issued.** That is invariant
// I1 working as intended — a room has an accountable party and this is one of
// the things they are accountable for — but an owner who closes this screen
// without keeping the credential has lost it, and nothing can reissue the same
// one.
//
// ## Why the signing key is typed in rather than looked up
//
// Nothing maps a room's DID to the key it was minted with. Inventing that
// mapping would add a lifecycle to get wrong: a binding that goes stale, or
// disagrees with the DID document after a rotation. A wrong key here produces a
// credential that fails to verify against the room's DID document — loud, and at
// first use rather than silently.

import { useCallback, useState } from "react";
import {
  roomsOwnerInvite,
  roomsOwnerIssueAuthority,
  roomsOwnerIssueMembership,
  type IssuedCredential,
  type RoomAction,
} from "@openvtc/pnm-core/rooms";
import { Button, Note, Panel } from "../../ui.js";
import { c, t, font } from "../../theme.js";
import { managerSender } from "../sender.js";
import { ConsentRequiredError } from "../carrier.js";
import { ConsentCeremony, runMutation } from "../destructive.js";
import type { Parties } from "../use-vta.js";

const fieldStyle: React.CSSProperties = {
  boxSizing: "border-box",
  padding: "6px 9px",
  background: c.ground,
  color: c.text,
  border: `1px solid ${c.line}`,
  borderRadius: "var(--w-r-sm)",
  fontSize: t.sm,
};

type Verb = "invite" | "membership" | "authority";

const VERBS: { id: Verb; label: string; what: string }[] = [
  {
    id: "invite",
    label: "Invitation",
    what:
      "Single-use, and consumed on entry. This is what makes joining an act the " +
      "invitee agrees to rather than something done to them.",
  },
  {
    id: "membership",
    label: "Membership",
    what:
      "What the member presents afterwards. Separate from the invitation because a " +
      "credential naming its subject, presented on every access, would disclose the " +
      "member to the host each time.",
  },
  {
    id: "authority",
    label: "Authority",
    what:
      "What they may do. Membership admits a party; this says whether they may write, " +
      "curate, or admin — a room can admit someone who may only read.",
  },
];

const ACTIONS: { id: RoomAction; hint: string }[] = [
  { id: "read", hint: "open records" },
  { id: "write", hint: "add and change them" },
  { id: "curate", hint: "retract them — its own authority, not implied by write" },
  { id: "admin", hint: "mint epochs, which is how a member is removed" },
];

/**
 * The issued credential, kept on screen until the owner dismisses it.
 *
 * Not a toast. Nothing else holds a copy — not this console, not the agent —
 * so a notification that fades is a credential destroyed.
 */
function Issued({ issued, onDone }: { issued: IssuedCredential; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <Note tone="accent">
      <p style={{ margin: "0 0 6px" }}>
        Signed. <strong>Keep this — nothing else has a copy.</strong> The agent signed
        and returned it without recording that it did, because a room's membership lives
        in its credentials rather than in a list any one party holds.
      </p>
      <div
        style={{
          fontFamily: font.mono,
          fontSize: t.xs,
          wordBreak: "break-all",
          maxHeight: "7rem",
          overflowY: "auto",
          padding: "6px 8px",
          background: c.ground,
          border: `1px solid ${c.line}`,
          borderRadius: "var(--w-r-sm)",
        }}
      >
        {issued.credential}
      </div>
      <p style={{ margin: "6px 0 0", fontFamily: font.mono, fontSize: t.xs, color: c.muted }}>
        {issued.credentialId}
      </p>
      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
        <Button
          onClick={() => {
            void navigator.clipboard.writeText(issued.credential).then(() => setCopied(true));
          }}
        >
          {copied ? "Copied" : "Copy credential"}
        </Button>
        <Button onClick={onDone}>Done</Button>
      </div>
    </Note>
  );
}

export function IssueInRoomsName({ parties }: { parties: Parties }) {
  const [verb, setVerb] = useState<Verb>("invite");
  const [roomId, setRoomId] = useState("");
  const [signingKeyId, setSigningKeyId] = useState("");
  const [subject, setSubject] = useState("");
  const [validUntil, setValidUntil] = useState("");
  const [actions, setActions] = useState<RoomAction[]>(["read"]);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<ConsentRequiredError | null>(null);
  const [issued, setIssued] = useState<IssuedCredential | null>(null);

  const toggle = (a: RoomAction) =>
    setActions((prev) => (prev.includes(a) ? prev.filter((x) => x !== a) : [...prev, a]));

  const missing = !roomId.trim()
    ? "Name the room this is issued in the name of."
    : !signingKeyId.trim()
      ? "Name the held key that signs as the room — it is not looked up from the room's DID."
      : !subject.trim()
        ? "Name the party this is for."
        : verb === "authority" && actions.length === 0
          ? "An authority credential conferring nothing is a credential with no purpose. Choose at least one action."
          : null;

  const submit = useCallback(async () => {
    setBusy(true);
    setError(null);
    setPending(null);
    setIssued(null);

    const common = {
      ...parties,
      roomId: roomId.trim(),
      signingKeyId: signingKeyId.trim(),
      subject: subject.trim(),
      ...(validUntil.trim() ? { validUntil: new Date(validUntil).toISOString() } : {}),
    };

    await runMutation(
      async () => {
        const res =
          verb === "invite"
            ? await roomsOwnerInvite(managerSender, common)
            : verb === "membership"
              ? await roomsOwnerIssueMembership(managerSender, common)
              : await roomsOwnerIssueAuthority(managerSender, { ...common, actions });
        setIssued(res);
      },
      { onConsent: setPending, onError: setError },
    );
    setBusy(false);
  }, [parties, verb, roomId, signingKeyId, subject, validUntil, actions]);

  const chosen = VERBS.find((v) => v.id === verb)!;

  return (
    <Panel
      title="Issue in a room's name"
      description="Your agent signs as the room, with a key it holds — the key never leaves it,
        and this console never sees one. What comes back is the only copy."
    >
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
        {VERBS.map((v) => (
          <label key={v.id} style={{ display: "flex", gap: 6, alignItems: "center", fontSize: t.sm }}>
            <input type="radio" checked={verb === v.id} onChange={() => setVerb(v.id)} />
            {v.label}
          </label>
        ))}
      </div>
      <p style={{ margin: 0, fontSize: t.sm, color: c.muted }}>{chosen.what}</p>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
        <label style={{ display: "grid", gap: 4, flex: "1 1 20rem" }}>
          <span style={{ fontSize: t.xs, color: c.muted }}>ROOM DID</span>
          <input style={fieldStyle} value={roomId} onChange={(e) => setRoomId(e.target.value)} />
        </label>
        <label style={{ display: "grid", gap: 4, flex: "1 1 12rem" }}>
          <span style={{ fontSize: t.xs, color: c.muted }}>
            SIGNING KEY ID{" "}
            <span style={{ color: c.faint }}>— not derived from the DID</span>
          </span>
          <input
            style={fieldStyle}
            value={signingKeyId}
            onChange={(e) => setSigningKeyId(e.target.value)}
          />
        </label>
      </div>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
        <label style={{ display: "grid", gap: 4, flex: "1 1 20rem" }}>
          <span style={{ fontSize: t.xs, color: c.muted }}>
            {verb === "invite" ? "INVITEE" : "SUBJECT"}
          </span>
          <input style={fieldStyle} value={subject} onChange={(e) => setSubject(e.target.value)} />
        </label>
        <label style={{ display: "grid", gap: 4 }}>
          <span style={{ fontSize: t.xs, color: c.muted }}>
            VALID UNTIL <span style={{ color: c.faint }}>(optional)</span>
          </span>
          <input
            type="datetime-local"
            style={fieldStyle}
            value={validUntil}
            onChange={(e) => setValidUntil(e.target.value)}
          />
        </label>
      </div>

      {verb === "invite" && !validUntil.trim() && (
        <Note tone="warn">
          An invitation with no expiry is a standing right to enter, held by whoever ends up
          with the bytes. It is single-use, so it cannot admit two people — but it has no
          deadline by which it stops admitting one.
        </Note>
      )}

      {verb === "authority" && (
        <div style={{ display: "grid", gap: 6 }}>
          <span style={{ fontSize: t.xs, color: c.muted }}>ACTIONS</span>
          <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
            {ACTIONS.map((a) => (
              <label
                key={a.id}
                style={{ display: "flex", gap: 6, alignItems: "center", fontSize: t.sm }}
              >
                <input
                  type="checkbox"
                  checked={actions.includes(a.id)}
                  onChange={() => toggle(a.id)}
                />
                {a.id} <span style={{ color: c.faint }}>— {a.hint}</span>
              </label>
            ))}
          </div>
          {actions.includes("admin") && (
            <Note tone="warn">
              <strong>admin</strong> mints epochs, and minting an epoch is how a member is
              removed. A party holding it can remove any other — including the owner's own
              agents — by declining to seal the new key to them.
            </Note>
          )}
        </div>
      )}

      {issued && <Issued issued={issued} onDone={() => setIssued(null)} />}
      {error && <Note tone="danger">{error}</Note>}
      {pending && <ConsentCeremony pending={pending} />}

      <div>
        <Button kind="primary" disabled={busy || Boolean(missing)} onClick={() => void submit()}>
          {busy ? "Signing…" : `Issue ${chosen.label.toLowerCase()}`}
        </Button>
        {missing && (
          <span style={{ marginLeft: 10, fontSize: t.sm, color: c.muted }}>{missing}</span>
        )}
      </div>

      <Note>
        Delivery is yours to arrange, and on a `private` room it matters: routing an
        invitation through the host would tell it who was asked, which is the one fact that
        tier is built to withhold.
      </Note>
    </Panel>
  );
}
