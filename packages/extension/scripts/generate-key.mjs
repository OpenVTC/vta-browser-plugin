#!/usr/bin/env node
// Pin the extension ID by generating a signing keypair.
//
//   node scripts/generate-key.mjs           # generate, refuse to clobber
//   node scripts/generate-key.mjs --force   # regenerate (changes the ID!)
//   node scripts/generate-key.mjs --show    # print the pinned key's ID
//
// Writes:
//   extension-key.pem   private key — GITIGNORED, never commit, never ship
//   extension-key.txt   public key (base64 DER) — committed; it is public,
//                       it appears verbatim in every published CRX
//
// Read this before running it
// --------------------------
// The Chrome Web Store issues its own key on the *first* upload of a new
// item, and that upload rejects a manifest containing `key`. So the key
// generated here pins the ID for local/unpacked and self-hosted-CRX installs
// only — it is not the ID the Store will publish under.
//
// Once the item exists in the Developer Dashboard, replace the contents of
// `extension-key.txt` with the dashboard's Package → "View public key" value
// and delete `extension-key.pem`. From then on the local ID matches the
// published one. `--show` will confirm the derived ID equals the Item ID.
//
// Changing the pinned key changes `chrome.runtime.id`, which is the WebAuthn
// PRF rpId (`src/holder.ts`) — every passkey-wrapped secret created under the
// old ID becomes unopenable, and any `chrome-extension://<id>` allowlist on
// the VTA side has to be updated. That is a one-time cost at Store cutover;
// do not incur it casually.

import { generateKeyPairSync } from "node:crypto";
import { writeFileSync, existsSync, chmodSync } from "node:fs";
import {
  PUBLIC_KEY_PATH,
  PRIVATE_KEY_PATH,
  readPublicKey,
  extensionIdFromPublicKey,
} from "./manifest.mjs";

const args = new Set(process.argv.slice(2));

if (args.has("--show")) {
  const key = readPublicKey();
  if (!key) {
    console.error(
      `No pinned key: ${PUBLIC_KEY_PATH} is missing or empty.\n` +
        `Run without --show to generate one.`,
    );
    process.exit(1);
  }
  console.log(`extension id: ${extensionIdFromPublicKey(key)}`);
  process.exit(0);
}

if (existsSync(PRIVATE_KEY_PATH) && !args.has("--force")) {
  console.error(
    `${PRIVATE_KEY_PATH} already exists. Regenerating changes the extension ` +
      `ID and orphans every passkey bound to the old one — pass --force only ` +
      `if that is what you mean.`,
  );
  process.exit(1);
}

// RSA-2048 is what Chrome's own `--pack-extension` emits and what the CRX3
// format expects; this is not a knob worth turning.
const { publicKey, privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});

const privatePem = privateKey.export({ type: "pkcs8", format: "pem" });
const publicDer = publicKey.export({ type: "spki", format: "der" });
const publicBase64 = publicDer.toString("base64");

writeFileSync(PRIVATE_KEY_PATH, privatePem, { mode: 0o600 });
chmodSync(PRIVATE_KEY_PATH, 0o600); // explicit: mode is umask-masked on create
writeFileSync(PUBLIC_KEY_PATH, `${publicBase64}\n`);

console.log(`private key : ${PRIVATE_KEY_PATH} (gitignored, back this up)`);
console.log(`public key  : ${PUBLIC_KEY_PATH} (commit this)`);
console.log(`extension id: ${extensionIdFromPublicKey(publicBase64)}`);
