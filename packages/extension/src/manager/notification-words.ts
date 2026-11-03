// What the console says about a held notification.
//
// A notification states that a thing exists and where; it is no evidence that
// the member may take part (VTI-NTF-004). So the words here say who said so,
// where the thing is held and whom it concerns, and never that the member is
// invited, eligible or expected. A kind this wallet does not recognise is shown
// as existing and nothing more (VTI-NTF-012).
//
// Free of relative imports so it is tested in plain Node.

/** The kinds this wallet can open. Everything else is held, listed and dismissed. */
export const KNOWN_KINDS: Record<string, string> = {
  election: "Election",
};

/** The kind as the member reads it, and whether this wallet knows it. */
export function kindWords(kind: string): { label: string; known: boolean } {
  const known = KNOWN_KINDS[kind];
  return known ? { label: known, known: true } : { label: kind, known: false };
}

function day(iso: string): string {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? iso : new Date(t).toUTCString().replace(/:\d\d GMT$/, " UTC");
}

/** The period a notification states, in words. For an election, the period is
 *  when voting is open (VTI-NTF-060). */
export function periodWords(validFrom: string | undefined, validUntil: string | undefined): string {
  if (validFrom && validUntil) return `${day(validFrom)} until ${day(validUntil)}`;
  if (validUntil) return `until ${day(validUntil)}`;
  if (validFrom) return `from ${day(validFrom)}`;
  return "no period stated";
}

/** Whether the thing can no longer be acted on, by what the notification itself says. */
export function lapsed(status: string, validUntil: string | undefined, now: number): boolean {
  if (status === "withdrawn") return true;
  if (!validUntil) return false;
  const t = Date.parse(validUntil);
  return !Number.isNaN(t) && t <= now;
}

/** What the member is told about a notification of a kind this wallet does not know. */
export const UNKNOWN_KIND_NOTE =
  "This wallet does not know this kind of notification, so it can only show that it exists. " +
  "It will not open it.";

/** What the member is told before presenting their membership to read an election. */
export function presentWords(community: string, audience: string): string {
  return (
    `${community} shows this election only to members of ${audience}. Reading it shows ${community} ` +
    `your membership credential issued by ${audience} — before you have seen the election. ` +
    `Nothing else is shown, and nothing is shown unless you choose to.`
  );
}
