// Fetching a room's history — the repair for a room that reads only from where
// its holder joined.
//
// The list pane names that state and, until the agent could reach a host, could
// not fix it. What is missing there is the **epoch key chain**: each commit
// seals the outgoing epoch's storage key under the incoming one, so a holder of
// the current key can walk backwards to every earlier one. A member who joined
// at epoch 7 was handed the key for 7 and nothing below it.
//
// ## One call, and the reason it is one
//
// Three things have to happen — mint a presentation, ask the host for the rungs,
// store what comes back — and this console can do the first and third and not
// the second. Its bridge carries a task type and a payload and addresses
// everything to the wallet's own VTA, so a document naming a host never travels.
// `rooms/keys/backfill` asks the agent to do all three, being the party that has
// a channel to the host and already holds the credentials and the group state.
//
// ## Why it asks for the host
//
// The agent does not know it. `rooms/keys/list` reports key custody — what this
// VTA can open — and hosting is a different fact it has no view of. That is not
// an oversight: a room is portable, so a remembered host would go stale the
// moment the room moved, and the member learned the host from whoever invited
// them.

import { useCallback, useState } from "react";
import { roomsKeysBackfill, type HeldRoom } from "@openvtc/pnm-core/rooms";
import { Button, Note } from "../../ui.js";
import { c, t } from "../../theme.js";
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

interface Outcome {
  earliestReadableEpoch: number;
  fetched: number;
  stored: number;
}

/**
 * What happened, read from the three numbers together.
 *
 * They come apart, and each combination means something different — which is
 * the whole reason the response carries three rather than one. Reporting
 * `stored` alone would celebrate over a room that still cannot open a word of
 * its history.
 */
function Result({ outcome, room }: { outcome: Outcome; room: HeldRoom }) {
  // Nothing served: the host holds no rungs below what this agent already
  // reads. Either the room's history begins there or it was severed before this
  // member joined — indistinguishable from here, and neither is a failure.
  if (outcome.fetched === 0) {
    return (
      <Note>
        The host served no rungs below what your agent already holds. There is
        nothing further to fetch from it: either this room's history begins here,
        or it was severed before your agent joined.
      </Note>
    );
  }

  if (outcome.earliestReadableEpoch <= 1) {
    return (
      <Note tone="accent">
        The whole history is readable now — {outcome.stored} new{" "}
        {outcome.stored === 1 ? "rung" : "rungs"} of {outcome.fetched} served.
      </Note>
    );
  }

  // Rungs arrived and the reach did not move: they sit below a gap. Early
  // rather than wrong — they become useful the moment the gap is filled — so
  // this must not read as loss.
  if (outcome.earliestReadableEpoch >= room.earliestReadableEpoch) {
    return (
      <Note tone="warn">
        {outcome.fetched} {outcome.fetched === 1 ? "rung" : "rungs"} arrived and the
        readable range did not move — it still starts at epoch{" "}
        {outcome.earliestReadableEpoch}. A rung only extends reach when every rung
        above it is present, so this is a gap in what the host served rather than
        history that is gone. Asking again is the repair.
      </Note>
    );
  }

  return (
    <Note tone="accent">
      Readable back to epoch {outcome.earliestReadableEpoch} now, from {outcome.stored}{" "}
      new {outcome.stored === 1 ? "rung" : "rungs"}. Anything older was either
      severed deliberately or has not been served — from here the two look the same.
    </Note>
  );
}

export function FetchHistory({
  parties,
  room,
  onFetched,
}: {
  parties: Parties;
  room: HeldRoom;
  onFetched: () => void;
}) {
  const [hostDid, setHostDid] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<ConsentRequiredError | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const run = useCallback(async () => {
    const host = hostDid.trim();
    if (!host) return;
    setBusy(true);
    setError(null);
    setPending(null);
    setOutcome(null);

    await runMutation(
      async () => {
        const res = await roomsKeysBackfill(managerSender, {
          ...parties,
          roomId: room.roomId,
          host,
          // Ask only for what is missing. The agent reads to
          // `earliestReadableEpoch` already, so the rung below it is where the
          // useful part of the chain starts.
          fromEpoch: Math.max(1, room.earliestReadableEpoch - 1),
        });
        setOutcome({
          earliestReadableEpoch: res.earliestReadableEpoch,
          fetched: res.fetched ?? 0,
          stored: res.stored ?? 0,
        });
      },
      { onConsent: setPending, onError: setError },
    );
    setBusy(false);
    onFetched();
  }, [parties, room, hostDid, onFetched]);

  return (
    <div style={{ display: "grid", gap: 8, marginTop: 10 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
        <label style={{ display: "grid", gap: 4, flex: "1 1 22rem" }}>
          <span style={{ fontSize: t.xs, color: c.muted }}>
            HOST DID <span style={{ color: c.faint }}>— who serves this room</span>
          </span>
          <input
            style={fieldStyle}
            value={hostDid}
            onChange={(e) => setHostDid(e.target.value)}
          />
        </label>
        <Button disabled={busy || !hostDid.trim()} onClick={() => void run()}>
          {busy ? "Fetching…" : "Fetch the history"}
        </Button>
      </div>

      <p style={{ margin: 0, fontSize: t.xs, color: c.faint }}>
        Your agent knows which rooms it can open, not who stores them — a room can
        change hosts without anything it holds changing, so it does not keep one.
        It presents your credentials to the host itself; they do not pass through
        this console.
      </p>

      {outcome && <Result outcome={outcome} room={room} />}
      {error && <Note tone="danger">{error}</Note>}
      {pending && <ConsentCeremony pending={pending} />}
    </div>
  );
}
