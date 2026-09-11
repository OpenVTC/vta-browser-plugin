// Making a room: a context, its host, the room's own identity, what the host sees.
//
// **A room is a DID, not a row in a host's table.** The room's own identity
// issues the credentials that govern it, and a host authorises every operation
// against those credentials rather than against anything it stores — so the
// room is portable. Re-point it at another host and the room has moved, with no
// credential reissued and nothing to migrate.
//
// ## One context, and two kinds of DID in it
//
// The host and its rooms — one host, many rooms — live in one context, and what
// keeps them apart is which DID is the **context's own** (`ctx.did`):
//
// - **The host is the context's DID.** A room-host enrolled into a context
//   fetches that context's DID and keys from the agent (`vta/contexts/secrets`)
//   and serves as it. So "which DID will the host be" has exactly one answer,
//   and step 2 is about making it the right one: use the one the context has,
//   make another of its DIDs the context's (`vta/contexts/update-did`), mint one
//   with `setPrimary: true`, or name a host run elsewhere.
// - **Every room is a DID beside it**, minted with `setPrimary: false`.
//
// That `false` is load-bearing and was missing. `dids/create` defaults it to
// `true` and overwrites whatever the context acted as, so every room this form
// minted before it became its context's DID — and a host enrolled there would
// have come up serving *as the room*. Nothing on the screen or the wire looked
// wrong when it happened.
//
// Sharing a context does not hand the host a room's keys. The host's grant is
// `application`; exporting a key needs admin, `contexts/secrets` releases only
// the context DID's keys, and `keys/sign` at `application` signs under an opaque
// domain that verifies as nothing but an opaque-signing payload — not as a proof
// on a room's credential.
//
// ## A new host is a step you finish
//
// Minting a host's DID is not having a host. room-host has to be started,
// enrolled, granted and restarted before a room can be registered with it, and
// registration is the first thing that would notice otherwise — as an opaque
// internal error from the agent. So after minting, the form prints what to run,
// and holds the later steps closed until the operator says the host is running.
// That is their confirmation, not a check, and the form says so.
//
// ## The host needs a URL, today
//
// `vta-service` can only initiate a call to a host over REST (`OUTBOUND_SUPPORTED`
// in its `operations/room_host.rs`), so a host with no URL cannot be registered.
// The mediator is for members: room-host started with `--mediator-did` serves
// DIDComm and TSP there. The `room-host` template advertises the mediator for
// DIDComm only, and the agent does not apply `addTspService` to a
// template-rendered document — so a minted host DID publishes no TSP entry,
// which is a gap in the template rather than a choice this form can make.
//
// ## Screen order and wire order
//
// The screen asks for the host before the room; the wire still mints the room's
// identity before any host is told about it. A room whose name came from its
// host is a room that cannot leave.
//
// ## The pair, and the failure that matters
//
// Every `rooms/owner/*` task needs the room's DID **and** the identifier of the
// key that signs as it. This agent names a minted DID's signing key
// `{did}#key-0`, so an existing room's keys are offered from the context's key
// records by that prefix — a convention of this agent rather than a contract,
// which is why typing one stays possible.
//
// Minting can succeed and registration fail. The DID is real and the key
// identifier is the half nobody writes down, so `Minted` keeps both on screen
// and the flow switches to the existing-identity path pre-filled: the retry
// registers that room rather than minting a second one.

import { useCallback, useEffect, useId, useState } from "react";
import { roomsOwnerRegister } from "@openvtc/pnm-core/rooms";
import { webvhDidCreate, webvhDidList, webvhServerList } from "@openvtc/pnm-core/webvh";
import type { WebvhDidRecord, WebvhServerRecord } from "@openvtc/pnm-core/webvh";
import { keysList, servicesList } from "@openvtc/pnm-core/admin";
import { contextsUpdateDid, type ContextRecord } from "@openvtc/pnm-core";
import { Button, Did, Note, Panel } from "../../ui.js";
import { c, t, font } from "../../theme.js";
import { managerSender } from "../sender.js";
import { ConsentRequiredError } from "../carrier.js";
import { ConsentCeremony, runMutation } from "../destructive.js";
import { contextHeading } from "../format.js";
import { pathProblem } from "../webvh-path.js";
import { coveringWildcard, hostGrantCommand, hostnameOf, roomHostCommand } from "../room-host-setup.js";
import type { Parties } from "../use-vta.js";
import {
  agentMediators,
  Choice,
  choices,
  commandStyle,
  ContextSelect,
  Field,
  fieldStyle,
  Label,
  MediatorPicker,
  PathPicker,
  pathMode,
  row,
  SERVER_CHOOSES,
  ServerSelect,
  Step,
  type AgentMediator,
  type PathChoice,
} from "./rooms-create-parts.js";

/** The two halves of a room's identity. Neither is useful alone. */
export interface RoomIdentity {
  did: string;
  signingKeyId: string;
}

type Visibility = "open" | "attributed" | "private";

const VISIBILITY: { value: Visibility; title: string; detail: string }[] = [
  {
    value: "private",
    title: "Private",
    detail: "The host cannot see who the members are. The right default unless you have a reason.",
  },
  {
    value: "attributed",
    title: "Attributed",
    detail: "The host sees which member wrote each record.",
  },
  {
    value: "open",
    title: "Open",
    detail: "The host stores records in the clear and can read all of them.",
  },
];

/** How step 2 arrives at the host's DID. */
type HostSource = "context" | "pick" | "mint" | "paste";

type KeyRecord = Awaited<ReturnType<typeof keysList>>["keys"][number];

/** A select's "none of these — let me type it" entry. */
const OTHER = "__other__";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * What an operator does to bring room-host up as `hostDid`.
 *
 * `url` and `mediatorDid` are known only for a host this form minted; for a DID
 * that already existed the steps say where to look instead of guessing.
 */
function HostSetup({
  agentDid,
  context,
  hostDid,
  url,
  mediatorDid,
}: {
  agentDid: string;
  context: ContextRecord | { id: string; name?: undefined };
  hostDid: string;
  url?: string | undefined;
  mediatorDid?: string | undefined;
}) {
  const hostname = url ? hostnameOf(url) : null;
  const wildcard = hostname ? coveringWildcard(hostname) : null;
  const contextName = "basePath" in context ? contextHeading(context, context.id) : context.id;
  return (
    <ol style={{ margin: 0, paddingLeft: 20, display: "grid", gap: 10, fontSize: t.sm, lineHeight: 1.55 }}>
      <li>
        Serve it over HTTPS {url ? <>at <code>{url}</code></> : "at the URL its DID publishes"}, with a
        certificate valid for {hostname ? <code>{hostname}</code> : "that hostname"}
        {wildcard ? (
          <>
            {" "}— by name, or by <code>{wildcard}</code>. A wildcard covers one label only, so a
            wildcard further up does not
          </>
        ) : null}
        . room-host listens on plain HTTP, so the certificate belongs on whatever sits in front of it.
      </li>
      <li>
        Start room-host enrolled with this agent — a build with the <code>onboarding</code> and{" "}
        <code>didcomm</code> features:
        <pre style={commandStyle}>{roomHostCommand({ agentDid, context: context.id, mediatorDid })}</pre>
        On its first start it prints a throwaway <code>did:key</code> and waits to be authorised.
      </li>
      <li>
        Grant that <code>did:key</code> the <em>application</em> role on {contextName}, from the Access
        pane or with:
        <pre style={commandStyle}>{hostGrantCommand(context.id)}</pre>
        Application, and only on this context: the host holds ciphertext it cannot read, and needs to
        act here, not govern it.
      </li>
      <li>
        Start it again. It fetches this context&apos;s DID and keys from your agent and serves as{" "}
        <Did value={hostDid} size={t.xs} />.
      </li>
    </ol>
  );
}

/**
 * What was minted, kept on screen.
 *
 * Not a receipt — a recovery. `signingKeyId` is the half an operator does not
 * think to write down.
 */
function Minted({ identity }: { identity: RoomIdentity }) {
  return (
    <Note tone="accent">
      <p style={{ margin: "0 0 6px" }}>
        The room's identity exists. Keep both halves — without the key identifier nothing can issue
        in this room's name.
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
  // ── Step 1: the context ──
  const [contextId, setContextId] = useState("");
  // Context DIDs this form has set, so step 2 reads what it just wrote rather
  // than the list the pane loaded before the write.
  const [contextDids, setContextDids] = useState<Record<string, string>>({});

  // ── Step 2: the host ──
  // `null` until the operator picks, and then it resolves from the context: use
  // its DID where it has one, mint one where it does not.
  const [hostChoice, setHostChoice] = useState<HostSource | null>(null);
  const [hostPick, setHostPick] = useState("");
  const [hostPasted, setHostPasted] = useState("");
  const [hostServer, setHostServer] = useState("");
  const [hostUrl, setHostUrl] = useState("");
  const [hostMediator, setHostMediator] = useState("");
  const [hostPath, setHostPath] = useState<PathChoice>(SERVER_CHOOSES);
  const [hostBusy, setHostBusy] = useState(false);
  const [hostError, setHostError] = useState<string | null>(null);
  const [hostMinted, setHostMinted] = useState<
    { did: string; contextId: string; url: string; mediatorDid: string } | null
  >(null);
  const [hostConfirmed, setHostConfirmed] = useState(false);

  // ── Step 3: the room's identity ──
  // `mint` by default: offering "use an existing DID" first invites choosing
  // the host's, which would make the host the room.
  const [source, setSource] = useState<"mint" | "existing">("mint");
  const [serverId, setServerId] = useState("");
  const [mediatorDid, setMediatorDid] = useState("");
  // A mediator seeded from the host never replaces one picked on purpose.
  const [mediatorChosen, setMediatorChosen] = useState(false);
  const [roomPath, setRoomPath] = useState<PathChoice>(SERVER_CHOOSES);
  const [existing, setExisting] = useState<RoomIdentity>({ did: "", signingKeyId: "" });
  const [pasteRoom, setPasteRoom] = useState(false);
  const [typeKey, setTypeKey] = useState(false);

  // ── Step 4: what the host sees ──
  const [visibility, setVisibility] = useState<Visibility>("private");
  const [retentionDays, setRetentionDays] = useState("");

  const [servers, setServers] = useState<WebvhServerRecord[] | null>(null);
  const [serversError, setServersError] = useState<string | null>(null);
  const [mediators, setMediators] = useState<AgentMediator[] | null>(null);
  const [mediatorsError, setMediatorsError] = useState<string | null>(null);
  const [dids, setDids] = useState<WebvhDidRecord[] | null>(null);
  const [didsError, setDidsError] = useState<string | null>(null);
  const [keys, setKeys] = useState<KeyRecord[] | null>(null);
  const [keysError, setKeysError] = useState<string | null>(null);
  const [listsVersion, setListsVersion] = useState(0);
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
        if (live) setServersError(message(e));
      }
    })();
    return () => {
      live = false;
    };
  }, [parties]);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const found = agentMediators(await servicesList(managerSender, { ...parties }));
        if (!live) return;
        setMediators(found);
        // Chosen for the operator, visibly — the card is highlighted and one
        // click from "a different mediator". Only an advertised one: preselecting
        // a mediator the agent has switched off would be choosing a dead path.
        const usual = found.find((m) => m.enabled)?.did;
        if (usual) {
          setHostMediator((p) => p || usual);
          setMediatorDid((p) => p || usual);
        }
      } catch (e) {
        if (live) setMediatorsError(message(e));
      }
    })();
    return () => {
      live = false;
    };
  }, [parties]);

  // The context's DIDs and keys: the host step offers its DIDs, the room step
  // offers them and their signing keys. Read together, reported apart — a key
  // listing that failed must not hide DIDs that were read.
  useEffect(() => {
    if (!contextId) return;
    let live = true;
    setDids(null);
    setDidsError(null);
    setKeys(null);
    setKeysError(null);
    void (async () => {
      const [d, k] = await Promise.allSettled([
        webvhDidList(managerSender, { ...parties, contextId }),
        keysList(managerSender, { ...parties, contextId, status: "active" }),
      ]);
      if (!live) return;
      if (d.status === "fulfilled") setDids(d.value.dids ?? []);
      else setDidsError(message(d.reason));
      if (k.status === "fulfilled") setKeys(k.value.keys);
      else setKeysError(message(k.reason));
    })();
    return () => {
      live = false;
    };
  }, [parties, contextId, listsVersion]);

  const context = contexts.find((x) => x.id === contextId);
  const contextName = context ? contextHeading(context, contextId) : contextId;
  const contextDid = contextDids[contextId] ?? context?.did ?? "";
  const hostSource: HostSource = hostChoice ?? (contextDid ? "context" : "mint");

  // The DID the room is registered with, once step 2 has settled on one.
  const hostDid =
    hostSource === "context"
      ? contextDid
      : hostSource === "pick"
        ? hostPick && hostPick === contextDid ? hostPick : ""
        : hostSource === "mint"
          ? hostMinted && hostConfirmed && hostMinted.contextId === contextId && hostMinted.did === contextDid
            ? hostMinted.did
            : ""
          : hostPasted.trim();

  const pickableHosts = (dids ?? []).filter((d) => d.did !== contextDid && d.did !== parties.service.did);
  const roomChoices = (dids ?? []).filter(
    (d) => d.did !== contextDid && d.did !== hostDid && d.did !== parties.service.did,
  );
  const signingKeysOf = (did: string) =>
    (keys ?? []).filter((k) => k.keyId.startsWith(`${did}#`) && k.status === "active" && k.keyType !== "x25519");

  const identity: RoomIdentity | null =
    source === "existing" && existing.did.trim() && existing.signingKeyId.trim()
      ? { did: existing.did.trim(), signingKeyId: existing.signingKeyId.trim() }
      : null;

  const retention = retentionDays.trim();
  const retentionBad = retention !== "" && !/^[1-9]\d*$/.test(retention);
  const roomPathProblem = roomPath.named ? pathProblem(roomPath.path) : null;
  const hostPathProblem = hostPath.named ? pathProblem(hostPath.path) : null;

  // Everything the *chosen* path needs, each naming its step, the earliest
  // speaking first — so the hint reads top to bottom the way the form does.
  const contextMissing = !contextId ? "Step 1: choose the context the host and its rooms live in." : null;

  const hostMissing = !contextId
    ? null
    : hostSource === "context"
      ? contextDid ? null : "Step 2: this context has no DID yet — mint one for the host."
      : hostSource === "pick"
        ? !hostPick
          ? "Step 2: choose which of this context's DIDs is the host."
          : hostPick !== contextDid
            ? "Step 2: make that DID this context's own, so a host enrolled here serves as it."
            : null
        : hostSource === "mint"
          ? !hostMinted || hostMinted.contextId !== contextId
            ? "Step 2: mint the host's DID, or use one this context already has."
            : !hostConfirmed
              ? "Step 2: finish setting up the host, then confirm it is running."
              : null
          : !hostPasted.trim()
            ? "Step 2: paste the DID of the host."
            : null;

  const missing =
    source === "mint"
      ? !serverId
        ? "Step 3: choose a hosting server to publish the room's DID through."
        : !mediatorDid.trim()
          ? "Step 3: the room needs a mediator — it is what makes the room addressable, so an invitation or an epoch notice can reach it."
          : roomPathProblem
            ? `Step 3: ${roomPathProblem}`
            : null
      : !identity
        ? "Step 3: a room's identity is a DID and the identifier of the key that signs for it. Both."
        : identity.did === hostDid || identity.did === contextDid
          ? "Step 3: that DID is the host's. A room needs a DID of its own."
          : null;

  const retentionMissing = retentionBad ? "Step 4: retention is a whole number of days, or empty." : null;

  const blocked = contextMissing ?? hostMissing ?? missing ?? retentionMissing;

  const hostMintMissing = !hostServer
    ? "Choose a hosting server to publish the host's DID through."
    : !hostUrl.trim()
      ? "The host needs a URL: your agent reaches hosts over REST only."
      : !hostMediator.trim()
        ? "Choose a mediator for the host's DID to publish."
        : hostPathProblem;

  // Mint the host's DID as this context's own.
  //
  // `setPrimary: true` said rather than defaulted: this is the one mint on this
  // form that must replace the context's identity, and a reader should not have
  // to know the agent's default to see that.
  //
  // Deliberately does NOT start, enrol or grant anything. Those are the steps
  // the setup panel prints, because they are someone's decision at a terminal.
  const mintHost = useCallback(async () => {
    setHostBusy(true);
    setHostError(null);
    await runMutation(
      async () => {
        const res = await webvhDidCreate(managerSender, {
          ...parties,
          contextId,
          serverId: hostServer,
          setPrimary: true,
          ...pathMode(hostPath),
          template: "room-host",
          templateVars: {
            WEBVH_SERVER: hostServer,
            URL: hostUrl.trim(),
            MEDIATOR_DID: hostMediator.trim(),
          },
        });
        setContextDids((p) => ({ ...p, [contextId]: res.did }));
        setHostMinted({ did: res.did, contextId, url: hostUrl.trim(), mediatorDid: hostMediator.trim() });
        setHostConfirmed(false);
        // Pinned, because with a DID in hand the default would now resolve to
        // "use the context's DID" and walk away from the setup still owed.
        setHostChoice("mint");
        // A room is usually published where its host is, behind the same
        // mediator. Seeded, never over a choice made on purpose.
        setServerId((p) => p || hostServer);
        if (!mediatorChosen) setMediatorDid(hostMediator.trim());
        setListsVersion((v) => v + 1);
      },
      { onConsent: setPending, onError: setHostError },
    );
    setHostBusy(false);
  }, [parties, contextId, hostServer, hostUrl, hostMediator, hostPath, mediatorChosen]);

  // Make an existing DID in this context the context's own — the host's.
  const makeHost = useCallback(async () => {
    setHostBusy(true);
    setHostError(null);
    await runMutation(
      async () => {
        await contextsUpdateDid(managerSender, { ...parties, id: contextId, did: hostPick });
        setContextDids((p) => ({ ...p, [contextId]: hostPick }));
      },
      { onConsent: setPending, onError: setHostError },
    );
    setHostBusy(false);
  }, [parties, contextId, hostPick]);

  const submit = useCallback(async () => {
    setBusy(true);
    setError(null);
    setPending(null);

    // ── The room's identity, before any host hears of it ──
    let room = identity;
    if (!room) {
      const ok = await runMutation(
        async () => {
          const res = await webvhDidCreate(managerSender, {
            ...parties,
            contextId,
            serverId,
            // Beside the host's DID, never in place of it. See the header.
            setPrimary: false,
            ...pathMode(roomPath),
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
      // registration is attempted, so a retry registers this room rather than
      // minting a second one.
      setExisting(room);
      setSource("existing");
      setListsVersion((v) => v + 1);
    }

    // ── Then tell the host ──
    const ok = await runMutation(
      async () => {
        // Through the agent, not straight at the host: this console's bridge
        // addresses every task to the wallet's own VTA, and
        // `rooms/owner/register` is the registration asked of the party that
        // can make the call.
        await roomsOwnerRegister(managerSender, {
          ...parties,
          roomId: room!.did,
          host: hostDid,
          ownerDid: parties.holder.did,
          visibility,
          ...(retention ? { retentionDays: Number(retention) } : {}),
        });
      },
      { onConsent: setPending, onError: setError },
    );
    setBusy(false);
    if (ok) {
      setMinted(null);
      setExisting({ did: "", signingKeyId: "" });
      setSource("mint");
      setPasteRoom(false);
      setTypeKey(false);
      // A name is one room's; kept, the next room would ask for a taken path.
      setRoomPath(SERVER_CHOOSES);
      setListsVersion((v) => v + 1);
      onCreated();
    }
  }, [
    parties, identity, contextId, serverId, roomPath, mediatorDid, hostDid, visibility, retention,
    onCreated,
  ]);

  const serverName = (id: string) => servers?.find((x) => x.id === id)?.label ?? id;

  // A step is ticked only once every step before it is, and a step whose
  // predecessor is not ready stays closed.
  const stepOneReady = !contextMissing;
  const stepTwoReady = stepOneReady && !hostMissing;
  const stepThreeReady = stepTwoReady && !missing;
  const stepFourReady = stepThreeReady && !retentionBad;
  const hostLock = !stepOneReady ? "Choose the context first." : null;
  const roomLock = !stepOneReady
    ? "Choose the context first."
    : !stepTwoReady
      ? "Finish step 2 first — a room is registered with its host, so the host comes first."
      : null;

  const hostGroup = useId();
  const identityGroup = useId();
  const visibilityGroup = useId();

  const roomListed = roomChoices.some((d) => d.did === existing.did);
  const pickingRoom = !pasteRoom && !didsError && (existing.did === "" || roomListed);
  const keyChoices = signingKeysOf(existing.did);
  const pickingKey =
    !typeKey && !keysError && keyChoices.length > 0 &&
    (existing.signingKeyId === "" || keyChoices.some((k) => k.keyId === existing.signingKeyId));

  return (
    <Panel
      title="New room"
      description="Four decisions, in order: the context the host and its rooms live in, the host,
        the room's own identity, and how much the host can see. Each step opens once the one before
        it is ready."
    >
      {serversError && (
        <Note tone="warn">
          The list of hosting servers could not be read ({serversError}), so this form cannot
          offer one. That is a failure to ask, not an agent with none registered.
        </Note>
      )}

      <div style={{ display: "grid", marginTop: 4 }}>
        <Step
          n={1}
          title="Choose the context"
          done={stepOneReady}
          why="A host and the rooms it serves live in one context. The context's own DID is the
            host's identity, and every room gets a DID of its own beside it. Choosing the context
            first lets the form offer the DIDs already there."
        >
          <Field label="CONTEXT" hint="— deleting it destroys the host's and every room's identity">
            <ContextSelect
              name="Context"
              options={contexts}
              value={contextId}
              onChange={(id) => {
                setContextId(id);
                // Everything below was a choice about the previous context.
                setHostChoice(null);
                setHostPick("");
                setHostConfirmed(false);
                setExisting({ did: "", signingKeyId: "" });
                setPasteRoom(false);
                setTypeKey(false);
              }}
            />
          </Field>
        </Step>

        <Step
          n={2}
          title="Set up the host"
          done={stepTwoReady}
          locked={hostLock}
          why="A host stores the room's records and serves them to members; it never holds a room key.
            A room-host enrolled into a context serves as that context's own DID — so the host is
            whichever DID this context has, and this step makes sure that is the right one."
        >
          <div style={choices}>
            {contextDid && (
              <Choice
                name={hostGroup}
                value="host-context"
                checked={hostSource === "context"}
                onSelect={() => setHostChoice("context")}
                title="This context's DID is the host"
              >
                <Did value={contextDid} size={t.xs} />
                <span>A room-host enrolled into {contextName} serves as it.</span>
              </Choice>
            )}
            <Choice
              name={hostGroup}
              value="host-pick"
              checked={hostSource === "pick"}
              onSelect={() => setHostChoice("pick")}
              title="Make another of its DIDs the host"
            >
              For a host DID that exists in this context but is not the context&apos;s DID.
            </Choice>
            <Choice
              name={hostGroup}
              value="host-mint"
              checked={hostSource === "mint"}
              onSelect={() => setHostChoice("mint")}
              title={contextDid ? "Mint a new host DID" : "Mint the host's DID"}
            >
              {contextDid
                ? "It replaces the DID above as this context's identity. The next steps wait until you say the host is running."
                : "It becomes this context's identity. The next steps wait until you say the host is running."}
            </Choice>
            <Choice
              name={hostGroup}
              value="host-paste"
              checked={hostSource === "paste"}
              onSelect={() => setHostChoice("paste")}
              title="A host run outside this agent"
            >
              Paste its DID. It must publish a URL — your agent reaches hosts over REST only.
            </Choice>
          </div>

          {hostSource === "context" && contextDid && (
            <>
              <Note tone="warn">
                <strong>Check this is your host&apos;s DID.</strong> Your agent does not record what a
                DID is for, and until this form said otherwise, minting a room made the room its
                context&apos;s DID. If that happened here, choose <em>Make another of its DIDs the
                host</em>.
              </Note>
              <details style={{ fontSize: t.sm }}>
                <summary style={{ cursor: "pointer", color: c.accent }}>Host not running yet? How to start it</summary>
                <div style={{ marginTop: 8 }}>
                  <HostSetup agentDid={parties.service.did} context={context ?? { id: contextId }} hostDid={contextDid} />
                </div>
              </details>
            </>
          )}

          {hostSource === "pick" && (
            <div style={{ display: "grid", gap: 8 }}>
              {didsError ? (
                <Note tone="warn">
                  This context&apos;s DIDs could not be read ({didsError}). That is a failure to ask,
                  not a context without any.
                </Note>
              ) : (
                <Field label="HOST DID" hint="— one of this context's DIDs" grow="1 1 22rem">
                  <select
                    aria-label="Host DID in context"
                    style={fieldStyle}
                    value={hostPick}
                    disabled={dids === null}
                    onChange={(e) => setHostPick(e.target.value)}
                  >
                    <option value="">{dids === null ? "Reading…" : pickableHosts.length ? "Choose…" : "No other DIDs in this context"}</option>
                    {pickableHosts.map((d) => (
                      <option key={d.did} value={d.did}>
                        {d.did}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
              {hostPick && hostPick === contextDid ? (
                <>
                  <Note tone="accent">
                    <Did value={hostPick} size={t.xs} /> is now {contextName}&apos;s DID. A room-host
                    enrolled here serves as it from its next start.
                  </Note>
                  <details style={{ fontSize: t.sm }}>
                    <summary style={{ cursor: "pointer", color: c.accent }}>Host not running yet? How to start it</summary>
                    <div style={{ marginTop: 8 }}>
                      <HostSetup agentDid={parties.service.did} context={context ?? { id: contextId }} hostDid={hostPick} />
                    </div>
                  </details>
                </>
              ) : (
                <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                  <Button onClick={() => void makeHost()} disabled={!hostPick || hostBusy}>
                    {hostBusy ? "Setting…" : "Make it this context's DID"}
                  </Button>
                  <span style={{ fontSize: t.sm, color: c.muted }}>
                    A host already running as {contextDid ? "the current DID" : "this context"} changes
                    identity when it next starts.
                  </span>
                </div>
              )}
              {hostError && <Note tone="warn">{hostError}</Note>}
            </div>
          )}

          {hostSource === "mint" && !(hostMinted && hostMinted.contextId === contextId) && (
            <div
              style={{
                display: "grid",
                gap: 10,
                padding: "12px 14px",
                border: `1px dashed ${c.line}`,
                borderRadius: "var(--w-r-sm)",
              }}
            >
              <p style={{ margin: 0, fontSize: t.sm, color: c.muted, lineHeight: 1.55, maxWidth: "82ch" }}>
                Your agent mints the host&apos;s DID from the <code>room-host</code> template as this
                context&apos;s own DID — the identity room-host serves as once enrolled. It publishes
                two ways in. <strong>The URL is what your agent uses, and it is required</strong>: your
                agent calls hosts over REST only. The mediator is for members — a host started with{" "}
                <code>--mediator-did</code> answers DIDComm and TSP there, though the template
                advertises it for DIDComm only.
              </p>
              {contextDid && (
                <Note tone="warn">
                  {contextName} already acts as <Did value={contextDid} size={t.xs} />. Minting makes
                  the new DID its identity instead, and a host already serving from this context
                  changes identity when it next starts.
                </Note>
              )}
              <div style={row}>
                <Field label="HOSTING SERVER" hint="— publishes the host's DID">
                  <ServerSelect name="Host hosting server" servers={servers} value={hostServer} onChange={setHostServer} />
                </Field>
                <Field label="HOST URL" hint="— required; where it serves records over HTTPS" grow="1 1 16rem">
                  <input
                    aria-label="Host URL"
                    style={fieldStyle}
                    value={hostUrl}
                    placeholder="https://…"
                    onChange={(e) => setHostUrl(e.target.value)}
                  />
                </Field>
              </div>
              <PathPicker name="Host DID path" example="room-host" value={hostPath} onChange={setHostPath} />
              <div style={{ display: "grid", gap: 6 }}>
                <Label hint="— where members reach a host started with --mediator-did">HOST MEDIATOR</Label>
                <MediatorPicker
                  name="Host mediator DID"
                  value={hostMediator}
                  onChange={setHostMediator}
                  known={mediators}
                  knownError={mediatorsError}
                />
              </div>
              {hostError && <Note tone="warn">{hostError}</Note>}
              <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                <Button onClick={() => void mintHost()} disabled={busy || hostBusy || !!hostMintMissing}>
                  {hostBusy ? "Minting…" : "Mint host DID"}
                </Button>
                {hostMintMissing && <span style={{ fontSize: t.sm, color: c.muted }}>{hostMintMissing}</span>}
              </div>
            </div>
          )}

          {hostSource === "mint" && hostMinted && hostMinted.contextId === contextId && (
            <div
              style={{
                display: "grid",
                gap: 12,
                padding: "12px 14px",
                border: `1px solid ${hostConfirmed ? c.line : c.accent}`,
                borderRadius: "var(--w-r-sm)",
              }}
            >
              <Note tone="accent">
                <strong>Host DID minted</strong> — <Did value={hostMinted.did} size={t.xs} /> is now{" "}
                {contextName}&apos;s identity. It is not a running host yet. Finish these, then confirm
                below.
              </Note>
              <HostSetup
                agentDid={parties.service.did}
                context={context ?? { id: contextId }}
                hostDid={hostMinted.did}
                url={hostMinted.url}
                mediatorDid={hostMinted.mediatorDid}
              />
              {hostConfirmed ? (
                <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                  <span style={{ fontSize: t.sm, color: c.ok, fontWeight: 600 }}>You confirmed the host is running.</span>
                  <Button kind="quiet" onClick={() => setHostConfirmed(false)}>
                    Not yet
                  </Button>
                </div>
              ) : (
                <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                  <Button kind="primary" onClick={() => setHostConfirmed(true)}>
                    The host is running — continue
                  </Button>
                  <span style={{ fontSize: t.sm, color: c.muted, maxWidth: "60ch" }}>
                    Your confirmation, not a check. The first real check is registering the room at
                    the end, and if that fails the room&apos;s identity is kept for a retry.
                  </span>
                </div>
              )}
            </div>
          )}

          {hostSource === "paste" && (
            <Field label="HOST DID" hint="— the host's own DID, not its URL" grow="1 1 22rem">
              <input
                aria-label="Host DID"
                style={fieldStyle}
                value={hostPasted}
                onChange={(e) => setHostPasted(e.target.value)}
              />
            </Field>
          )}
        </Step>

        <Step
          n={3}
          title="Give the room its own identity"
          done={stepThreeReady}
          locked={roomLock}
          why="A room is a DID of its own, not an entry in the host's database. It signs the
            invitations and memberships that govern it, so it can move to another host later without
            reissuing any of them. It is minted beside the host's DID in this context — never as the
            context's own DID, which is the host's."
        >
          <div style={choices}>
            <Choice
              name={identityGroup}
              value="mint"
              checked={source === "mint"}
              onSelect={() => setSource("mint")}
              title="Mint a new identity"
            >
              Your agent creates a DID for the room and holds its keys. The usual choice.
            </Choice>
            <Choice
              name={identityGroup}
              value="existing"
              checked={source === "existing"}
              onSelect={() => setSource("existing")}
              title="Use one already minted"
            >
              Pick a DID in this context. Its signing key is offered from your agent&apos;s key records.
            </Choice>
          </div>

          {source === "mint" ? (
            <>
              <Field label="HOSTING SERVER" hint="— publishes the DID so anyone can resolve it">
                <ServerSelect name="Room hosting server" servers={servers} value={serverId} onChange={setServerId} />
              </Field>
              <PathPicker name="Room DID path" example="rooms/northwind" value={roomPath} onChange={setRoomPath} />
              <div style={{ display: "grid", gap: 6 }}>
                <Label hint="— how invitations and epoch notices reach the room">MEDIATOR</Label>
                <MediatorPicker
                  name="Room mediator DID"
                  value={mediatorDid}
                  onChange={(did) => {
                    setMediatorChosen(true);
                    setMediatorDid(did);
                  }}
                  known={mediators}
                  knownError={mediatorsError}
                />
              </div>
            </>
          ) : (
            <div style={{ display: "grid", gap: 8 }}>
              {didsError && (
                <Note tone="warn">
                  This context&apos;s DIDs could not be read ({didsError}), so none can be offered.
                  Enter the room&apos;s DID and signing key instead.
                </Note>
              )}
              <div style={row}>
                <Field label="ROOM DID" grow="1 1 22rem">
                  {pickingRoom ? (
                    <select
                      aria-label="Existing room DID"
                      style={fieldStyle}
                      value={existing.did}
                      disabled={dids === null}
                      onChange={(e) => {
                        const v = e.target.value;
                        setTypeKey(false);
                        if (v === OTHER) {
                          setPasteRoom(true);
                          setExisting({ did: "", signingKeyId: "" });
                          return;
                        }
                        const ks = signingKeysOf(v);
                        setExisting({ did: v, signingKeyId: ks.length === 1 ? ks[0]!.keyId : "" });
                      }}
                    >
                      <option value="">{dids === null ? "Reading…" : "Choose…"}</option>
                      {roomChoices.map((d) => (
                        <option key={d.did} value={d.did}>
                          {d.did}
                        </option>
                      ))}
                      <option value={OTHER}>A DID not listed here — enter it…</option>
                    </select>
                  ) : (
                    <input
                      aria-label="Room DID"
                      style={fieldStyle}
                      value={existing.did}
                      onChange={(e) => setExisting((p) => ({ ...p, did: e.target.value }))}
                    />
                  )}
                </Field>
                {(existing.did || !pickingRoom) && (
                  <Field
                    label="SIGNING KEY"
                    hint={pickingKey ? "— this DID's signing keys, from your agent's records" : "— the held key that signs as the room"}
                    grow="1 1 16rem"
                  >
                    {pickingKey && pickingRoom ? (
                      <select
                        aria-label="Signing key"
                        style={fieldStyle}
                        value={existing.signingKeyId}
                        onChange={(e) => {
                          const v = e.target.value;
                          if (v === OTHER) {
                            setTypeKey(true);
                            setExisting((p) => ({ ...p, signingKeyId: "" }));
                            return;
                          }
                          setExisting((p) => ({ ...p, signingKeyId: v }));
                        }}
                      >
                        <option value="">Choose…</option>
                        {keyChoices.map((k) => (
                          <option key={k.keyId} value={k.keyId}>
                            {k.label ? `${k.keyId} — ${k.label}` : k.keyId}
                          </option>
                        ))}
                        <option value={OTHER}>Another key — enter its ID…</option>
                      </select>
                    ) : (
                      <input
                        aria-label="Signing key ID"
                        style={fieldStyle}
                        value={existing.signingKeyId}
                        onChange={(e) => setExisting((p) => ({ ...p, signingKeyId: e.target.value }))}
                      />
                    )}
                  </Field>
                )}
              </div>
              {pickingRoom && existing.did && keys !== null && !keysError && keyChoices.length === 0 && (
                <span style={{ fontSize: t.xs, color: c.muted }}>
                  None of your agent&apos;s key records names a signing key for this DID. Enter the one
                  it was minted with.
                </span>
              )}
              {keysError && (
                <span style={{ fontSize: t.xs, color: c.muted }}>
                  This context&apos;s keys could not be read ({keysError}), so enter the signing key&apos;s ID.
                </span>
              )}
              {!pickingRoom && !didsError && (
                <Button
                  kind="quiet"
                  onClick={() => {
                    setPasteRoom(false);
                    setTypeKey(false);
                    setExisting({ did: "", signingKeyId: "" });
                  }}
                >
                  Choose from this context&apos;s DIDs instead
                </Button>
              )}
            </div>
          )}
        </Step>

        <Step
          n={4}
          title="Decide how much the host can see"
          done={stepFourReady}
          locked={roomLock}
          last
          why="Visibility is fixed per room and decides what the host learns while serving it.
            Private is the right answer unless the room's contents are meant to be public to its host."
        >
          <div style={choices}>
            {VISIBILITY.map((v) => (
              <Choice
                key={v.value}
                name={visibilityGroup}
                value={v.value}
                checked={visibility === v.value}
                onSelect={() => setVisibility(v.value)}
                title={v.title}
              >
                {v.detail}
              </Choice>
            ))}
          </div>
          {visibility === "open" && (
            <Note tone="warn">
              On an <strong>open</strong> room the host stores record bodies in the clear and can
              read every one of them. Choose it when the room's contents are meant to be public to
              its host, not merely when encryption seems like a complication.
            </Note>
          )}
          <Field label="RETENTION DAYS" hint="(optional) — leave empty for the host's default">
            <input
              aria-label="Retention days"
              style={{ ...fieldStyle, width: "7rem" }}
              value={retentionDays}
              inputMode="numeric"
              onChange={(e) => setRetentionDays(e.target.value)}
            />
          </Field>
        </Step>
      </div>

      <div
        style={{
          display: "grid",
          gap: 6,
          padding: "10px 14px",
          background: c.raised,
          border: `1px solid ${c.lineSoft}`,
          borderRadius: "var(--w-r-sm)",
          fontSize: t.sm,
        }}
      >
        <span style={{ fontSize: t.xs, color: c.muted, fontWeight: 600 }}>
          {minted ? "PRESSING “REGISTER WITH THE HOST” WILL" : "PRESSING “CREATE ROOM” WILL"}
        </span>
        <ol style={{ margin: 0, paddingLeft: 20, display: "grid", gap: 4, lineHeight: 1.55 }}>
          <li>
            {source === "mint" ? (
              <>
                Mint the room&apos;s DID in <strong>{contextId ? contextName : "the chosen context"}</strong>,
                beside the host&apos;s DID rather than in place of it, and publish it through{" "}
                <strong>{serverId ? serverName(serverId) : "the chosen server"}</strong>
                {roomPath.named && roomPath.path && !roomPathProblem ? (
                  <> at <code>{roomPath.path}</code></>
                ) : (
                  <>, at a path the server chooses</>
                )}
                . This is the step that cannot be taken back.
              </>
            ) : (
              <>Mint nothing — the room uses the DID chosen in step 3.</>
            )}
          </li>
          <li>
            Register it with {hostDid ? <Did value={hostDid} size={t.xs} /> : "the host"} as a{" "}
            <strong>{visibility}</strong> room, owned by you. If this fails, the identity is kept and
            the button retries only this.
          </li>
        </ol>
      </div>

      {minted && <Minted identity={minted} />}
      {error && <Note tone="danger">{error}</Note>}
      {pending && <ConsentCeremony pending={pending} />}

      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <Button kind="primary" disabled={busy || Boolean(blocked)} onClick={() => void submit()}>
          {busy ? "Working…" : minted ? "Register with the host" : "Create room"}
        </Button>
        {blocked && <span style={{ fontSize: t.sm, color: c.muted }}>{blocked}</span>}
      </div>
    </Panel>
  );
}
