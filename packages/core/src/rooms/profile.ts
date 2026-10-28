// A room's own profile — `rooms/keys/profile/read/0.1`, asked of the member's VTA.
//
// A room's name, description, tags and emoji live inside the room, sealed like
// every record on `attributed` and `private`, at a key only a key holder can
// compute. So the wallet never finds it itself: it asks the member's own VTA,
// which fetches it from the host as the member, opens it, and checks that
// whoever wrote it held `curate` or `admin` — returning the newest profile it
// accepts, and naming any newer one it refused.
//
// Everything in a profile is free text another member wrote. `roomProfileView`
// is the only way a surface should read one: it keeps text as text (control
// characters stripped, bounded), and turns the refusals into the one fact a
// member needs — somebody without the standing to tried to rename the room.

import type { TrustTaskSender } from "../vta/channel.js";
import { buildTrustTask } from "../vta/trust-task.js";
import { memberExt } from "./member.js";

import {
  TYPE_URI as PROFILE_READ,
  RESPONSE_TYPE_URI as PROFILE_READ_RESPONSE,
  type RoomsKeysProfileReadPayload,
  type RoomsKeysProfileReadResponsePayload,
} from "../specs/rooms/keys/profile/read/0.1/payload.js";

export type { RoomsKeysProfileReadResponsePayload as RoomProfileReadResponse };

/**
 * Ask the member's VTA what `roomId` calls itself, read from `host` as
 * `member` (named where the VTA holds more than one member of the room).
 *
 * Cache the answer for the life of a view and do not poll: the profile
 * changes rarely, and an epoch advance (`rooms/keys/list`) is the signal that
 * it may have.
 */
export async function roomsKeysProfileRead(
  sender: TrustTaskSender,
  params: {
    holder: { did: string };
    service: { did: string };
    roomId: string;
    host: string;
    member?: string;
  },
): Promise<RoomsKeysProfileReadResponsePayload> {
  const payload: RoomsKeysProfileReadPayload = {
    roomId: params.roomId,
    host: params.host,
    ...memberExt(params.member),
  };
  const envelope = buildTrustTask(PROFILE_READ, payload, {
    issuer: params.holder.did,
    recipient: params.service.did,
  });
  return sender.send<RoomsKeysProfileReadResponsePayload>(envelope, {
    expectedResponseType: PROFILE_READ_RESPONSE,
    operationLabel: "rooms/keys/profile/read/0.1",
  });
}

/** Bounds a surface keeps profile text to — the schema's own. */
const MAX_NAME = 128;
const MAX_DESCRIPTION = 1000;
const MAX_TAG = 32;
const MAX_EMOJI = 16;

/**
 * `text` as text: control characters (terminal and bidi controls among them)
 * removed — newlines kept only where `multiline` — trimmed, cut to `max`
 * characters. Never markup: callers render the result as a text node.
 */
export function inertText(text: string, max: number, multiline = false): string {
  const kept = [...text]
    .map((ch) => {
      const cp = ch.codePointAt(0) ?? 0;
      if (ch === "\n" && multiline) return ch;
      if (ch === "\n" || ch === "\t") return " ";
      const control = cp < 0x20 || (cp >= 0x7f && cp < 0xa0);
      const bidi = (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069) || cp === 0x200e || cp === 0x200f;
      return control || bidi ? "" : ch;
    })
    .join("")
    .trim();
  return [...kept].slice(0, max).join("");
}

/** A profile's refusal reasons that mean someone tried to rename the room. */
const RENAME_REASONS = new Set(["noAuthority", "timing", "revoked"]);

/** What a surface shows of a room's profile, already inert. */
export interface RoomProfileView {
  status: "found" | "absent" | "cleared";
  name?: string;
  description?: string;
  emoji?: string;
  tags?: string[];
  /** Written before the room's latest epoch advance and not re-written since. */
  stale: boolean;
  /**
   * A newer profile was refused because its author lacked the standing to name
   * the room (`noAuthority`, `timing`, `revoked`): somebody tried to rename it.
   */
  renameRefused: boolean;
  /** Who wrote the refused renames, where the VTA could say. */
  refusedAuthors: string[];
}

/** Read a `rooms/keys/profile/read` answer as a view. Anything it does not recognise is left out. */
export function roomProfileView(res: unknown): RoomProfileView {
  const r = (res && typeof res === "object" ? res : {}) as Record<string, unknown>;
  const status = r.status === "found" || r.status === "cleared" ? r.status : "absent";
  const view: RoomProfileView = { status, stale: false, renameRefused: false, refusedAuthors: [] };
  const p = r.profile as Record<string, unknown> | undefined;
  if (status === "found" && p && typeof p === "object" && typeof p.name === "string") {
    const name = inertText(p.name, MAX_NAME);
    if (name !== "") view.name = name;
    if (typeof p.description === "string") {
      const d = inertText(p.description, MAX_DESCRIPTION, true);
      if (d !== "") view.description = d;
    }
    if (typeof p.emoji === "string") {
      const e = inertText(p.emoji, MAX_EMOJI);
      if (e !== "") view.emoji = e;
    }
    if (Array.isArray(p.tags)) {
      const tags = p.tags
        .filter((t): t is string => typeof t === "string")
        .map((t) => inertText(t, MAX_TAG))
        .filter((t) => t !== "");
      if (tags.length > 0) view.tags = tags;
    }
    view.stale = r.stale === true;
  }
  if (Array.isArray(r.rejected)) {
    for (const item of r.rejected) {
      const i = (item ?? {}) as Record<string, unknown>;
      if (typeof i.reason !== "string" || !RENAME_REASONS.has(i.reason)) continue;
      view.renameRefused = true;
      if (typeof i.author === "string" && i.author.startsWith("did:") && !view.refusedAuthors.includes(i.author)) {
        view.refusedAuthors.push(inertText(i.author, 256));
      }
    }
  }
  return view;
}

/** The sentences a surface owes the member about a profile, beyond its name. */
export function roomProfileNotices(view: RoomProfileView): string[] {
  const out: string[] = [];
  if (view.renameRefused) {
    out.push(
      "Somebody without the standing to name this room tried to rename it. Their change is " +
        "ignored; the name shown is the one a curator or administrator gave it.",
    );
  }
  if (view.stale) {
    out.push("This name predates the room's latest change of keys and has not been written again since; it may be out of date.");
  }
  if (view.status === "cleared") {
    out.push("A curator cleared this room's name.");
  }
  return out;
}
