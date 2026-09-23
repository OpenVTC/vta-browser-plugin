// "Show QR code" for a DID: a small button beside the DID that opens a
// popover holding the code, the full DID and a Copy button.
//
// It is a button *beside* the DID, not a click on the DID itself, because a
// DID is already a control in places — the console's DIDs table opens a DID's
// log on click, and the lens opens its mail — and a QR code must not take that
// gesture away from them.
//
// `did-qr.ts` builds the geometry; see it for what the code carries.

import { useMemo, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { qrModules, qrPath } from "./did-qr.js";
import { c, t, font, radius } from "./theme.js";
import { CopyButton } from "./ui.js";
import { Popover, usePopoverAnchor } from "./manager/popover.js";
import { Icon } from "./manager/icons.js";

/**
 * The code itself, as inline SVG.
 *
 * Black on white **in every theme** — the one place in this extension a colour
 * is written as a literal rather than a `theme.ts` token. A token would follow
 * dark mode and draw the code inverted (light modules on a dark ground), and
 * many phone cameras refuse an inverted code. The quiet zone is inside the
 * white box, so it survives whatever the code is placed on.
 */
export function QrCode({ text, size = 232 }: { text: string; size?: number }) {
  const { d, side } = useMemo(() => qrPath(qrModules(text)), [text]);
  return (
    <svg
      role="img"
      aria-label={`QR code of ${text}`}
      width={size}
      height={size}
      viewBox={`0 0 ${side} ${side}`}
      shapeRendering="crispEdges"
      style={{ display: "block", flexShrink: 0 }}
    >
      <rect width={side} height={side} fill="#ffffff" />
      <path d={d} fill="#000000" />
    </svg>
  );
}

/**
 * The QR button for one DID, and the popover it opens.
 *
 * The popover is portalled to `document.body` so an ancestor's transform or
 * overflow cannot clip or misplace its fixed positioning. React still bubbles
 * a portal's events through the component tree, though, so clicks are stopped
 * at this component: the popover's outside-click catcher would otherwise also
 * "click" the table row or card the DID sits in.
 */
export function DidQrButton({ value, size = 14 }: { value: string; size?: number }) {
  const pop = usePopoverAnchor();
  const stop = (e: MouseEvent) => e.stopPropagation();
  return (
    <>
      <button
        ref={pop.ref}
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          if (pop.open) pop.hide();
          else pop.show();
        }}
        aria-label="Show this DID as a QR code"
        aria-haspopup="dialog"
        aria-expanded={pop.open}
        title="Show as a QR code"
        className="did-qr-button"
        style={{
          display: "inline-flex",
          verticalAlign: "middle",
          marginLeft: 4,
          padding: 2,
          border: "none",
          background: "transparent",
          color: c.faint,
          cursor: "pointer",
          borderRadius: radius.sm,
          lineHeight: 0,
        }}
      >
        <Icon name="qr" size={size} />
      </button>
      {pop.open &&
        createPortal(
          <div onClick={stop}>
            <Popover anchor={pop.ref} onClose={pop.hide} title="DID as a QR code" width={292}>
              <div style={{ fontSize: t.base, fontWeight: 620, color: c.text, paddingRight: 24 }}>
                Scan with Keyring
              </div>
              <div
                style={{
                  justifySelf: "center",
                  padding: 6,
                  background: "#ffffff",
                  border: `1px solid ${c.line}`,
                  borderRadius: radius.md,
                }}
              >
                <QrCode text={value} />
              </div>
              <code
                style={{
                  fontFamily: font.mono,
                  fontSize: t.xs,
                  color: c.text,
                  wordBreak: "break-all",
                  lineHeight: 1.5,
                }}
              >
                {value}
              </code>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <CopyButton value={value} label="Copy DID" kind="default" title="Copy this DID" />
                <span style={{ fontSize: t.xs, color: c.muted }}>
                  The code holds only this DID, which is public.
                </span>
              </div>
            </Popover>
          </div>,
          document.body,
        )}
    </>
  );
}
