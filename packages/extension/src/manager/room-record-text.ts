// How an untitled record is named in a listing.
//
// `SealedRecordBody` makes `title` optional, and a chat-style client writes a
// message as `body` alone (Keyring from 277.8). Such a record was listed as
// "Untitled record", so a room of messages read as a column of identical rows.
// Its own first line names it instead, the way a mail client names a message
// with no subject.

/** The longest label drawn from a body, in characters. */
export const LABEL_MAX = 120;

/** Leading markdown that marks up a line rather than saying anything: a heading, a quote, a list bullet. */
const MARKUP = /^\s*(?:#{1,6}(?:\s+|$)|>\s*|[-*+](?:\s+|$))/;

/**
 * An untitled record's label — its first line with something to say, without
 * its markdown marker, at most {@link LABEL_MAX} characters — and the text after
 * that line (from it, when it was cut short), for the preview. `null` when the
 * body says nothing.
 *
 * The text is another member's and untrusted: the caller renders both halves as
 * text, never as markup.
 */
export function untitledLabel(body: string): { label: string; rest: string } | null {
  const lines = body.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.replace(MARKUP, "").trim();
    if (!line) continue;
    const chars = [...line];
    const cut = chars.length > LABEL_MAX;
    const label = cut ? `${chars.slice(0, LABEL_MAX - 1).join("").trimEnd()}…` : line;
    // A line cut short is still read in full: the preview starts with it.
    return { label, rest: lines.slice(cut ? i : i + 1).join("\n").trim() };
  }
  return null;
}
