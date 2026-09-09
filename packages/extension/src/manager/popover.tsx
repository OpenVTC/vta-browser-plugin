// An editor that opens where you clicked.
//
// ## The defect this exists to end
//
// Every editor on the identity map used to render at the *bottom of the pane*,
// after the attributes band, the faces band, the divider, the contexts band and
// the selection panel — because that is where the JSX sat. On a populated
// wallet that put the first field around 1700px down a 2450px scroller whose
// `scrollTop` never moved, with focus left on the button that opened it.
// Pressing "Add an attribute" therefore changed nothing a person could see. Not
// a subtle bug: the single loudest complaint about this console.
//
// The list and worlds screens had the opposite failure — they *replaced* the
// list with the form, so the thing being worked on vanished. Three surfaces,
// three behaviours, none of them "a form appeared where I clicked".
//
// ## Why fixed positioning
//
// The pane scrolls, the rail does not, and panels inside panes scroll
// independently. Positioning against a scroll container means knowing which
// container, and being wrong is how a popover ends up glued 800px from its
// anchor. `position: fixed` measures the anchor in viewport coordinates, which
// are the same coordinates the popover is placed in, so the two cannot
// disagree. The cost is that it must reposition on scroll — which it does,
// passively, and closes if the anchor leaves the viewport entirely.
//
// ## What it guarantees
//
//   - it is **on screen**: clamped to the viewport, and flipped above the
//     anchor when there is more room there
//   - **focus moves into it** on open — the first field, or the primary button
//     for a form with none. Without this a keyboard user is told nothing
//     happened either, which is the same bug with a different symptom
//   - **Escape closes it and gives focus back** to the anchor, so a mistaken
//     open costs one key and does not lose your place
//   - a click outside closes it; a click **inside** never does, including on a
//     `<select>` whose dropdown renders outside the popover's own box

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { c, radius } from "../theme.js";
import { ChromeProvided } from "../ui.js";
import { Icon } from "./icons.js";

/** Distance from the anchor to the popover's edge, and from the popover to the
 *  viewport edge. One value for both so the gap reads as deliberate. */
const GAP = 9;
const MARGIN = 12;
const WIDTH = 400;

interface Placement {
  left: number;
  top: number;
  /** Where the arrow sits along the popover's own top or bottom edge. */
  arrow: number;
  /** Whether the popover is above the anchor, which flips the arrow. */
  above: boolean;
}

function place(anchor: DOMRect, box: { width: number; height: number }): Placement {
  const width = Math.min(box.width || WIDTH, innerWidth - MARGIN * 2);
  const height = box.height;

  // Prefer below. Flip only when below genuinely does not fit AND above fits
  // better — flipping on a near-miss makes the popover jump between renders as
  // its own content changes height.
  const roomBelow = innerHeight - anchor.bottom - GAP - MARGIN;
  const roomAbove = anchor.top - GAP - MARGIN;
  const above = height > roomBelow && roomAbove > roomBelow;

  let left = anchor.left;
  if (left + width > innerWidth - MARGIN) left = innerWidth - MARGIN - width;
  if (left < MARGIN) left = MARGIN;

  let top = above ? anchor.top - GAP - height : anchor.bottom + GAP;
  // A popover taller than the viewport is clamped rather than centred: the top
  // is where the heading and the first field are, so that is the end to keep.
  if (top < MARGIN) top = MARGIN;
  if (top + height > innerHeight - MARGIN) top = Math.max(MARGIN, innerHeight - MARGIN - height);

  const centre = anchor.left + anchor.width / 2 - left;
  const arrow = Math.max(16, Math.min(centre, width - 16));
  return { left, top, arrow, above };
}

export interface PopoverProps {
  /** The control that opened this. Position is measured from it, and focus
   *  returns to it on close. */
  anchor: RefObject<HTMLElement | null>;
  onClose: () => void;
  title: string;
  /** Widened for forms with side-by-side fields; the default suits one column. */
  width?: number;
  children: ReactNode;
}

export function Popover({ anchor, onClose, title, width = WIDTH, children }: PopoverProps) {
  const box = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<Placement | null>(null);

  const reposition = useCallback(() => {
    const a = anchor.current;
    const b = box.current;
    if (!a || !b) return;
    const rect = a.getBoundingClientRect();
    // An anchor scrolled out of the viewport has no sensible position to point
    // at; leaving the popover floating over unrelated content is worse than
    // closing it.
    if (rect.bottom < 0 || rect.top > innerHeight) {
      onClose();
      return;
    }
    setPos(place(rect, { width, height: b.offsetHeight }));
  }, [anchor, onClose, width]);

  // Layout effect, not effect: the popover is rendered at opacity 0 until it
  // has a position, and doing this after paint shows one frame in the wrong
  // place — which reads as a jump.
  useLayoutEffect(() => {
    reposition();
  }, [reposition, children]);

  useEffect(() => {
    // `capture` so a scroll inside any ancestor scroller is seen, not only the
    // window's; passive because none of this cancels the scroll.
    const onScroll = () => reposition();
    addEventListener("scroll", onScroll, { capture: true, passive: true });
    addEventListener("resize", onScroll);
    return () => {
      removeEventListener("scroll", onScroll, { capture: true });
      removeEventListener("resize", onScroll);
    };
  }, [reposition]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
      anchor.current?.focus();
    };
    addEventListener("keydown", onKey, true);
    return () => removeEventListener("keydown", onKey, true);
  }, [anchor, onClose]);

  // Focus moves in once, on open. Keyed on nothing so it does not steal focus
  // back from wherever the person has since moved it.
  useEffect(() => {
    const b = box.current;
    if (!b) return;
    const first = b.querySelector<HTMLElement>(
      "input:not([type=hidden]):not([disabled]), select:not([disabled]), textarea:not([disabled]), button[data-primary]",
    );
    first?.focus();
    if (first instanceof HTMLInputElement && first.type === "text") first.select();
  }, []);

  return (
    <>
      {/* Catches the outside click. Transparent rather than dimmed: this is an
          editor for one card, not a modal over the whole console, and dimming
          would claim the rest of the screen is unavailable when it is not. */}
      <div
        onClick={onClose}
        style={{ position: "fixed", inset: 0, zIndex: 40 }}
        aria-hidden
      />
      <div
        ref={box}
        role="dialog"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        style={{
          position: "fixed",
          zIndex: 41,
          left: pos?.left ?? 0,
          top: pos?.top ?? 0,
          width,
          maxWidth: `calc(100vw - ${MARGIN * 2}px)`,
          maxHeight: `calc(100vh - ${MARGIN * 2}px)`,
          overflowY: "auto",
          background: c.surface,
          border: `1px solid ${c.line}`,
          borderRadius: radius.lg,
          boxShadow: "0 12px 34px rgba(15,20,32,.20), 0 2px 6px rgba(15,20,32,.10)",
          padding: "15px 16px",
          display: "grid",
          // `minmax(0, 1fr)`, not the implicit `auto`. A grid item's default
          // `min-width` is `auto`, which refuses to shrink below its content's
          // min-content width — so one long help paragraph or an unbreakable
          // mono token sized the whole column past the popover and the text was
          // clipped at the border. This is the fix, and it belongs here rather
          // than on each editor: every one of them would need it.
          gridTemplateColumns: "minmax(0, 1fr)",
          gap: 11,
          // Hidden until placed — see the layout effect above.
          opacity: pos ? 1 : 0,
        }}
      >
        {pos && (
          <span
            aria-hidden
            style={{
              position: "absolute",
              width: 11,
              height: 11,
              background: c.surface,
              borderLeft: `1px solid ${c.line}`,
              borderTop: `1px solid ${c.line}`,
              transform: `rotate(${pos.above ? 225 : 45}deg)`,
              left: pos.arrow - 5.5,
              ...(pos.above ? { bottom: -6.5 } : { top: -6.5 }),
            }}
          />
        )}
        {/* The child draws its own heading — every editor here renders a
            `Panel`, which is the thing that knows what it is called. The
            popover contributes the accessible name and the way out. */}
        <button
          onClick={onClose}
          aria-label="Close"
          style={{
            position: "absolute", top: 12, right: 12,
            border: "none", background: "transparent", color: c.faint,
            cursor: "pointer", padding: 2, borderRadius: radius.sm, lineHeight: 0,
          }}
        >
          <Icon name="close" size={16} />
        </button>
        <ChromeProvided.Provider value>{children}</ChromeProvided.Provider>
      </div>
    </>
  );
}

/**
 * The open/closed half of a popover, with the anchor ref it needs.
 *
 * Returned as a tuple of primitives rather than a component so a caller can
 * have several — the map has one per card — without nesting a provider per
 * card. `openedBy` is the element the popover points at, which is not always
 * the element that owns the state: a card's *Edit* button opens a popover the
 * card renders.
 */
export function usePopoverAnchor<E extends HTMLElement = HTMLButtonElement>() {
  const ref = useRef<E | null>(null);
  const [open, setOpen] = useState(false);
  return {
    ref,
    open,
    show: useCallback(() => setOpen(true), []),
    hide: useCallback(() => setOpen(false), []),
  };
}
