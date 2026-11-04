// The error a page's `window.vtaWallet.*` call rejects with: `message` and
// `code` (docs/page-bridge-errors.md, `src/page-error.ts`).
//
// A portal switches on `code`, so the code is a contract: which one an error
// carries is read off the error, never off its message; the wallet's own codes
// are named once, documented, and never a Trust Task standard code; and a
// code is a single name, so no party can put into it anything the page would
// not already read in the message.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { STANDARD_CODES } from "@openvtc/trust-tasks/runtime";
import { VtaClientError } from "@openvtc/pnm-core";
import { CastRefusedError, OobRefusedError } from "@openvtc/pnm-core/vtc";
import { RoomOfferError } from "@openvtc/pnm-core/rooms";
import { RoomFileError } from "@openvtc/pnm-core/rooms/files";

import {
  PAGE_CODE,
  PageRefusal,
  ROOMS_WORK_CODES,
  WALLET_ERROR_CODES,
  forwardedCode,
  isWalletErrorCode,
  pageErrorCode,
  pageFailure,
  trustTaskLocalCode,
} from "../src/page-error.ts";
import { WalletLockedError } from "../src/webauthn-prf-wrap.ts";

const doc = readFileSync(fileURLToPath(new URL("../../../docs/page-bridge-errors.md", import.meta.url)), "utf8");

/** The first-column codes of the table under `heading`, in order. */
function documented(heading: string): string[] {
  const start = doc.indexOf(`## ${heading}`);
  assert.ok(start >= 0, `docs/page-bridge-errors.md has no "## ${heading}" section`);
  const next = doc.indexOf("\n## ", start + 1);
  const section = doc.slice(start, next < 0 ? undefined : next);
  return [...section.matchAll(/^\| `([^`]+)` \|/gm)].map((m) => m[1]!);
}

test("the documented wallet codes are exactly WALLET_ERROR_CODES, in order", () => {
  const codes = Object.keys(WALLET_ERROR_CODES);
  assert.ok(codes.length >= 10, "the list is being read");
  assert.deepEqual(documented("Wallet codes"), codes);
});

test("the documented rooms work codes are exactly ROOMS_WORK_CODES, in order", () => {
  assert.deepEqual(documented("Rooms work codes"), [...ROOMS_WORK_CODES]);
});

test("every code is one camelCase name", () => {
  for (const code of [...Object.keys(WALLET_ERROR_CODES), ...ROOMS_WORK_CODES]) assert.match(code, PAGE_CODE, code);
});

test("no wallet code is a Trust Task standard code, so a page need not ask who said it", () => {
  const standard = new Set<string>(STANDARD_CODES);
  for (const code of Object.keys(WALLET_ERROR_CODES)) assert.ok(!standard.has(code), `${code} is a §8.3 standard code`);
  for (const code of STANDARD_CODES) assert.equal(isWalletErrorCode(code), false, code);
});

test("a Trust Task code arrives by its local part; a standard code as it is", () => {
  assert.equal(trustTaskLocalCode("vtc/elections/show:electionUnknown"), "electionUnknown");
  assert.equal(trustTaskLocalCode("indeterminate"), "indeterminate");
  assert.equal(trustTaskLocalCode("permissionDenied"), "permissionDenied");
  assert.equal(trustTaskLocalCode("e.p.msg.forbidden"), undefined);
  assert.equal(trustTaskLocalCode(""), undefined);
  assert.equal(trustTaskLocalCode(42), undefined);
});

test("the code is read off the error, never its message", () => {
  // The words of a refusal, with nothing naming one: no code is guessed.
  assert.equal(pageErrorCode(new Error("Acme shows you no such election (electionUnknown)")), "unclassified");
  assert.equal(pageErrorCode(new PageRefusal("You did not take a ticket.", "declined")), "declined");
  assert.equal(pageErrorCode(new WalletLockedError()), "walletLocked");
  assert.equal(pageErrorCode(new OobRefusedError("vtc/elections/tickets/issue:notOpen", "no")), "notOpen");
  assert.equal(pageErrorCode(new CastRefusedError("voting/cast:closed", "no")), "closed");
  assert.equal(pageErrorCode(new RoomOfferError("offerExpired", "gone")), "offerExpired");
  assert.equal(pageErrorCode(new RoomOfferError("other", "something")), "unclassified", "`other` names nothing");
  assert.equal(pageErrorCode(new RoomFileError("versionRace", "moved")), "versionRace");
  assert.equal(pageErrorCode("a string"), "unclassified");
  assert.equal(pageErrorCode(undefined), "unclassified");
});

test("a VTA client error carries the refusing party's Trust Task code; its transport failures their wallet codes", () => {
  const refused = new VtaClientError("e.p.msg.forbidden", "denied", {
    details: { code: "vta/pcs/voter/register:membershipCredentialMismatch" },
  });
  assert.equal(pageErrorCode(refused), "membershipCredentialMismatch");
  assert.equal(pageErrorCode(new VtaClientError("e.client.timeout", "no answer")), "timedOut");
  assert.equal(pageErrorCode(new VtaClientError("e.client.network", "no route")), "unreachable");
  assert.equal(pageErrorCode(new VtaClientError("e.p.msg.internal", "boom")), "unclassified");
});

test("pageFailure keeps the message as it was", () => {
  const e = new PageRefusal("The wallet holds no such identity for this community.", "identityUnknown");
  assert.deepEqual(pageFailure(e), { ok: false, error: e.message, code: "identityUnknown" });
  assert.deepEqual(pageFailure("plain"), { ok: false, error: "plain", code: "unclassified" });
});

test("vti_ntf_063 / vti_vot_090: a forwarded code that is not one name stops at the wallet", () => {
  for (const raw of ["eyJhbGciOiJFZERTQSJ9.eyJ2YyI6e319.c2ln", "did:key:z6Mk", "choice=ana", "<b>x</b>", "a".repeat(65), 7, null]) {
    assert.equal(forwardedCode(raw), "unclassified", String(raw));
  }
  assert.equal(forwardedCode("electionUnknown"), "electionUnknown");
  assert.equal(forwardedCode(undefined, "walletUnavailable"), "walletUnavailable");
});
