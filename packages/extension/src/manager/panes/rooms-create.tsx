// Making a room: an identity, then a host, in that order.
//
// **A room is a DID, not a row in a host's table.** That is the whole reason
// this form has two halves rather than one field. The room's own identity
// issues the credentials that govern it, and a host authorises every operation
// against those credentials rather than against anything it stores — so the
// room is portable. Re-point it at another host and the room has moved, with no
// credential reissued and nothing to migrate.
//
// Which is why the identity is minted (or supplied) **first**, and the host is
// told about a room that already exists. The reverse order would be a host
// handing out an identifier, and a room whose name came from its host is a room
// that cannot leave.
//
// ## The pair, and why both halves are asked for
//
// Minting returns `did` **and** `signingKeyId`, and every `rooms/owner/*` task
// needs both: the VTA signs *as* the room with a key it holds, and the key is
// **named, not looked up** — nothing maps a DID to the key it was minted with,
// and a mapping invented for convenience is one that goes stale after a
// rotation. So a DID without its key identifier is a room that cannot invite
// anyone, and the "I already have one" path asks for both rather than pretending
// the DID alone is enough.
//
// ## The failure that matters
//
// Minting succeeds and registration fails. The DID exists, it is real, and it is
// the only copy of something the operator cannot re-derive — so the form must
// not swallow it. `Minted` stays on screen with both halves after any failure
// below it, and the flow switches to the existing-identity path pre-filled, so
// the retry registers the room that was minted rather than minting a second one.

import { useCallback, useEffect, useState } from "react";
import { roomsOwnerRegister } from "@openvtc/pnm-core/rooms";
import { webvhDidCreate } from "@openvtc/pnm-core/webvh";
import { webvhServerList } from "@openvtc/pnm-core/webvh";
import type { WebvhServerRecord } from "@openvtc/pnm-core/webvh";
import type { ContextRecord } from "@openvtc/pnm-core";
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

/** The two halves of a room's identity. Neither is useful alone. */
export interface RoomIdentity {
  did: string;
  signingKeyId: string;
}

function Label({ children, hint }: { children: string; hint?: string }) {
  return (
    <span style={{ fontSize: t.xs, color: c.muted }}>
      {children}
      {hint ? <span style={{ color: c.faint }}> {hint}</span> : null}
    </span>
  );
}

/**
 * What was minted, kept on screen.
 *
 * Not a receipt — a recovery. `signingKeyId` is the half an operator does not
 * think to write down, and it is the half that cannot be recovered from the DID
 * document: the document names a verification method, and which *held key* that
 * is, is a fact only the minting response carried.
 */
function Minted({ identity }: { identity: RoomIdentity }) {
  return (
    <Note tone="accent">
      <p style={{ margin: "0 0 6px" }}>
        The room's identity exists. Keep both halves — the key identifier is not
        recoverable from the DID document, and without it nothing can issue in this
        room's name.
      </p>
      <div style={{ display: "grid", gap: 3, fontFamily: font.mono, fontSize: t.xs }}>
        <span style={{ wordBreak: "break-all" }}>{identity.did}</span>
        <span style={{ wordBreak: "break-all" }}>{identity.signingKeyId}</span>
      </div>
    </Note>
  );
}

export function CreateRoom({
  parties,
  contexts,
  onCreated,
}: {
  parties: Parties;
  contexts: ContextRecord[];
  onCreated: () => void;
}) {
  // `mint` or `existing`. The default is `mint` because the common case is a
  // room that does not exist yet, and offering "paste a DID" first invites
  // pasting the *agent's* DID, which would make the agent the room.
  const [source, setSource] = useState<"mint" | "existing">("mint");
  const [contextId, setContextId] = useState("");
  const [serverId, setServerId] = useState("");
  const [mediatorDid, setMediatorDid] = useState("");
  const [existing, setExisting] = useState<RoomIdentity>({ did: "", signingKeyId: "" });

  const [hostDid, setHostDid] = useState("");
  const [visibility, setVisibility] = useState<"open" | "attributed" | "private">("private");
  const [retentionDays, setRetentionDays] = useState("");

  const [servers, setServers] = useState<WebvhServerRecord[] | null>(null);
  const [serversError, setServersError] = useState<string | null>(null);
  const [minted, setMinted] = useState<RoomIdentity | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<ConsentRequiredError | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const res = await webvhServerList(managerSender, { ...parties });
        if (live) setServers(res.servers ?? []);
      } catch (e) {
        if (live) setServersError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      live = false;
    };
  }, [parties]);

  const identity: RoomIdentity | null =
    source === "existing"
      ? existing.did.trim() && existing.signingKeyId.trim()
        ? { did: existing.did.trim(), signingKeyId: existing.signingKeyId.trim() }
        : null
      : null;

  // Everything the *chosen* path needs, and nothing it does not: a form that
  // greys its button without saying which field is missing is a form people
  // fill in twice.
  const missing =
    source === "mint"
      ? !contextId
        ? "Choose the context the room's DID belongs to."
        : !serverId
          ? "Choose a hosting server to publish the DID's log through."
          : !mediatorDid.trim()
            ? "The room needs a mediator DID — it is what makes the room addressable, so an invitation or an epoch notice can reach it."
            : null
      : !identity
        ? "A room's identity is a DID and the identifier of the key that signs for it. Both."
        : null;

  const hostMissing = !hostDid.trim() ? "Name the host that will serve this room's records." : null;

  const submit = useCallback(async () => {
    setBusy(true);
    setError(null);
    setPending(null);

    // ── Half one: the identity ──
    let room = identity;
    if (!room) {
      const ok = await runMutation(
        async () => {
          const res = await webvhDidCreate(managerSender, {
            ...parties,
            contextId,
            serverId,
            template: "room",
            // `WEBVH_SERVER` is one of the `room` template's `requiredVars` and
            // its document substitutes it nowhere — so it is passed to satisfy
            // the render, while `serverId` above is what actually decides where
            // the log is published. Dropping either one fails, differently.
            templateVars: { WEBVH_SERVER: serverId, MEDIATOR_DID: mediatorDid.trim() },
          });
          room = { did: res.did, signingKeyId: res.signingKeyId };
          setMinted(room);
        },
        { onConsent: setPending, onError: setError },
      );
      if (!ok || !room) {
        setBusy(false);
        return;
      }
      // Carry the minted pair into the existing-identity path *before* the
      // registration is attempted. If the call below fails, the retry then
      // registers this room rather than minting a second one — which is the
      // difference between one orphaned DID and a new one on every press.
      setExisting(room);
      setSource("existing");
    }

    // ── Half two: tell a host ──
    const ok = await runMutation(
      async () => {
        // Through the agent, not straight at the host. This console addresses
        // every task to the wallet's own VTA — its bridge carries a type and a
        // payload and nothing else — so `rooms/create` composed here would name
        // a host that never travels and land at an agent that does not serve it.
        // `rooms/owner/register` is the same registration asked of the party
        // that can make the call.
        await roomsOwnerRegister(managerSender, {
          ...parties,
          roomId: room!.did,
          host: hostDid.trim(),
          ownerDid: parties.holder.did,
          visibility,
          ...(retentionDays.trim() ? { retentionDays: Number(retentionDays.trim()) } : {}),
        });
      },
      { onConsent: setPending, onError: setError },
    );
    setBusy(false);
    if (ok) {
      setMinted(null);
      setExisting({ did: "", signingKeyId: "" });
      setSource("mint");
      setHostDid("");
      onCreated();
    }
  }, [
    parties, identity, contextId, serverId, mediatorDid, hostDid, visibility, retentionDays,
    onCreated,
  ]);

  return (
    <Panel
      title="New room"
      description="A room is its own DID. It issues the credentials that govern it, and a host
        authorises against those rather than against anything it stores — so the room can move
        hosts without a credential being reissued."
    >
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
        <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: t.sm }}>
          <input
            type="radio"
            checked={source === "mint"}
            onChange={() => setSource("mint")}
          />
          Mint an identity for this room
        </label>
        <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: t.sm }}>
          <input
            type="radio"
            checked={source === "existing"}
            onChange={() => setSource("existing")}
          />
          I already have one
        </label>
      </div>

      {source === "mint" ? (
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
          <label style={{ display: "grid", gap: 4 }}>
            <Label hint="— deleting it destroys the room's identity">CONTEXT</Label>
            <select
              style={fieldStyle}
              value={contextId}
              onChange={(e) => setContextId(e.target.value)}
            >
              <option value="">Choose…</option>
              {contexts.map((ctx) => (
                <option key={ctx.id} value={ctx.id}>
                  {ctx.name ? `${ctx.name} (${ctx.id})` : ctx.id}
                </option>
              ))}
            </select>
          </label>
          <label style={{ display: "grid", gap: 4 }}>
            <Label>HOSTING SERVER</Label>
            <select
              style={fieldStyle}
              value={serverId}
              onChange={(e) => setServerId(e.target.value)}
              disabled={servers === null}
            >
              <option value="">{servers === null ? "Reading…" : "Choose…"}</option>
              {(servers ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label ? `${s.label} (${s.id})` : s.id}
                </option>
              ))}
            </select>
          </label>
          <label style={{ display: "grid", gap: 4, flex: "1 1 22rem" }}>
            <Label hint="— what makes the room addressable">MEDIATOR DID</Label>
            <input
              style={fieldStyle}
              value={mediatorDid}
              onChange={(e) => setMediatorDid(e.target.value)}
            />
          </label>
        </div>
      ) : (
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
          <label style={{ display: "grid", gap: 4, flex: "1 1 22rem" }}>
            <Label>ROOM DID</Label>
            <input
              style={fieldStyle}
              value={existing.did}
              onChange={(e) => setExisting((p) => ({ ...p, did: e.target.value }))}
            />
          </label>
          <label style={{ display: "grid", gap: 4, flex: "1 1 14rem" }}>
            <Label hint="— the held key that signs as the room">SIGNING KEY ID</Label>
            <input
              style={fieldStyle}
              value={existing.signingKeyId}
              onChange={(e) => setExisting((p) => ({ ...p, signingKeyId: e.target.value }))}
            />
          </label>
        </div>
      )}

      {serversError && (
        <Note tone="warn">
          The list of hosting servers could not be read ({serversError}), so this form cannot
          offer one. That is a failure to ask, not an agent with none registered.
        </Note>
      )}

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
        <label style={{ display: "grid", gap: 4, flex: "1 1 22rem" }}>
          <Label hint="— serves the records, and never holds a key">HOST DID</Label>
          <input style={fieldStyle} value={hostDid} onChange={(e) => setHostDid(e.target.value)} />
        </label>
        <label style={{ display: "grid", gap: 4 }}>
          <Label>VISIBILITY</Label>
          <select
            style={fieldStyle}
            value={visibility}
            onChange={(e) => setVisibility(e.target.value as typeof visibility)}
          >
            <option value="private">private — the host cannot see the membership</option>
            <option value="attributed">attributed — the host sees who wrote what</option>
            <option value="open">open — records are stored in the clear</option>
          </select>
        </label>
        <label style={{ display: "grid", gap: 4 }}>
          <Label hint="(optional)">RETENTION DAYS</Label>
          <input
            style={{ ...fieldStyle, width: "7rem" }}
            value={retentionDays}
            inputMode="numeric"
            onChange={(e) => setRetentionDays(e.target.value)}
          />
        </label>
      </div>

      {visibility === "open" && (
        <Note tone="warn">
          On an <strong>open</strong> room the host stores record bodies in the clear and can read
          every one of them. Choose it when the room's contents are meant to be public to its host,
          not merely when encryption seems like a complication.
        </Note>
      )}

      {minted && <Minted identity={minted} />}
      {error && <Note tone="danger">{error}</Note>}
      {pending && <ConsentCeremony pending={pending} />}

      <div>
        <Button
          kind="primary"
          disabled={busy || Boolean(missing) || Boolean(hostMissing)}
          onClick={() => void submit()}
        >
          {busy ? "Working…" : minted ? "Register with the host" : "Create room"}
        </Button>
        {(missing ?? hostMissing) && (
          <span style={{ marginLeft: 10, fontSize: t.sm, color: c.muted }}>
            {missing ?? hostMissing}
          </span>
        )}
      </div>
    </Panel>
  );
}
