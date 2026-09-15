// Extra service entries, as rows rather than as JSON.
//
// The validation lives in `service-entries.ts` and the reasoning is there; this
// file only draws. Two choices worth saying out loud:
//
// **The id is a fragment, not a whole id.** A service id is `<did>#name`, and
// the DID does not exist until the entry naming it has been written — so there
// is no id to type. The operator names the fragment and the agent resolves
// `{DID}`, which is the same ambient placeholder a DID template uses.
//
// **A row is removed, never blanked.** `additionalServices` is published
// verbatim into an append-only log, so an entry half-filled and abandoned would
// be published as an entry. Clearing every field is how a row stops counting,
// and Remove is how it stops being on screen; the two must agree, which is what
// `isBlank` is for.

import { useCallback, useId } from "react";
import { Button } from "../../ui.js";
import { c, t, font } from "../../theme.js";
import {
  draftProblems,
  emptyDraft,
  isBlank,
  type ServiceDraft,
} from "../service-entries.js";
import { Field, fieldStyle, Label } from "./rooms-create-parts.js";

export function ServiceDrafts({
  drafts,
  onChange,
}: {
  drafts: ServiceDraft[];
  onChange: (next: ServiceDraft[]) => void;
}) {
  const seed = useId();

  const add = useCallback(() => {
    onChange([...drafts, emptyDraft(`${seed}-${drafts.length}-${Date.now()}`)]);
  }, [drafts, onChange, seed]);

  const patch = useCallback(
    (key: string, field: keyof ServiceDraft, value: string) => {
      onChange(drafts.map((d) => (d.key === key ? { ...d, [field]: value } : d)));
    },
    [drafts, onChange],
  );

  const remove = useCallback(
    (key: string) => onChange(drafts.filter((d) => d.key !== key)),
    [drafts, onChange],
  );

  const filled = drafts.filter((d) => !isBlank(d));

  return (
    <div style={{ display: "grid", gap: 9, minWidth: 0 }}>
      <Label hint="— written into the document exactly as you give them">
        OTHER SERVICE ENTRIES
      </Label>
      {drafts.length === 0 ? (
        <span style={{ fontSize: t.xs, color: c.muted, lineHeight: 1.5 }}>
          None. Add one to publish an endpoint of your own — a domain you control, an API others
          should reach you at. Your agent writes these through unchanged and does not check them.
        </span>
      ) : (
        <div style={{ display: "grid", gap: 12 }}>
          {drafts.map((draft) => {
            const problems = isBlank(draft) ? {} : draftProblems(draft, filled);
            return (
              <div
                key={draft.key}
                style={{
                  display: "grid",
                  gap: 8,
                  padding: "10px 12px",
                  border: `1px solid ${c.line}`,
                  borderRadius: "var(--w-r-sm)",
                  background: c.ground,
                  minWidth: 0,
                }}
              >
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-start" }}>
                  <Field label="NAME" hint="— the part after “#”">
                    <input
                      aria-label="Service name"
                      style={{ ...fieldStyle, width: "16ch", fontFamily: font.mono }}
                      value={draft.fragment}
                      placeholder="website"
                      spellCheck={false}
                      onChange={(e) => patch(draft.key, "fragment", e.target.value)}
                    />
                  </Field>
                  <Field label="TYPE">
                    <input
                      aria-label="Service type"
                      style={{ ...fieldStyle, width: "22ch" }}
                      value={draft.type}
                      placeholder="LinkedDomains"
                      spellCheck={false}
                      onChange={(e) => patch(draft.key, "type", e.target.value)}
                    />
                  </Field>
                  <Field label="ENDPOINT" grow="1 1 22rem">
                    <input
                      aria-label="Service endpoint"
                      style={{ ...fieldStyle, width: "100%", fontFamily: font.mono }}
                      value={draft.endpoint}
                      placeholder="https://example.com or did:…"
                      spellCheck={false}
                      autoCapitalize="none"
                      onChange={(e) => patch(draft.key, "endpoint", e.target.value)}
                    />
                  </Field>
                  <div style={{ paddingTop: 18 }}>
                    <Button kind="quiet" onClick={() => remove(draft.key)}>
                      Remove
                    </Button>
                  </div>
                </div>
                {(problems.fragment || problems.type || problems.endpoint) && (
                  <ul style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 2 }}>
                    {[problems.fragment, problems.type, problems.endpoint]
                      .filter((p): p is string => Boolean(p))
                      .map((p) => (
                        <li key={p} style={{ fontSize: t.xs, color: c.danger }}>
                          {p}
                        </li>
                      ))}
                  </ul>
                )}
                {!isBlank(draft) && draft.fragment.trim() && !problems.fragment && (
                  <span style={{ fontSize: t.xs, color: c.muted, fontFamily: font.mono, wordBreak: "break-all" }}>
                    <span style={{ color: c.faint }}>&lt;the new DID&gt;#</span>
                    <strong style={{ color: c.text }}>{draft.fragment.trim()}</strong>
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
      <div>
        <Button onClick={add}>Add a service entry</Button>
      </div>
    </div>
  );
}
