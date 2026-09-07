// The grant command is a security decision that renders as a display string.
//
// Every assertion here is about the `pnm acl create` line an operator will
// paste into a terminal that holds their agent. Two of them pin bugs this
// module was written to end: the printed `--role super-admin` (not a role the
// CLI has — the roles are admin, initiator, application, reader), and the
// default command's silent omission of `--contexts`, which is not "no contexts"
// but *unrestricted*.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { grantCommand, needsSuperAdminOperator } from "../src/grant-command.js";

const EPH = "did:key:z6MkExampleEphemeralKeyForTests";

test("a context-scoped grant names its context", () => {
  const cmd = grantCommand({ ephemeralDid: EPH, adminScope: "context", context: "work" });
  assert.equal(cmd, `pnm acl create --did ${EPH} --role admin --contexts work --expires 1h`);
});

test("an unrestricted grant omits --contexts entirely", () => {
  const cmd = grantCommand({ ephemeralDid: EPH, adminScope: "unrestricted" });
  assert.equal(cmd, `pnm acl create --did ${EPH} --role admin --expires 1h`);
  // Not `--contexts ''`: `pnm acl create` documents that as one context named
  // empty-string, and rejects it. The empty *list* is what reads as
  // unrestricted, and the only way to get one is to leave the flag off.
  assert.ok(!cmd.includes("--contexts"), cmd);
});

test("a context passed alongside an unrestricted scope does not reach the command", () => {
  // The home context of an unrestricted wallet is real and is stored — it is
  // just not part of the grant. Leaking it into `--contexts` would scope the
  // ephemeral, and the provisioning that follows would be refused for asking
  // to confer more than the caller holds.
  const cmd = grantCommand({
    ephemeralDid: EPH,
    adminScope: "unrestricted",
    context: "work",
  });
  assert.ok(!cmd.includes("work"), cmd);
});

test("no scope prints a role the CLI does not have", () => {
  // `--role super-admin` was printed whenever the operator asked to create a
  // context inline. `pnm acl create --role` takes admin | initiator |
  // application | reader; super-admin is the shape of an admin grant, not a
  // role name, so that command could not run at all.
  for (const scope of ["context", "unrestricted"] as const) {
    const cmd = grantCommand({ ephemeralDid: EPH, adminScope: scope, context: "work" });
    assert.ok(/--role admin(\s|$)/.test(cmd), `${scope}: ${cmd}`);
    assert.ok(!cmd.includes("super-admin"), `${scope}: ${cmd}`);
  }
});

test("a context-scoped grant with no context refuses rather than widening", () => {
  // The failure this guards is the one nothing downstream would catch: with
  // the context dropped, the command is byte-identical to the unrestricted
  // form, the grant succeeds, and the operator has handed the wallet the
  // whole agent while the screen says one context.
  for (const context of [undefined, "", "   "]) {
    assert.throws(
      () => grantCommand({ ephemeralDid: EPH, adminScope: "context", ...(context !== undefined ? { context } : {}) }),
      /context/i,
      `context=${JSON.stringify(context)} must not render an unrestricted command`,
    );
  }
});

test("surrounding whitespace on a context does not reach the command", () => {
  const cmd = grantCommand({ ephemeralDid: EPH, adminScope: "context", context: "  work  " });
  assert.equal(cmd, `pnm acl create --did ${EPH} --role admin --contexts work --expires 1h`);
});

test("the grant expires, so an abandoned onboarding leaves nothing permanent", () => {
  for (const scope of ["context", "unrestricted"] as const) {
    const cmd = grantCommand({ ephemeralDid: EPH, adminScope: scope, context: "work" });
    assert.ok(cmd.includes("--expires 1h"), `${scope}: ${cmd}`);
  }
});

test("only the unrestricted scope asks more of the operator running it", () => {
  assert.equal(needsSuperAdminOperator("unrestricted"), true);
  assert.equal(needsSuperAdminOperator("context"), false);
});
