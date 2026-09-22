// Formats — what a renderer carries, and what it silently leaves behind.
//
// `persona/renderers/list` is `Reach::Any`: it names the agent's own output
// formats, never the holder or any context, so any authenticated caller may
// ask. It belongs beside the disclosure history because it answers the other
// half of the same question — the history says what left, and this says what
// shape it left in, which is the difference between "my employer attested this"
// and "they said so".
//
// The two states are not interchangeable and this panel keeps them apart: a
// format with an empty `drops` is lossless, while a format the agent does not
// offer at all has no `drops` to read. Rendering the second as "discards
// nothing" would tell a holder a format is safe when a disclosure through it is
// about to be refused.

import { listRenderers } from "@openvtc/pnm-core/persona";
import { Note, Panel } from "../../ui.js";
import { managerSender } from "../sender.js";
import { Loading, LoadError } from "../table.js";
import { useAsync } from "../use-async.js";
import type { Parties } from "../use-vta.js";

export function FormatsPanel({ parties }: { parties: Parties }) {
  const formats = useAsync(
    () => listRenderers(managerSender, parties),
    [parties.holder.did, parties.service.did],
  );

  return (
    <Panel
      title="Formats"
      description="When you show someone something, your agent renders it into one of these. What a format cannot carry is left out."
    >
      <div style={{ display: "grid", gap: 12 }}>
        {formats.loading && <Loading what="the formats your agent can produce" />}
        {formats.error && <LoadError what="its formats" error={formats.error} />}
        {formats.data?.renderers.map((r) => (
          <div key={r.id} style={{ display: "grid", gap: 4 }}>
            <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
              <strong style={{ fontFamily: "var(--w-mono)", fontSize: "var(--w-t-sm)" }}>
                {r.id}
              </strong>
              {r.canonical && (
                <span style={{ fontSize: "var(--w-t-xs)", color: "var(--w-accent)" }}>
                  your agent's own form, used when nothing names one
                </span>
              )}
            </div>
            {r.description && (
              <span style={{ fontSize: "var(--w-t-sm)" }}>{r.description}</span>
            )}
            <span
              style={{
                fontSize: "var(--w-t-xs)",
                color: r.drops.length > 0 ? "var(--w-warn)" : "var(--w-faint)",
              }}
            >
              {r.drops.length > 0 ? `drops: ${r.drops.join(", ")}` : "drops nothing"}
            </span>
            {!r.canCarryPredicates && (
              <span style={{ fontSize: "var(--w-t-xs)", color: "var(--w-faint)" }}>
                Cannot carry a fact you proved rather than showed. A disclosure that needs one
                fails here rather than quietly handing over the value itself.
              </span>
            )}
          </div>
        ))}
        {formats.data?.renderers.length === 0 && (
          <Note tone="warn">
            Your agent lists no formats. A disclosure will use whatever it defaults to, and this
            panel cannot say what that leaves out.
          </Note>
        )}
      </div>
    </Panel>
  );
}
