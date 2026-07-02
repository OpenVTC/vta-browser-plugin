import { test } from "node:test";
import assert from "node:assert/strict";

import {
  VtaSession,
  orderChannelsByPriority,
  VtaClientError,
} from "../dist/vta/index.js";

/** Minimal in-memory TrustTaskChannel stub. */
function channel(kind, { onSend, supports, onClose } = {}) {
  const calls = [];
  return {
    kind,
    calls,
    supports,
    async send(envelope, opts) {
      calls.push({ envelope, opts });
      if (onSend) return onSend(envelope, opts);
      return { ok: kind };
    },
    ...(onClose ? { close: onClose } : {}),
  };
}

const env = (type = "https://trusttasks.org/spec/vault/list/0.2") => ({
  id: "req-1",
  type,
  issuedAt: "2026-07-02T00:00:00Z",
  payload: {},
});

test("orderChannelsByPriority sorts TSP > DIDComm > REST", () => {
  const ordered = orderChannelsByPriority([
    channel("rest"),
    channel("didcomm"),
    channel("tsp"),
  ]);
  assert.deepEqual(ordered.map((c) => c.kind), ["tsp", "didcomm", "rest"]);
});

test("send routes to the highest-priority channel", async () => {
  const rest = channel("rest");
  const didcomm = channel("didcomm");
  const session = new VtaSession([rest, didcomm]);
  assert.equal(session.primaryKind, "didcomm");

  const res = await session.send(env());
  assert.deepEqual(res, { ok: "didcomm" });
  assert.equal(didcomm.calls.length, 1);
  assert.equal(rest.calls.length, 0);
});

test("send falls back to the next channel on e.client.unsupported", async () => {
  const didcomm = channel("didcomm", {
    onSend() {
      throw new VtaClientError("e.client.unsupported", "didcomm can't route this");
    },
  });
  const rest = channel("rest");
  const session = new VtaSession([rest, didcomm]);

  const res = await session.send(env());
  assert.deepEqual(res, { ok: "rest" });
  assert.equal(didcomm.calls.length, 1);
  assert.equal(rest.calls.length, 1);
});

test("send does NOT fall back on a real error (e.g. a reject)", async () => {
  const didcomm = channel("didcomm", {
    onSend() {
      throw new VtaClientError("e.p.msg.conflict", "version conflict");
    },
  });
  const rest = channel("rest");
  const session = new VtaSession([rest, didcomm]);

  await assert.rejects(() => session.send(env()), (e) => e.code === "e.p.msg.conflict");
  assert.equal(rest.calls.length, 0); // never tried the fallback
});

test("supports() filters channels out of the chain", async () => {
  const didcomm = channel("didcomm", {
    supports: (type) => type.includes("passkey"), // doesn't support vault/list
  });
  const rest = channel("rest");
  const session = new VtaSession([rest, didcomm]);

  const res = await session.send(env()); // vault/list → only REST supports
  assert.deepEqual(res, { ok: "rest" });
  assert.equal(didcomm.calls.length, 0);
});

test("send throws e.client.unsupported when no channel can route the task", async () => {
  const didcomm = channel("didcomm", { supports: () => false });
  const session = new VtaSession([didcomm]);
  await assert.rejects(
    () => session.send(env()),
    (e) => e instanceof VtaClientError && e.code === "e.client.unsupported",
  );
});

test("empty channel set is rejected at construction", () => {
  assert.throws(() => new VtaSession([]), (e) => e.code === "e.client.unsupported");
});

test("close() releases every channel that has a close()", async () => {
  let closed = 0;
  const a = channel("didcomm", { onClose: async () => { closed++; } });
  const b = channel("rest"); // no close
  await new VtaSession([a, b]).close();
  assert.equal(closed, 1);
});
