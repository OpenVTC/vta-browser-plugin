// Backup — one control, and an honest account of the four that are missing.
//
// The agent dispatches five backup verbs. This pane offers `abort`. The rest of
// the surface is a written explanation of why export and import are not here,
// because an empty pane is indistinguishable from an unfinished one, and the
// next person to open this file should find a decision rather than a gap.
//
// The short version: `initiate-export` and `finalize-import` carry a `password`
// member — the key that protects, or unlocks, a complete copy of the agent. It
// travels inbound, typed by the operator. A browser form is reachable by
// autofill, by a password manager, by any other extension with host access, and
// by screen capture, and a passkey step-up does not help: it proves a human is
// present for the *action*, and says nothing about a field that was filled in
// before the prompt appeared.
//
// Abort carries no secret and is the only way to close a window that is
// otherwise open until it expires. So it is here, behind the step-up, and the
// step-up is about deliberateness rather than secrecy — see `step-up.ts` for
// what that ceremony does and does not prove.

import { useCallback, useState } from "react";
import { backupAbort, type BackupAbortResult } from "@openvtc/pnm-core/admin";
import { Button, Note, Panel } from "../../ui.js";
import { c, t, font } from "../../theme.js";
import { managerSender } from "../sender.js";
import { ConsentRequiredError } from "../carrier.js";
import { ConsentCeremony, runMutation } from "../destructive.js";
import { requirePresence, StepUpError } from "../step-up.js";
import { hasRole, type Authority, type Parties } from "../use-vta.js";

const fieldStyle: React.CSSProperties = {
  boxSizing: "border-box",
  padding: "6px 9px",
  background: c.ground,
  color: c.text,
  border: `1px solid ${c.line}`,
  borderRadius: "var(--w-r-sm)",
  fontSize: t.sm,
  fontFamily: font.mono,
};

// The agent generates these, and there is no verb that lists them — so the
// operator pastes what the CLI printed. Checked here only so an obvious typo is
// caught before a round trip, never as authorization: the agent decides whether
// this caller may touch this bundle, and answers a stranger's guess as
// not-found rather than as a refusal.
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;


// The CLI half of the answer.
//
// Telling an operator "use the CLI" and stopping there sends them to
// `--help` to find out what this pane already knows. The commands are
// short enough to print, and the two details worth knowing are not
// discoverable from a flag list: `--preview` is a real rehearsal, and the
// password is prompted rather than passed.
function Cmd({ children, note }: { children: string; note: string }) {
  return (
    <div style={{ display: "grid", gap: 3 }}>
      <code
        style={{
          fontFamily: font.mono,
          fontSize: t.xs,
          background: c.ground,
          border: `1px solid ${c.line}`,
          borderRadius: "var(--w-r-sm)",
          padding: "6px 9px",
          overflowX: "auto",
          whiteSpace: "pre",
        }}
      >
        {children}
      </code>
      <span style={{ fontSize: t.xs, color: c.faint }}>{note}</span>
    </div>
  );
}

function WhyExportIsAbsent() {
  return (
    <Panel
      title="Export and import are done from the CLI"
      description="Not missing — declined, and it is worth knowing why before you go looking for them."
    >
      <div style={{ display: "grid", gap: 12, fontSize: t.sm, lineHeight: 1.6, color: c.muted }}>
        <p style={{ margin: 0 }}>
          Starting an export, and finishing an import, both require the{" "}
          <strong style={{ color: c.text }}>password that protects the whole bundle</strong> — every
          key, access-control entry and trust context the agent holds. It is sent{" "}
          <em>to</em> the agent, which means something has to collect it first.
        </p>
        <p style={{ margin: 0 }}>
          A field in a browser page is reachable by autofill, by a password manager, by any other
          extension you have granted access to this page, and by anything recording the screen. None
          of that is under this wallet's control. Asking for the approval prompt first would not
          change it: that prompt proves a human is here for the action, and the password was typed
          before it appeared.
        </p>
        <p style={{ margin: 0 }}>
          So the wallet does not ask for it at all. The CLI collects it in a terminal, which is not a
          perfect place either, but is a much smaller one.
        </p>
        <div style={{ display: "grid", gap: 8, paddingTop: 2 }}>
          <span style={{ fontSize: t.xs, color: c.muted, letterSpacing: 0.4 }}>
            WHAT TO RUN
          </span>
          <Cmd note="Writes vta-backup-<timestamp>.vtabak. Add -o <path> to choose the file.">
            pnm backup export
          </Cmd>
          <Cmd note="Adds the agent's audit trail — its dealings with counterparties who were never party to this export. Off by default.">
            pnm backup export --include-audit
          </Cmd>
          <Cmd note="Rehearses: decrypts, validates, reports what it found, changes nothing. Worth doing first — the common mistake is the right password on the wrong bundle.">
            pnm backup import &lt;file&gt; --preview
          </Cmd>
          <Cmd note="Applies it. Replaces this agent's keys, access and contexts with the bundle's.">
            pnm backup import &lt;file&gt;
          </Cmd>
          <span style={{ fontSize: t.sm, color: c.muted, lineHeight: 1.55 }}>
            The password is <strong>prompted, never passed as a flag</strong> — there is no
            <code style={{ fontFamily: font.mono, fontSize: t.xs }}> --password</code> option to
            find. That is the concrete reason the terminal is the smaller surface: it keeps the
            password out of your shell history and out of the process list. Minimum 15
            characters, and export asks twice.
          </span>
        </div>

        <Note tone="accent">
          <strong>Where the bundle goes.</strong> An export is fetched over HTTPS from an address the
          agent publishes, so an agent reachable only over DIDComm or TSP cannot produce one at all —
          it has no address to hand you, and will say so rather than returning a link that does not
          work. That is a fact about how the agent is deployed, not something the console can work
          around.
        </Note>
      </div>
    </Panel>
  );
}

export function BackupPane({
  parties,
  authority,
}: {
  parties: Parties;
  authority: Authority | null;
}) {
  const [bundleId, setBundleId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<ConsentRequiredError | null>(null);
  const [result, setResult] = useState<BackupAbortResult | null>(null);

  const denied =
    authority && !hasRole(authority, "admin", "super-admin", "operator")
      ? "Cancelling a backup bundle needs an administrative role at this agent."
      : null;

  const malformed = bundleId.trim() !== "" && !UUID.test(bundleId.trim());

  const abort = useCallback(async () => {
    setError(null);
    setPending(null);
    setResult(null);

    // The step-up runs FIRST, and nothing is sent if it does not complete.
    // Dismissing is a decision, not a fault: the pane goes quiet rather than
    // reporting an error the operator caused on purpose.
    try {
      await requirePresence(chrome.runtime.id, "cancel a backup bundle");
    } catch (e) {
      if (e instanceof StepUpError && e.reason === "cancelled") return;
      setError(e instanceof Error ? e.message : String(e));
      return;
    }

    setBusy(true);
    const ok = await runMutation(
      async () => {
        setResult(
          await backupAbort(managerSender, { ...parties, bundleId: bundleId.trim() }),
        );
      },
      { onConsent: setPending, onError: setError },
    );
    setBusy(false);
    if (ok) setBundleId("");
  }, [parties, bundleId]);

  return (
    <div style={{ display: "grid", gap: 16, alignContent: "start" }}>
      <Panel
        title="Cancel a backup bundle"
        description="Discards the staged bytes and closes the bundle. On the export side the encrypted
          copy is deleted and cannot be re-minted — a new export re-reads the agent and produces
          different bytes."
      >
        <div style={{ display: "grid", gap: 12 }}>
          <Note tone="accent">
            <strong>There is no list to pick from.</strong> The agent offers no way to ask which
            bundles are in flight, so paste the bundle id the CLI printed. Nothing is lost by getting
            it wrong: an id the agent does not recognise, or one belonging to another operator, comes
            back the same way — not found.
          </Note>

          <label style={{ display: "grid", gap: 4 }}>
            <span style={{ fontSize: t.xs, color: c.muted }}>BUNDLE ID</span>
            <input
              style={fieldStyle}
              value={bundleId}
              onChange={(e) => setBundleId(e.target.value)}
              placeholder="3f2504e0-4f89-41d3-9a0c-0305e82c3301"
              spellCheck={false}
            />
          </label>
          {malformed && (
            <span style={{ fontSize: t.xs, color: c.muted }}>
              That is not the shape of a bundle id. They are UUIDs, and the agent generates them.
            </span>
          )}

          {error && <Note tone="danger">{error}</Note>}
          {pending && <ConsentCeremony pending={pending} />}

          {result &&
            (result.aborted ? (
              <Note tone="accent">
                Bundle cancelled. Its staged bytes are gone and the download address no longer works.
              </Note>
            ) : (
              // Not an error. Abort is idempotent because the situation it
              // exists for — a dropped connection, an operator unsure whether
              // the cancel landed — is the one that produces duplicates.
              <Note tone="accent">
                That bundle was already closed: completed, expired, or cancelled earlier. Nothing was
                left to discard, and nothing changed.
              </Note>
            ))}

          <div>
            <Button
              kind="danger"
              disabled={busy || !UUID.test(bundleId.trim()) || Boolean(denied)}
              {...(denied ? { title: denied } : {})}
              onClick={() => void abort()}
            >
              {busy ? "Cancelling…" : "Approve and cancel bundle"}
            </Button>
          </div>
          <span style={{ fontSize: t.xs, color: c.faint }}>
            {denied ?? "Your passkey is checked before anything is sent."}
          </span>
        </div>
      </Panel>

      <WhyExportIsAbsent />
    </div>
  );
}
