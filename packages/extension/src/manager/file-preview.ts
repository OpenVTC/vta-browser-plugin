// What a verified room file may be shown as, decided by its bytes.
//
// A file's media type is its author's claim, and `room-files.ts` types every
// download `application/octet-stream` so that no member can choose how the
// console handles their file. A preview keeps that rule: it is chosen from the
// **verified bytes**, never from the record, and only from a short list of
// forms that cannot do anything when drawn.
//
// - **Raster images** (PNG, JPEG, GIF, WebP), recognised by their signature and
//   drawn in an `<img>`, which runs nothing. SVG is deliberately not one: it is
//   markup, and the check that would make it safe is the kind that goes wrong.
// - **Plain text** that decodes as UTF-8 with no control characters, drawn as
//   a text node.
//
// Nothing else is previewed — PDF and office documents included. A `blob:` URL
// made here carries the extension's own origin, so framing one is handing the
// file that origin; a download is the honest way to open them.

export type PreviewKind = "png" | "jpeg" | "gif" | "webp" | "text";

/** The largest file a thumbnail is fetched for without being asked. */
export const AUTO_PREVIEW_MAX_BYTES = 2 * 1024 * 1024;

/** The most text a preview shows; the rest is the download. */
export const TEXT_PREVIEW_MAX_CHARS = 20_000;

const IMAGE_TYPE: Record<Exclude<PreviewKind, "text">, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

const starts = (b: Uint8Array, sig: readonly number[], at = 0) => sig.every((x, i) => b[at + i] === x);
const ascii = (s: string) => [...s].map((ch) => ch.charCodeAt(0));

/** What these bytes may be drawn as, or `null` for download only. */
export function previewKind(bytes: Uint8Array): PreviewKind | null {
  if (starts(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (starts(bytes, [0xff, 0xd8, 0xff])) return "jpeg";
  if (starts(bytes, ascii("GIF87a")) || starts(bytes, ascii("GIF89a"))) return "gif";
  if (starts(bytes, ascii("RIFF")) && starts(bytes, ascii("WEBP"), 8)) return "webp";
  return textOf(bytes) === null ? null : "text";
}

/** The bytes as text, if they are plain text: UTF-8, no control characters but tab and newlines. */
export function textOf(bytes: Uint8Array): string | null {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text) ? null : text;
}

/** A blob of `bytes` typed by what they were recognised as — never by the author's claim. */
export function imageBlob(bytes: Uint8Array, kind: Exclude<PreviewKind, "text">): Blob {
  return new Blob([bytes as BlobPart], { type: IMAGE_TYPE[kind] });
}

/**
 * Whether the record's own account makes a preview worth fetching unasked.
 * Only a hint for *whether to fetch*: what is drawn is still decided by the
 * bytes, so a record that lies here gets a download button, not a rendering.
 */
export function worthAutoPreview(claim: { size: number; mediaType?: string; name: string }): boolean {
  if (claim.size > AUTO_PREVIEW_MAX_BYTES) return false;
  const type = claim.mediaType?.toLowerCase() ?? "";
  return /^image\/(png|jpeg|gif|webp)$/.test(type) || /\.(png|jpe?g|gif|webp)$/i.test(claim.name);
}

/** Whether a Preview button is worth offering at all, from the record's account. */
export function mayPreview(claim: { mediaType?: string; name: string }): boolean {
  const type = claim.mediaType?.toLowerCase() ?? "";
  return (
    /^image\/(png|jpeg|gif|webp)$/.test(type) ||
    type.startsWith("text/") ||
    type === "application/json" ||
    /\.(png|jpe?g|gif|webp|txt|md|csv|json|log)$/i.test(claim.name)
  );
}
