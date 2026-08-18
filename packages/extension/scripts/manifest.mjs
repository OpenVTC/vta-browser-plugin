// Manifest assembly — the single place `dist/manifest.json` is produced.
//
// Two facts drive the shape of this file:
//
//  1. **The version has exactly one source of truth: `package.json`.** Before
//     this script the version lived in three places (root package.json,
//     packages/extension/package.json, public/manifest.json) and all three
//     disagreed. The Chrome Web Store rejects an upload whose version is not
//     strictly greater than the last one it accepted, so a stale hand-edited
//     manifest is a failed submission, not a cosmetic bug. `manifest.json`
//     here is a *template* and deliberately carries no `version` field.
//
//  2. **The `key` field is for local installs only, never for the Store.**
//     The Store owns the signing key: the "+ New item" upload *rejects* a
//     package whose manifest contains `key` ("key field is not allowed in
//     manifest"), and on later uploads it is accepted but ignored. Locally the
//     opposite is true — without `key`, an unpacked extension's ID is derived
//     from its directory path, so it changes across machines and checkouts.
//
//     That ID is not cosmetic here either: `src/holder.ts` uses
//     `chrome.runtime.id` as the WebAuthn PRF rpId, so a moving ID orphans
//     every passkey-wrapped secret, and anything allowlisting
//     `chrome-extension://<id>` (VTA CORS) has to move with it.
//
//     Hence: `buildManifest({ includeKey: true })` for `dist/` (what you load
//     unpacked), `{ includeKey: false }` for the Store zip.

import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/** Package root — this file lives in `<pkg>/scripts/`. */
export const PKG_ROOT = join(import.meta.dirname, "..");

const TEMPLATE_PATH = join(PKG_ROOT, "manifest.json");
const PACKAGE_JSON_PATH = join(PKG_ROOT, "package.json");

/** Committed public key, base64 DER (SPKI). Absent until one is pinned. */
export const PUBLIC_KEY_PATH = join(PKG_ROOT, "extension-key.txt");

/** Private key. Gitignored — never commit, never ship. */
export const PRIVATE_KEY_PATH = join(PKG_ROOT, "extension-key.pem");

/**
 * Chrome's version format: one to four dot-separated integers, each 0–65535,
 * without leading zeros. Notably this rejects every npm prerelease spelling
 * (`0.3.0-rc.1`, `1.0.0+build`), which is the failure worth catching early —
 * the Store's error message for it arrives after an upload, not before.
 */
export function assertChromeVersion(version) {
  const parts = version.split(".");
  const ok =
    parts.length >= 1 &&
    parts.length <= 4 &&
    parts.every(
      (p) =>
        /^\d{1,5}$/.test(p) &&
        (p === "0" || !p.startsWith("0")) &&
        Number(p) <= 65535,
    );
  if (!ok) {
    throw new Error(
      `package.json version "${version}" is not a valid Chrome extension ` +
        `version: expected 1-4 dot-separated integers 0-65535 with no ` +
        `leading zeros and no prerelease/build suffix (e.g. "0.2.0"). ` +
        `The Chrome Web Store rejects the upload otherwise.`,
    );
  }
  return version;
}

/**
 * Derive the extension ID Chrome will assign to a given public key: the first
 * 16 bytes of SHA-256 over the DER bytes, each hex digit mapped 0-f → a-p.
 *
 * Used to prove that a pinned key produces the ID you expect — compare it
 * against the Item ID in the Developer Dashboard after the first upload.
 */
export function extensionIdFromPublicKey(base64Der) {
  const der = Buffer.from(base64Der, "base64");
  const digest = createHash("sha256").update(der).digest("hex").slice(0, 32);
  return [...digest]
    .map((h) => String.fromCharCode(0x61 + Number.parseInt(h, 16)))
    .join("");
}

/** The pinned public key, or null when none has been pinned yet. */
export function readPublicKey() {
  if (!existsSync(PUBLIC_KEY_PATH)) return null;
  // Tolerate a key pasted straight out of the Developer Dashboard's
  // "View public key" panel, which arrives PEM-wrapped and line-broken.
  const raw = readFileSync(PUBLIC_KEY_PATH, "utf8");
  const key = raw
    .replace(/-----(BEGIN|END) PUBLIC KEY-----/g, "")
    .replace(/\s+/g, "");
  return key.length > 0 ? key : null;
}

/**
 * Store listing limits the *manifest* carries. Both are silent locally — Chrome
 * loads an over-long description unpacked without complaint — and both are hard
 * rejections at upload, which is the worst possible place to learn about them.
 *
 * `description` becomes the listing's short description (132 chars); `name` is
 * capped at 75. Enforced here for the same reason as `assertChromeVersion`:
 * this file is the last point where a bad value is still cheap to fix.
 */
export function assertStoreListingLimits({ name, description }) {
  if (typeof name === "string" && name.length > 75) {
    throw new Error(
      `manifest "name" is ${name.length} characters; the Chrome Web Store ` +
        `caps it at 75 and rejects the upload otherwise.`,
    );
  }
  if (typeof description === "string" && description.length > 132) {
    throw new Error(
      `manifest "description" is ${description.length} characters; the Chrome ` +
        `Web Store caps it at 132 (it is the listing's short description) and ` +
        `rejects the upload otherwise. Trim it in manifest.json.`,
    );
  }
}

/**
 * Assemble the manifest. `includeKey` decides whether the pinned `key` is
 * emitted; see the header — `true` for local `dist/`, `false` for the Store.
 */
export function buildManifest({ includeKey }) {
  const template = JSON.parse(readFileSync(TEMPLATE_PATH, "utf8"));
  const pkg = JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf8"));

  if ("version" in template) {
    throw new Error(
      `${TEMPLATE_PATH} declares a "version". It must not: the version comes ` +
        `from package.json so the two cannot drift. Remove it.`,
    );
  }

  const version = assertChromeVersion(pkg.version);
  const key = includeKey ? readPublicKey() : null;

  // Rebuild rather than spread-and-append so the emitted field order stays
  // readable (manifest_version, name, version, key, …) in diffs and in the
  // Store's package viewer.
  const { manifest_version, name, ...rest } = template;
  const manifest = {
    manifest_version,
    name,
    version,
    ...(key ? { key } : {}),
    ...rest,
  };
  assertStoreListingLimits(manifest);
  return manifest;
}
