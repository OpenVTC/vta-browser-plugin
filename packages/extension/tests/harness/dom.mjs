// Rendering a console pane in `node --test`: a DOM, an agent, and `act`.
//
// ## What this is for
//
// Every bug the console shipped today lived below the type checker and above
// the tested modules: a `ref` callback that set state and looped the renderer,
// a form that opened empty because a selection was not passed to it, a screen
// that never came back because its mode was decided once. The models under
// them were tested and correct throughout. Rendering is the only thing that
// sees any of it.
//
// ## The agent is a fake, and it answers like the real one
//
// A pane talks to the VTA through `managerSender` → `sendToBackground` →
// `chrome.runtime.sendMessage`, so that one call is where a test can stand in
// for an agent. `agent()` builds the reply shape the relay actually produces —
// `{ ok: true, result: { kind: "accepted", result } }` — because a stub that
// returned the payload bare would let a pane pass while mishandling every real
// response. It answers by task URI, so a test says what the agent holds rather
// than what any particular call returns, and a call to a task the test did not
// name is a **failure**, not an empty answer: a pane asking something
// unexpected is exactly what a test should notice.
//
// ## `act` is not optional
//
// React 19 warns without `IS_REACT_ACT_ENVIRONMENT`, and more usefully, `act`
// is what flushes effects. The bugs worth catching are effect-shaped, so a test
// that rendered without it would see the first paint and none of the
// consequences.

import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

/**
 * Make an element.
 *
 * Tests are `.mts`, which Node strips types from but cannot parse JSX in, so a
 * component is composed rather than written as a tag. Calling it directly would
 * run its hooks outside React and fail on the first `useState`.
 */
export const h = createElement;

/** Reply envelope the console's relay produces for a successful task. */
const accepted = (result) => ({ ok: true, result: { kind: "accepted", result } });

/**
 * A fake agent that answers by task URI.
 *
 * `answers` maps a full task type — or the slug after the spec prefix, which is
 * what a test wants to read — to either a value or a function of the payload.
 */
export function agent(answers = {}) {
  const calls = [];
  const find = (type) => {
    if (type in answers) return answers[type];
    const slug = type.replace("https://trusttasks.org/spec/", "");
    return slug in answers ? answers[slug] : undefined;
  };
  const sendMessage = async (message) => {
    // Only the console relay reaches an agent; anything else is a pane using a
    // bridge message this harness has not been taught, which a test should see.
    if (message?.type !== "vta-wallet/manager-task") {
      throw new Error(`the harness saw an unexpected bridge message: ${message?.type}`);
    }
    const { type, payload } = message.params;
    calls.push({ type, payload });
    const answer = find(type);
    if (answer === undefined) {
      throw new Error(
        `no answer for ${type}. Name it in agent({...}) — a pane asking something the test ` +
          `did not expect is the thing worth noticing, so this is a failure rather than {}.`,
      );
    }
    return accepted(typeof answer === "function" ? answer(payload) : answer);
  };
  return { calls, sendMessage, of: (slug) => calls.filter((c) => c.type.includes(slug)) };
}

/**
 * Mount `element` and return handles for reading and driving it.
 *
 * Installs a fresh DOM per call, so nothing leaks between tests, and tears it
 * down on `unmount()`.
 */
export async function render(element, { chrome: chromeStub } = {}) {
  const window = new Window({ url: "https://localhost/" });
  const { document } = window;

  // Assigned by descriptor: Node defines `navigator` as a getter-only global,
  // and a plain assignment throws rather than shadowing it.
  const define = (name, value) =>
    Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
  for (const name of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "Element", "Node", "Event", "MouseEvent", "CustomEvent", "DocumentFragment"]) {
    define(name, name === "window" ? window : name === "document" ? document : window[name]);
  }
  define("getComputedStyle", window.getComputedStyle.bind(window));
  define("requestAnimationFrame", (fn) => setTimeout(() => fn(Date.now()), 0));
  define("cancelAnimationFrame", (id) => clearTimeout(id));
  // The map measures cards to draw its edges. happy-dom has no layout, so every
  // box reads zero; the component already treats that as "not measured yet".
  define("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  define("IS_REACT_ACT_ENVIRONMENT", true);
  define("chrome", chromeStub ?? { runtime: { sendMessage: async () => ({ ok: false, error: "no agent" }) } });

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(element);
  });

  const all = (selector) => [...container.querySelectorAll(selector)];
  const norm = (el) => (el.textContent ?? "").replace(/\s+/g, " ");
  /**
   * The **innermost** element matching `selector` whose text contains `text`.
   *
   * Document order would return an ancestor — the pane, then the card, then the
   * row — and clicking a card where a test meant to click a row inside it
   * selects the wrong thing and asserts against the wrong screen. Fewest
   * descendants is the row the person would have clicked.
   */
  const byText = (selector, text) => {
    const hits = all(selector).filter((el) => norm(el).includes(text));
    return hits.sort((a, b) => a.querySelectorAll("*").length - b.querySelectorAll("*").length)[0];
  };

  return {
    container,
    /** Everything on screen, whitespace-normalised, for `assert.match`. */
    text: () => (container.textContent ?? "").replace(/\s+/g, " ").trim(),
    all,
    byText,
    /** The first button whose label contains `text`. Throws when absent, so a
     *  test that meant to press something says so rather than passing. */
    button: (text) => {
      const found = byText("button", text);
      if (!found) {
        const labels = all("button").map((b) => `“${(b.textContent ?? "").trim()}”`);
        throw new Error(`no button matching “${text}”. On screen: ${labels.join(", ") || "none"}`);
      }
      return found;
    },
    click: async (el) => {
      await act(async () => {
        el.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      });
    },
    /** Type into an input or textarea, the way React hears it. */
    type: async (el, value) => {
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
        setter ? setter.call(el, value) : (el.value = value);
        el.dispatchEvent(new window.Event("input", { bubbles: true }));
        el.dispatchEvent(new window.Event("change", { bubbles: true }));
      });
    },
    /**
     * Tick a checkbox by clicking it, not by assigning `checked`.
     *
     * React listens for `click` on a checkbox and reads the resulting state; a
     * hand-set `checked` plus a synthetic `change` looks like a tick to a test
     * and like nothing at all to the component, which passes a "did not crash"
     * assertion while proving nothing about the handler.
     */
    check: async (el) => {
      await act(async () => {
        el.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      });
    },
    select: async (el, value) => {
      await act(async () => {
        el.value = value;
        el.dispatchEvent(new window.Event("change", { bubbles: true }));
      });
    },
    /** Let queued effects and promises settle. */
    settle: async () => {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
    },
    rerender: async (next) => {
      await act(async () => {
        root.render(next);
      });
    },
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      window.close();
    },
  };
}

/** An unscoped holder — what every persona task requires. */
export const PARTIES = {
  holder: { did: "did:key:zHolder" },
  service: { did: "did:webvh:QmAgent:agent.example" },
};

/** `whoAmI`'s answer for a caller the agent treats as an unscoped holder. */
export const UNSCOPED_HOLDER = { session: { id: "s" }, roles: ["admin"], scopes: [] };
