// When wearing a face in a context ends on its own — `persona/binding/set`
// `until`.
//
// The form edits a local date and time (`<input type="datetime-local">`), and
// the agent takes an RFC 3339 instant. Converting between them is the whole of
// this module, kept out of the component so the edge it is easy to get wrong —
// the holder's own time zone — is tested as a string.
//
// At `until` the agent clears the binding and, if the face is then worn
// nowhere else, retires it. It never deletes it.

/** An RFC 3339 instant as the value a `datetime-local` input shows, in the
 *  holder's own time zone. Empty for no end, or for a value that is not a time. */
export function untilToLocalInput(iso: string | undefined | null): string {
  if (!iso) return "";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}` +
    `T${pad(at.getHours())}:${pad(at.getMinutes())}`
  );
}

/**
 * A `datetime-local` value as the instant the agent takes, or why it cannot be.
 *
 * `null` for an empty field — no end. An end already past is refused here, as
 * the agent would refuse it (`untilNotFuture`), so the holder is told while
 * they can still change it.
 */
export function untilFromLocalInput(
  value: string,
  now: Date = new Date(),
): { ok: true; until: string | null } | { ok: false; why: string } {
  const trimmed = value.trim();
  if (!trimmed) return { ok: true, until: null };
  // A `datetime-local` value has no zone; `new Date` reads it as local time,
  // which is what the holder typed.
  const at = new Date(trimmed);
  if (Number.isNaN(at.getTime())) return { ok: false, why: "That is not a date and time." };
  if (at.getTime() <= now.getTime()) {
    return { ok: false, why: "That time has passed — choose one still to come, or leave it empty." };
  }
  return { ok: true, until: at.toISOString() };
}

/** How an end reads beside a binding: "ends Sat 5 Oct, 18:00". */
export function untilWords(iso: string | undefined | null): string | null {
  if (!iso) return null;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  return `ends ${at.toLocaleString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  })}`;
}
