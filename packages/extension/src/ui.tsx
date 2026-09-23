// Shared presentational components, built on the tokens in `theme.ts`.
//
// Deliberately small and unopinionated about data — these exist so popup,
// options and confirm stop each inventing their own pill, button and DID
// rendering, which is how the extension ended up with two visual identities
// and ~20 ad-hoc hex literals.

import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from "react";
import { splitDid, didHost, type DidPart } from "./did-display.js";
import { displayAgentName, type AgentName } from "./agent-name.js";
import { c, t, font, button, pill, type ButtonKind, type PillTone } from "./theme.js";
import { DidQrButton } from "./did-qr-view.js";

const ROLE_STYLE: Record<DidPart["role"], CSSProperties> = {
  // The method prefix is identical on every DID the user will ever see, so it
  // carries no information and recedes furthest.
  method: { color: c.faint },
  opaque: { color: c.muted },
  // The host is what a human verifies — the only part that should read loudly.
  host: { color: c.text, fontWeight: 620 },
  path: { color: c.faint },
};

/**
 * Render a DID with its host emphasised.
 *
 * `verified` tints the host with the semantic "verified" colour, for use only
 * where resolution actually succeeded — it is a claim about cryptographic
 * state, not decoration.
 *
 * Every DID carries a QR button after it (`did-qr-view.tsx`), so a phone can
 * scan any identifier this extension shows. `qr={false}` drops it — only for a
 * DID that sits inside another control, where a nested button is invalid.
 */
export function Did({
  value,
  verified = false,
  size = t.sm,
  href,
  title,
  qr = true,
}: {
  value: string;
  verified?: boolean;
  size?: string;
  /** Make the DID a link — the console points it at the DID's mail. A click
   *  does not also reach a row or card it sits in. */
  href?: string;
  title?: string;
  /** Show the QR button. Off only inside a `<button>` or `<label>`. */
  qr?: boolean;
}) {
  const did = <DidText value={value} verified={verified} size={size} href={href} title={title} />;
  if (!qr) return did;
  // One wrapper, so a flex or grid parent still sees a single item — the
  // button trails the DID's last line rather than becoming a column of its own.
  return (
    <span style={{ minWidth: 0 }}>
      {did}
      <DidQrButton value={value} />
    </span>
  );
}

function DidText({
  value,
  verified,
  size,
  href,
  title,
}: {
  value: string;
  verified: boolean;
  size: string;
  href: string | undefined;
  title: string | undefined;
}) {
  const parts = splitDid(value);
  const host = didHost(value);
  const Tag = href ? "a" : "span";
  return (
    <Tag
      {...(href
        ? {
            href,
            title: title ?? undefined,
            onClick: (e: MouseEvent<HTMLAnchorElement>) => e.stopPropagation(),
            className: "did-link",
          }
        : {})}
      style={{
        fontFamily: font.mono,
        fontSize: size,
        wordBreak: "break-all",
        lineHeight: 1.45,
        ...(href ? { color: "inherit", textDecoration: "none", borderBottom: `1px dotted ${c.faint}` } : {}),
      }}
      // Screen readers get the same emphasis the visual treatment gives:
      // lead with the host rather than reading fifty opaque characters first.
      aria-label={host ? `DID at ${host}: ${value}` : value}
    >
      {parts.map((p, i) => (
        <span
          key={i}
          style={
            p.role === "host" && verified
              ? { ...ROLE_STYLE.host, color: c.ok }
              : ROLE_STYLE[p.role]
          }
        >
          {p.text}
        </span>
      ))}
    </Tag>
  );
}

/**
 * A DID shown by name, with the identifier beneath it.
 *
 * `agentName` must come from the resolved document's `alsoKnownAs` — it is
 * never derived here. A name is not a segment of the DID: the name → DID link
 * is a web redirect, so a name inferred from DID structure would be an
 * unverified guess wearing an authoritative-looking label, which is the exact
 * spoofing the `alsoKnownAs` check exists to prevent.
 *
 * With no verified name, this falls back to the host — a fact about the DID
 * itself, presented as such and never as a handle.
 */
export function DidNamed({
  value,
  agentName,
  verified = false,
  suffix,
}: {
  value: string;
  /** A name the document claims, already verified by the caller. */
  agentName?: AgentName;
  verified?: boolean;
  /** Appended to the name, e.g. a Pill. */
  suffix?: ReactNode;
}) {
  const handle = agentName ? displayAgentName(agentName) : undefined;
  const host = didHost(value);
  if (!handle && !host) return <Did value={value} verified={verified} />;
  return (
    <div style={{ display: "grid", gap: 3, minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span
          style={{
            fontSize: t.base,
            fontWeight: 640,
            color: verified ? c.ok : c.text,
            wordBreak: "break-word",
          }}
        >
          {handle ?? host}
        </span>
        {suffix}
      </div>
      <Did value={value} size={t.xs} />
    </div>
  );
}

export function Pill({ tone, children }: { tone: PillTone; children: ReactNode }) {
  return <span style={pill(tone)}>{children}</span>;
}

export function Button({
  kind = "default",
  onClick,
  disabled,
  title,
  children,
  style,
}: {
  kind?: ButtonKind;
  onClick?: ((e: MouseEvent<HTMLButtonElement>) => void) | undefined;
  disabled?: boolean;
  title?: string;
  children: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{ ...button(kind), ...(disabled ? { opacity: 0.5, cursor: "default" } : {}), ...style }}
    >
      {children}
    </button>
  );
}

/** A bordered panel with an optional heading and explanatory line. The
 *  description slot is not optional decoration — every setting in this wallet
 *  has a consequence, and the panel makes room for saying what it is. */
/**
 * Whether the surrounding surface has already drawn a card.
 *
 * A `Panel` inside a popover would paint a second bordered, padded box inside
 * one that already has a border and padding — a frame around a frame, 16px in
 * from an edge that is itself 15px in. Rather than thread a `bare` prop through
 * every editor that renders a Panel (four of them, none of which knows or
 * should know where it is being shown), the surface that owns the chrome says
 * so once, here.
 *
 * Deliberately a boolean about *chrome*, not about "popover": a future
 * side-drawer or inline expansion has the same problem and the same answer.
 */
export const ChromeProvided = createContext(false);

/**
 * A panel's explanation, clamped to its opening claim.
 *
 * The writing on these panes is unusually good and unusually long — two or
 * three sentences before anything actionable, on every pane, every visit. That
 * is load-bearing on the first read and furniture on the hundredth, and the
 * hundredth is the common case for a console.
 *
 * So the **first two lines stay** — which is where the claim is; the sentences
 * that follow are the elaboration — and the rest is one click away. Clamped by
 * line count rather than by sentence: splitting prose on full stops breaks on
 * `did:webvh:…`, on `0.3`, and on every abbreviation, and a paragraph cut in
 * the wrong place reads as a rendering fault.
 *
 * Deliberately not remembered. A disclosure that stays open is a preference
 * worth storing; this one costs a click and reopening it is how someone
 * re-reads a sentence they half remember.
 */
function Explanation({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLParagraphElement | null>(null);
  const [clamped, setClamped] = useState(false);

  // Whether there is anything hidden at all. Measured rather than guessed from
  // character count: the same string is two lines in one column width and four
  // in another, and a "more" button that reveals nothing is worse than no
  // button.
  useLayoutEffect(() => {
    const el = ref.current;
    if (el) setClamped(el.scrollHeight > el.clientHeight + 1);
  }, [children]);

  return (
    <div style={{ display: "grid", gap: 2 }}>
      <p
        ref={ref}
        style={{
          margin: 0,
          fontSize: t.sm,
          color: c.muted,
          lineHeight: 1.55,
          maxWidth: "82ch",
          ...(open
            ? {}
            : { display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }),
        }}
      >
        {children}
      </p>
      {(clamped || open) && (
        <button
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          style={{
            justifySelf: "start",
            border: "none",
            background: "transparent",
            color: c.accent,
            fontSize: t.xs,
            fontWeight: 600,
            cursor: "pointer",
            padding: "1px 0",
          }}
        >
          {open ? "Less" : "Why this matters"}
        </button>
      )}
    </div>
  );
}

export function Panel({
  title,
  description,
  children,
}: {
  title?: string;
  description?: ReactNode;
  children?: ReactNode;
}) {
  const bare = useContext(ChromeProvided);
  if (bare) {
    return (
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 10 }}>
        {title && <h2 style={{ margin: 0, fontSize: t.md, fontWeight: 640, paddingRight: 26 }}>{title}</h2>}
        {description && <Explanation>{description}</Explanation>}
        {children}
      </div>
    );
  }
  return (
    <section
      style={{
        background: c.surface,
        border: `1px solid ${c.line}`,
        borderRadius: "var(--w-r-md)",
        padding: "16px 18px",
        display: "grid",
        gap: 10,
      }}
    >
      {title && <h2 style={{ margin: 0, fontSize: t.md, fontWeight: 640 }}>{title}</h2>}
      {description && <Explanation>{description}</Explanation>}
      {children}
    </section>
  );
}

export type NoteTone = "warn" | "danger" | "accent";

/** A consequence the user should read before acting. Left-rule rather than a
 *  full tinted box so several can sit in a column without the page turning
 *  into a warning wall. */
export function Note({ tone = "warn", children }: { tone?: NoteTone; children: ReactNode }) {
  const map: Record<NoteTone, { edge: string; bg: string }> = {
    warn: { edge: c.warn, bg: c.warnSoft },
    danger: { edge: c.danger, bg: c.dangerSoft },
    accent: { edge: c.accent, bg: c.accentSoft },
  };
  const { edge, bg } = map[tone];
  return (
    <div
      style={{
        borderLeft: `2px solid ${edge}`,
        background: bg,
        padding: "9px 13px",
        borderRadius: "0 var(--w-r-sm) var(--w-r-sm) 0",
        fontSize: t.sm,
        lineHeight: 1.55,
        color: c.text,
      }}
    >
      {children}
    </div>
  );
}

/** Placeholder for a list with nothing in it. Says what would appear here,
 *  rather than just "None" — an empty state is a chance to explain. */
export function Empty({ children }: { children: ReactNode }) {
  return (
    <div style={{ fontSize: t.sm, color: c.faint, padding: "10px 0" }}>{children}</div>
  );
}

/**
 * Copy a value to the clipboard, and say whether it worked.
 *
 * **The refusal is the reason this is a component.** `navigator.clipboard`
 * rejects — a document without focus, a browser that has not granted the
 * permission — and the six places that had grown their own copy button each had
 * to remember that. A button that flips to "Copied" on a promise nobody awaited
 * tells the operator their DID is on the clipboard when it is not, and they find
 * out by pasting something else.
 *
 * Two seconds, then back: long enough to read, short enough that a second copy
 * of a *different* value is not mistaken for the first one still showing.
 */
export function CopyButton({
  value,
  label = "Copy",
  kind = "quiet",
  title,
}: {
  value: string;
  label?: string;
  kind?: ButtonKind;
  /** Which value this copies, for the accessible name. A row of identical
   *  "Copy" buttons is unusable with a screen reader without it. */
  title?: string;
}) {
  const [state, setState] = useState<"idle" | "done" | "refused">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = () => {
    clearTimeout(timer.current);
    navigator.clipboard.writeText(value).then(
      () => setState("done"),
      () => setState("refused"),
    );
    timer.current = setTimeout(() => setState("idle"), 2000);
  };

  return (
    <Button
      kind={kind}
      onClick={copy}
      {...(title ? { title: state === "refused" ? `${title} — the browser refused clipboard access` : title } : {})}
    >
      {state === "done" ? "Copied" : state === "refused" ? "Refused" : label}
    </Button>
  );
}
