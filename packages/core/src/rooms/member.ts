// Which member a rooms request acts as, when the member's VTA holds more than one.
//
// Its own module, imported by `index.ts`, `act.ts` and `files.ts` alike, so
// none of them pulls in another's task URIs.

/**
 * The `ext` namespace in which a request names the member it acts as, and in
 * which `rooms/keys/list` says whose each entry is. The VTA's
 * (`vta-service` `room_member::MEMBER_EXT`).
 *
 * One VTA can hold two members of one room — an administrator whose VTA also
 * holds the community's own place in a room the community owns, or a person
 * with two personas in it. Then `rooms/keys/list` lists the room once per
 * member, and every custody task (`browse`, `read`, `open`, `file-key`,
 * `backfill`, `chain`) is refused unless the request says which member it
 * acts as: the VTA never picks one. `rooms/keys/act` names the member in its
 * document's `issuer` instead.
 */
export const ROOMS_MEMBER_EXT = "org.openvtc.rooms" as const;

/** `ext` naming the member a custody task acts as, or nothing when no member is named. */
export function memberExt(member: string | undefined): { ext?: { [ROOMS_MEMBER_EXT]: { member: string } } } {
  return member === undefined ? {} : { ext: { [ROOMS_MEMBER_EXT]: { member } } };
}
