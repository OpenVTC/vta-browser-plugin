// The words the rooms pane uses for a place held in a room — shared by the
// cards and the room detail, so the two never describe one place differently.

import type { HeldRoom } from "@openvtc/pnm-core/rooms";
import { displayAgentName, type AgentName } from "../agent-name.js";
import type { PillTone } from "../theme.js";

/**
 * What the two epochs mean together, in the words a member needs.
 *
 * `epoch` behind the room's own means a commit was not delivered;
 * `earliestReadableEpoch` equal to `epoch` means the epoch key chain has not
 * arrived. Different repairs — and a member shown only "you can't read this"
 * reads a pending delivery as lost history. So each standing says which.
 */
export function standing(room: Pick<HeldRoom, "epoch" | "earliestReadableEpoch">): {
  label: string;
  tone: PillTone;
  why: string;
} {
  if (room.earliestReadableEpoch <= 1) {
    return { label: "whole history", tone: "ok", why: "Every record this room retains can be opened." };
  }
  if (room.earliestReadableEpoch >= room.epoch) {
    return {
      label: "from joining",
      tone: "warn",
      why:
        "Readable from the epoch this agent joined at. Anything written before that needs " +
        "the room's epoch key chain, which has not been delivered here.",
    };
  }
  return {
    label: `back to epoch ${room.earliestReadableEpoch}`,
    tone: "warn",
    why:
      "Part of the chain has arrived. Records older than this epoch were either severed " +
      "deliberately or their rungs were never delivered — from here the two look the same.",
  };
}

/** Who a place acts as, in words: a name its document claims, else the DID shortened. */
export function memberLabel(
  room: Pick<HeldRoom, "member">,
  agentDid: string,
  names: Readonly<Record<string, AgentName>>,
): string {
  if (!room.member) return "member not reported by this agent";
  const name = names[room.member];
  const who = name ? displayAgentName(name) : shortDid(room.member);
  return room.member === agentDid ? `${who} (this agent's own DID)` : who;
}

/** The place a member holds, from the actions its grant confers — a sentence. */
export function placeLabel(room: Pick<HeldRoom, "actions">): string {
  if (!room.actions) return "";
  return room.actions.includes("admin") ? "administers the room" : "member";
}

/** The same, as a pill's one word; empty where the agent did not say. */
export function placeWord(room: Pick<HeldRoom, "actions">): string {
  if (!room.actions) return "";
  return room.actions.includes("admin") ? "admin" : "member";
}

/** A DID cut to fit a line, keeping both ends — the method and the distinctive tail. */
export function shortDid(did: string): string {
  return did.length > 44 ? `${did.slice(0, 22)}…${did.slice(-14)}` : did;
}
