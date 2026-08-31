// Give the wheel back after a <select> is used with the mouse.
//
// Chromium routes wheel events to a focused menulist <select> and does not
// chain them on to the document, so once you have picked an option the wheel
// is dead for as long as the pointer stays over that control — and in the
// popup, whose viewport Chrome caps near 600px, the control sits directly
// over the fields you still have to reach. It reads as the whole window
// having seized up. The user's own workaround is to click somewhere
// uninteresting; this performs that click's one useful effect on the same
// gesture, the moment the choice is made.
//
// Deliberately scoped to *pointer* choices. A keyboard user changing a closed
// <select> with the arrow keys fires `change` on every keystroke, and blurring
// there would throw focus out of the form mid-selection and reset tab position
// to the top of the document — trading a mouse annoyance for a keyboard trap.
// A `keydown` therefore cancels the pending release: the sequence that ends in
// a blur has to be pointer-opened and uninterrupted by the keyboard.

/** The slice of `Document` this needs. Typed structurally rather than as
 *  `Document` so the behaviour is testable in plain Node, which has no DOM —
 *  see `tests/select-wheel.test.mts`. */
export interface SelectWheelHost {
  addEventListener(type: string, listener: (e: Event) => void, capture?: boolean): void;
  removeEventListener(type: string, listener: (e: Event) => void, capture?: boolean): void;
}

/** An event's target when that target is a `<select>`, else null. Structural
 *  for the same reason: `HTMLSelectElement` does not exist outside a browser. */
function selectTarget(e: Event): { blur(): void } | null {
  const target = e.target as { tagName?: unknown; blur?: unknown } | null;
  if (!target || target.tagName !== "SELECT" || typeof target.blur !== "function") return null;
  return target as { blur(): void };
}

/**
 * Install the release on a document root. Returns a disposer; the surfaces
 * that call this live as long as their page does and ignore it, but a
 * listener with no way off a document is a leak waiting for the first caller
 * who doesn't.
 */
export function releaseSelectAfterPointerChange(host: SelectWheelHost): () => void {
  // The <select> a pointer opened, and so the only one a `change` may blur.
  let opened: { blur(): void } | null = null;

  const onPointerDown = (e: Event) => {
    opened = selectTarget(e);
  };
  // Any key cancels: either the user is driving the select from the keyboard,
  // or a pointer-opened menu was abandoned and `opened` is now stale.
  const onKeyDown = () => {
    opened = null;
  };
  const onChange = (e: Event) => {
    const el = selectTarget(e);
    if (el && el === opened) el.blur();
    opened = null;
  };

  // Capture, so a component that stops propagation on its own control does
  // not silently opt that control out of the fix.
  host.addEventListener("pointerdown", onPointerDown, true);
  host.addEventListener("keydown", onKeyDown, true);
  host.addEventListener("change", onChange, true);

  return () => {
    host.removeEventListener("pointerdown", onPointerDown, true);
    host.removeEventListener("keydown", onKeyDown, true);
    host.removeEventListener("change", onChange, true);
  };
}
