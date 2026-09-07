// The setup flow's two questions, mounted.
//
// Every assertion here is about something a person would see and a type
// checker would not: which question is on screen at which point, what the
// message the wallet sends actually carries, and what ends up stored about the
// wallet's own authority.
//
// The order-dependence is the reason this is a rendered test rather than a
// unit one. The home context has to be known *before* the grant command for a
// context-scoped wallet (the command carries `--contexts`) and *after* it for
// an unrestricted one (the command names no context, and the picker reads the
// agent's real list as the now-granted ephemeral). That is two different
// screens for one field, and nothing below the component knows it.
//
// `chrome` is installed before the dynamic import on purpose: `store.ts`
// creates its zustand-persist store at module scope, which reaches
// `chrome.storage.local` on the way in. A static import would run that first
// and throw.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { h, render } from "./harness/dom.mjs";

/** A `did:key` agent, so nothing in the flow asks for a host permission —
 *  `didWebvhDomain` finds no host and `prepare` skips the grant prompt. Using
 *  a `did:webvh` here would put a Chrome permission dialog in the middle of
 *  every case below. */
const AGENT = "did:key:z6MkjExampleAgentIdentifierUsedOnlyInThisTest";
const EPH = "did:key:z6MkjExampleEphemeralMintedForTheseTests";

interface Sent {
  type: string;
  [k: string]: unknown;
}

/**
 * A chrome stub that records what the view sends and answers the onboarding
 * messages.
 *
 * `connect` is a function of the request so a case can answer with something
 * other than what was asked — which is the whole point of one of the tests
 * below: an agent that ignores an `adminScope` it does not implement replies
 * success with a context-scoped entry, and the wallet must record *that*.
 */
function stubChrome(opts: {
  contexts?: Array<{ id: string; name: string }>;
  contextsError?: string;
  connect?: (req: Sent) => Record<string, unknown>;
}) {
  const sent: Sent[] = [];
  const chrome = {
    runtime: {
      onMessage: { addListener() {}, removeListener() {} },
      async sendMessage(message: Sent) {
        sent.push(message);
        switch (message.type) {
          case "vta-wallet/onboard-prepare":
            return { ok: true, result: { ephemeralDid: EPH, command: `pnm acl create --did ${EPH}` } };
          case "vta-wallet/onboard-contexts":
            return opts.contextsError
              ? { ok: false, error: opts.contextsError }
              : { ok: true, result: { contexts: opts.contexts ?? [] } };
          case "vta-wallet/onboard-connect":
            return {
              ok: true,
              result: {
                holderDid: "did:key:z6MkjExampleHolderTheAgentMinted",
                role: "admin",
                context: "alpha",
                adminScope: "context",
                secretEncrypted: false,
                ...(opts.connect ? opts.connect(message) : {}),
              },
            };
          default:
            throw new Error(`unexpected bridge message: ${message.type}`);
        }
      },
    },
    storage: {
      local: { get: (_k: string, cb: (i: Record<string, unknown>) => void) => cb({}), set: (_v: unknown, cb: () => void) => cb(), remove: (_k: string, cb: () => void) => cb() },
      session: { get: async () => ({}), remove: async () => {} },
    },
    permissions: { contains: async () => true, request: async () => true },
  };
  return { chrome, sent, last: (type: string) => [...sent].reverse().find((m) => m.type === type) };
}

async function mount(stub: ReturnType<typeof stubChrome>, props: Record<string, unknown> = { standalone: true }) {
  Object.defineProperty(globalThis, "chrome", {
    value: stub.chrome,
    writable: true,
    configurable: true,
  });
  // Clipboard is only touched by Copy, but happy-dom has none and the copy
  // button is on the path to Connect.
  const { OnboardView } = await import("../src/onboard-view.js");
  const view = await render(h(OnboardView, props), { chrome: stub.chrome });
  Object.defineProperty(globalThis.navigator, "clipboard", {
    value: { writeText: async () => {} },
    configurable: true,
  });
  return view;
}

/** The input carrying `aria-label`, so a test names the field rather than
 *  counting past the radio buttons between them. */
function field(view: Awaited<ReturnType<typeof mount>>, label: string): HTMLInputElement {
  const found = view
    .all("input")
    .find((i) => (i as HTMLInputElement).getAttribute("aria-label") === label);
  if (!found) throw new Error(`no field labelled “${label}” on screen`);
  return found as HTMLInputElement;
}

/** Type the agent address and press Continue, landing on the grant screen. */
async function toGrantScreen(view: Awaited<ReturnType<typeof mount>>) {
  await view.type(field(view, "Agent address"), AGENT);
  await view.click(view.button("Continue"));
  await view.settle();
}

test("the scope question is asked before anything else can be decided", async () => {
  const stub = stubChrome({});
  const view = await mount(stub);
  const text = view.text();
  assert.match(text, /Work inside one context/);
  assert.match(text, /Manage the whole agent/);
  // Defaults to the narrower answer. A wallet that turns out to need the agent
  // can be set up again; one silently granted it cannot be un-granted without
  // someone noticing there was something to notice.
  const [scoped, whole] = view.all('input[type="radio"]');
  assert.equal((scoped as HTMLInputElement).checked, true);
  assert.equal((whole as HTMLInputElement).checked, false);
  await view.unmount();
});

test("a context-scoped setup asks for its context before the grant command", async () => {
  const stub = stubChrome({});
  const view = await mount(stub);
  // The command will carry `--contexts <id>`, so the field has to be here.
  assert.match(view.text(), /Which context\?/);
  await view.unmount();
});

test("a whole-agent setup does not ask for a context up front, and says why", async () => {
  const stub = stubChrome({});
  const view = await mount(stub);
  await view.click(view.all('input[type="radio"]')[1]!);
  assert.doesNotMatch(view.text(), /Which context\?/);
  // Silence would read as "this wallet has no context", which is the exact
  // misunderstanding the second question exists to prevent.
  assert.match(view.text(), /next screen/i);
  await view.unmount();
});

test("prepare carries the scope, and the context only where the command needs it", async () => {
  const scoped = stubChrome({});
  {
    const view = await mount(scoped);
    await view.type(field(view, "Home context"), "alpha");
    await toGrantScreen(view);
    const prep = scoped.last("vta-wallet/onboard-prepare")!;
    assert.equal(prep.adminScope, "context");
    assert.equal(prep.context, "alpha");
    await view.unmount();
  }

  const whole = stubChrome({ contexts: [{ id: "alpha", name: "Alpha" }] });
  {
    const view = await mount(whole);
    await view.click(view.all('input[type="radio"]')[1]!);
    await toGrantScreen(view);
    const prep = whole.last("vta-wallet/onboard-prepare")!;
    assert.equal(prep.adminScope, "unrestricted");
    // A context here would be rendered as `--contexts`, scoping the very
    // ephemeral that then has to confer an unrestricted admin — refused, after
    // the operator ran a command they were told was right.
    assert.equal(prep.context, undefined);
    await view.unmount();
  }
});

test("the whole-agent path picks its home context from the agent's own list", async () => {
  const stub = stubChrome({ contexts: [{ id: "alpha", name: "Alpha" }, { id: "beta", name: "Beta" }] });
  const view = await mount(stub);
  await view.click(view.all('input[type="radio"]')[1]!);
  await toGrantScreen(view);

  assert.match(view.text(), /Where should this wallet keep its settings\?/);
  // Both offered, and neither pre-selected: with more than one, choosing for
  // the operator would make the most consequential field the one they never
  // looked at.
  assert.ok(view.byText("button", "alpha"), view.text());
  assert.ok(view.byText("button", "beta"), view.text());
  assert.equal(
    (view.button("I've run it — Connect") as HTMLButtonElement).disabled,
    true,
    "Connect must not be reachable before a home context is chosen — the wire member is required",
  );

  await view.click(view.byText("button", "beta")!);
  await view.click(view.button("I've run it — Connect"));
  await view.settle();
  const connect = stub.last("vta-wallet/onboard-connect")!;
  assert.equal(connect.context, "beta");
  assert.equal(connect.adminScope, "unrestricted");
  await view.unmount();
});

test("a single context is pre-selected, because there is no ambiguity to resolve", async () => {
  const stub = stubChrome({ contexts: [{ id: "only", name: "Only" }] });
  const view = await mount(stub);
  await view.click(view.all('input[type="radio"]')[1]!);
  await toGrantScreen(view);
  assert.equal(
    (view.button("I've run it — Connect") as HTMLButtonElement).disabled,
    false,
    "one context is not a choice; making the operator click it is ceremony",
  );
  await view.unmount();
});

test("an agent that cannot list its contexts still lets the wallet be set up", async () => {
  // Reachable before the operator has run the grant command — the agent
  // refuses a listing from an unauthorised ephemeral — so this must be a hint
  // beside a text field, not a dead end.
  const stub = stubChrome({ contextsError: "unauthorized" });
  const view = await mount(stub);
  await view.click(view.all('input[type="radio"]')[1]!);
  await toGrantScreen(view);
  assert.match(view.text(), /Couldn't read the agent's contexts/);
  const typed = field(view, "Home context");
  assert.ok(typed, "a typed context is the fallback when the list is unavailable");
  await view.type(typed, "typed-by-hand");
  await view.click(view.button("I've run it — Connect"));
  await view.settle();
  assert.equal(stub.last("vta-wallet/onboard-connect")!.context, "typed-by-hand");
  await view.unmount();
});

test("what gets stored is what the agent said, not what the wallet asked for", async () => {
  // The regression this exists for. An agent that predates `adminScope`
  // ignores the member and writes a context-scoped entry, replying success.
  // A wallet that recorded its own request would then show a console the
  // holder cannot actually drive, and name a context nobody confirmed.
  const stub = stubChrome({
    contexts: [{ id: "asked-for", name: "Asked for" }],
    connect: () => ({ context: "where-it-actually-landed", adminScope: "context" }),
  });
  // Mounted the way the setup spine mounts it — no `standalone`, no
  // `onCancel` — because that is the path that commits straight to the store
  // rather than pausing on the encrypt prompt.
  const view = await mount(stub, {});
  await view.click(view.all('input[type="radio"]')[1]!);
  await toGrantScreen(view);
  await view.click(view.button("I've run it — Connect"));
  await view.settle();

  const sent = stub.last("vta-wallet/onboard-connect")!;
  assert.equal(sent.adminScope, "unrestricted", "the ask was for the whole agent");

  const { useConnectionStore } = await import("../src/store.js");
  const stored = useConnectionStore.getState().connections.vtas[AGENT];
  assert.ok(stored, `no connection stored for ${AGENT}`);
  assert.equal(stored.agentScope, "context", "the agent wrote a context-scoped entry; record that");
  assert.equal(stored.homeContext, "where-it-actually-landed");
  await view.unmount();
});
