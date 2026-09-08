/// <reference types="chrome" />

// The consent surface for `persona/disclosure` — the last screen before a
// person's identity leaves this machine.
//
// Everything it decides is decided in `@openvtc/pnm-core`'s `buildConsentView`,
// which is unit-tested against the shapes the agent actually returns. This file
// is the rendering, and it is deliberately thin: the ordering, the wording of a
// predicate, and the counting of what will not be sent are security properties,
// and a component is the wrong place to keep a security property because
// nothing tests a component's reasoning.
//
// The one thing this file decides on its own is emphasis, and it makes three
// choices:
//
//   - **Withheld rows are drawn as warnings, not as claims.** They are the only
//     rows whose presence makes the disclosure smaller than it looks.
//   - **A predicate is drawn in the positive colour.** It is the strongest
//     outcome on the screen — the verifier learns something and receives no value
//     — and drawing it in the same ink as an ordinary disclosure would hide the
//     one row where the holder gave away least.
//   - **Linkability leads when it is not `none`.** It sits above the claim list
//     rather than under it, because it is a property of the whole disclosure
//     and a reader who has already scrolled the list has already decided.

import { useEffect, useState } from "react";
import {
  buildConsentView,
  summarise,
  isLinkable,
  type DisclosureConsentView,
} from "@openvtc/pnm-core";
import type { DisclosurePreview } from "@openvtc/pnm-core";
import { Did } from "./ui.js";

/** What the background stores for the popup to read, keyed by consent id. */
export interface DisclosureConsentRequest {
  /** The agent's preview response, unchanged. */
  preview: DisclosurePreview;
  /** Who asked. The preview does not echo it. */
  verifierDid: string;
  /** Their stated reason, if any. */
  purpose?: string;
  /** The trust context, shown so the holder knows which of their worlds this is. */
  contextId: string;
  /** The persona that would present. */
  personaDid: string;
}

function Row({ row }: { row: DisclosureConsentView["rows"][number] }) {
  const tone =
    row.kind === "withheld"
      ? { fg: "var(--w-warn)", bg: "var(--w-warn-soft)" }
      : row.kind === "predicate"
        ? { fg: "var(--w-ok)", bg: "var(--w-ok-soft)" }
        : { fg: "var(--w-text)", bg: "transparent" };

  return (
    <li
      style={{
        listStyle: "none",
        padding: "8px 10px",
        borderRadius: "var(--w-r-sm)",
        background: tone.bg,
        marginBottom: 4,
      }}
    >
      <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
        {row.notices.length > 0 && (
          <span aria-hidden style={{ color: "var(--w-warn)", fontWeight: 700 }}>
            !
          </span>
        )}
        <code style={{ fontSize: "var(--w-t-sm)", color: "var(--w-muted)" }}>
          {row.type}
        </code>
      </div>
      <div style={{ color: tone.fg, fontSize: "var(--w-t-base)", marginTop: 2 }}>
        {row.shown}
      </div>
      {row.notices.length > 0 && (
        <div style={{ fontSize: "var(--w-t-xs)", color: "var(--w-muted)", marginTop: 2 }}>
          {row.notices
            .map(
              (n) =>
                ({
                  stale: "cannot be sent",
                  anomalous: "unusual for the stated purpose",
                  new: "this verifier has not had this before",
                  predicate: "proven, not shown",
                })[n],
            )
            .join(" · ")}
        </div>
      )}
    </li>
  );
}

export function DisclosureConsent({
  consentId,
  decide,
}: {
  consentId: string;
  decide: (approved: boolean) => void;
}) {
  const [request, setRequest] = useState<DisclosureConsentRequest | null>(null);

  useEffect(() => {
    void chrome.storage.session
      .get(`disclosure-consent:${consentId}`)
      .then((v: Record<string, unknown>) => {
        setRequest((v[`disclosure-consent:${consentId}`] as DisclosureConsentRequest) ?? null);
      });
  }, [consentId]);

  if (!request) {
    return <div style={{ padding: 20, fontSize: "var(--w-t-base)" }}>Loading request…</div>;
  }

  const view = buildConsentView(request.preview, {
    verifierDid: request.verifierDid,
    ...(request.purpose !== undefined ? { purpose: request.purpose } : {}),
  });
  const linkable = isLinkable(view);

  return (
    <div style={{ padding: 20, maxWidth: 520 }}>
      <h1 style={{ fontSize: "var(--w-t-lg)", margin: "0 0 4px" }}>Share your details?</h1>
      <p style={{ margin: "0 0 14px", color: "var(--w-muted)", fontSize: "var(--w-t-sm)" }}>
        Nothing has been sent yet.
      </p>

      <dl style={{ margin: "0 0 14px", fontSize: "var(--w-t-sm)" }}>
        <dt style={{ color: "var(--w-faint)" }}>To</dt>
        <dd style={{ margin: "0 0 6px" }}>
          <Did value={view.verifierDid} />
        </dd>
        {view.purpose !== undefined && (
          <>
            <dt style={{ color: "var(--w-faint)" }}>Because</dt>
            <dd style={{ margin: "0 0 6px" }}>{view.purpose}</dd>
          </>
        )}
        <dt style={{ color: "var(--w-faint)" }}>As</dt>
        <dd style={{ margin: 0 }}>
          <Did value={view.subject} />
          <div style={{ color: "var(--w-faint)", fontSize: "var(--w-t-xs)", marginTop: 2 }}>
            A one-off identifier for this verifier — it cannot be matched against
            what you have shared elsewhere.
          </div>
        </dd>
      </dl>

      {/* Above the list on purpose: a reader who has scrolled the list has
          already decided, and this is a property of the whole disclosure. */}
      {linkable && (
        <div
          style={{
            padding: "8px 10px",
            borderRadius: "var(--w-r-sm)",
            background:
              view.correlation.severity === "high"
                ? "var(--w-danger-soft)"
                : "var(--w-warn-soft)",
            color:
              view.correlation.severity === "high" ? "var(--w-danger)" : "var(--w-warn)",
            fontSize: "var(--w-t-sm)",
            marginBottom: 12,
          }}
        >
          <strong>
            {view.correlation.severity === "high"
              ? "This can be linked to you elsewhere."
              : "This is somewhat linkable."}
          </strong>
          {view.correlation.reason !== undefined && <div>{view.correlation.reason}</div>}
        </div>
      )}

      {view.renderer !== undefined && view.renderer.drops.length > 0 && (
        <div
          style={{
            fontSize: "var(--w-t-sm)",
            color: "var(--w-warn)",
            marginBottom: 12,
          }}
        >
          Sent as <code>{view.renderer.id}</code>, which drops{" "}
          {view.renderer.drops.join(", ")} — the verifier sees the values but not
          that they were attested.
        </div>
      )}

      <h2 style={{ fontSize: "var(--w-t-base)", margin: "0 0 6px" }}>{summarise(view)}</h2>
      {view.rows.length === 0 ? (
        <p style={{ color: "var(--w-muted)", fontSize: "var(--w-t-sm)" }}>
          This persona would share nothing with this verifier.
        </p>
      ) : (
        <ul style={{ padding: 0, margin: "0 0 16px" }}>
          {view.rows.map((r) => (
            <Row key={r.type} row={r} />
          ))}
        </ul>
      )}

      <div style={{ display: "flex", gap: 8 }}>
        <button type="button" onClick={() => decide(true)}>
          Share
        </button>
        <button type="button" onClick={() => decide(false)}>
          Don&apos;t share
        </button>
      </div>
    </div>
  );
}
