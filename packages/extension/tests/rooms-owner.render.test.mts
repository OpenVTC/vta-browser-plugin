// Issuing in a room's name, rendered.
//
// Two things here are worth more than the happy path.
//
// **The credential is the only copy.** The agent signs and keeps no record —
// a room's membership lives in its credentials rather than a roster — so a
// screen that showed the result transiently would destroy it. These pin that it
// stays until dismissed, and that the words say why.
//
// **The three verbs are not interchangeable.** Sending an invitation where a
// membership was asked for admits somebody once and leaves them unable to
// present afterwards; sending an authority credential where a membership was
// asked for confers permissions on a party the room never admitted. The task
// URI is the whole of that distinction, so it is asserted directly.

import { test } from "node:test";
import assert from "node:assert/strict";
import { agent, h, render, PARTIES } from "./harness/dom.mjs";
import { IssueInRoomsName } from "../src/manager/panes/rooms-owner.js";

const INVITE = "rooms/owner/invite/0.1";
const MEMBERSHIP = "rooms/owner/issue-membership/0.1";
const AUTHORITY = "rooms/owner/issue-authority/0.2";

const ROOM = "did:webvh:QmRoom:rooms.example";
const KEY = "room-northwind-signing";
const SUBJECT = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";

const SIGNED = {
  credential: "eyJhbGciOiJFZERTQSJ9.a-signed-credential",
  credentialId: "urn:uuid:11111111-1111-4111-8111-111111111111",
};

const mount = async () => {
  const a = agent({ [INVITE]: SIGNED, [MEMBERSHIP]: SIGNED, [AUTHORITY]: SIGNED });
  const screen = await render(h(IssueInRoomsName, { parties: PARTIES } as never), {
    chrome: { runtime: { sendMessage: a.sendMessage } },
  });
  return { a, screen };
};

/** Fill room, key and subject — every verb needs exactly these three. */
const fill = async (screen: Awaited<ReturnType<typeof mount>>["screen"]) => {
  const text = screen.all("input").filter((el) => el.type === "text" || el.type === "");
  await screen.type(text[0]!, ROOM);
  await screen.type(text[1]!, KEY);
  await screen.type(text[2]!, SUBJECT);
};

const pick = async (screen: Awaited<ReturnType<typeof mount>>["screen"], label: string) =>
  screen.click(screen.byText("label", label)!);

// ── The three verbs are three tasks ─────────────────────────────────────────

test("each verb sends its own task, and only that one", async () => {
  for (const [label, uri] of [
    ["Invitation", INVITE],
    ["Membership", MEMBERSHIP],
    ["Authority", AUTHORITY],
  ]) {
    const { a, screen } = await mount();
    await pick(screen, label!);
    await fill(screen);
    await screen.click(screen.button("Issue"));

    assert.deepEqual(
      a.calls.map((c) => c.type.replace("https://trusttasks.org/spec/", "")),
      [uri],
      `${label} must send exactly ${uri}`,
    );
  }
});

// The key is named, never derived: nothing maps a room's DID to the key it was
// minted with, and a surface that guessed would produce credentials that fail to
// verify against the room's own document.
test("the room and the signing key both travel, as given", async () => {
  const { a, screen } = await mount();
  await fill(screen);
  await screen.click(screen.button("Issue"));

  const { payload } = a.calls[0]! as { payload: Record<string, unknown> };
  assert.equal(payload.roomId, ROOM);
  assert.equal(payload.signingKeyId, KEY);
  assert.equal(payload.subject, SUBJECT);
});

// ── The credential is the only copy ─────────────────────────────────────────

test("the signed credential stays on screen, and says nothing else holds it", async () => {
  const { screen } = await mount();
  await fill(screen);
  await screen.click(screen.button("Issue"));

  const text = screen.text();
  assert.match(text, new RegExp(SIGNED.credential));
  assert.match(text, new RegExp(SIGNED.credentialId));
  assert.match(text, /nothing else has a copy/i);
});

// ── Authority is a set of actions, and one of them removes people ───────────

test("authority carries the chosen actions", async () => {
  const { a, screen } = await mount();
  await pick(screen, "Authority");
  await fill(screen);
  await screen.click(screen.byText("label", "write")!);
  await screen.click(screen.button("Issue"));

  const { payload } = a.calls[0]! as { payload: { actions: string[] } };
  assert.deepEqual([...payload.actions].sort(), ["read", "write"]);
});

// Conferring nothing is not a neutral default — it is a credential with no
// purpose, and an owner who issued one would find out at the member's first
// refused operation.
test("an authority credential conferring nothing is refused before it is sent", async () => {
  const { a, screen } = await mount();
  await pick(screen, "Authority");
  await fill(screen);
  await screen.click(screen.byText("label", "read")!); // the only default, off again
  await screen.click(screen.button("Issue"));

  assert.deepEqual(a.calls, []);
  assert.match(screen.text(), /conferring nothing/);
});

// `admin` mints epochs, and minting an epoch is how a member is removed — so a
// party holding it can remove any other. That is not obvious from the word.
test("choosing admin says what admin actually does", async () => {
  const { screen } = await mount();
  await pick(screen, "Authority");
  await screen.click(screen.byText("label", "admin")!);
  assert.match(screen.text(), /how a member is removed/);
});

// ── What the screen warns about ─────────────────────────────────────────────

// Single-use bounds how many it admits, not how long it keeps admitting one.
test("an invitation with no expiry says what that means", async () => {
  const { screen } = await mount();
  assert.match(screen.text(), /standing right to enter/);
});

test("nothing is signed while a required field is empty", async () => {
  const { a, screen } = await mount();
  await screen.click(screen.button("Issue"));
  assert.deepEqual(a.calls, []);
  assert.match(screen.text(), /Name the room/);
});

// The key is the field an operator is likeliest to think is optional, because
// every other DID-shaped surface derives what it needs.
test("the missing-key message says it is not derived", async () => {
  const { screen } = await mount();
  const text = screen.all("input").filter((el) => el.type === "text" || el.type === "");
  await screen.type(text[0]!, ROOM);
  assert.match(screen.text(), /not looked up from the room's DID/);
});
