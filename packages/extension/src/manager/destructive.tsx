// Preview-then-confirm, and the consent ceremony that can interrupt it.
//
// ## Why the preview comes from the agent
//
// A generic "Are you sure?" is worth nothing: the operator already believes
// they are sure, and the dialog adds a click rather than information. What
// changes a decision is *what would actually be destroyed*, and only the agent
// knows that — `contextPreviewDelete` returns the real keys and DIDs a context
// holds, which is precisely the list an operator does not have in their head.
//
// So every irreversible action here is two calls: ask the agent what the change
// would cost, render its answer verbatim, then send the change. `force` is a
// separate explicit tick rather than something the confirm button implies,
// because the agent refuses a non-empty deletion on purpose and overriding that
// refusal is a second decision.
//
// ## Why `consentRequired` renders here
//
// The agent may answer "a human must approve this first". That is not a
// failure — the refusal carries the salted payload digest whose prefix the
// operator matches on their approving device. Rendering it as a red error would
// discard the informed-consent ceremony at the exact moment the human was meant
// to act, so it gets the same surface as the preview: this is the one place the
// console catches `ConsentRequiredError`.

import { useCallback, useState, type ReactNode } from "react";
import { Button, Note } from "../ui.js";
import { c, t, font } from "../theme.js";
import { ConsentRequiredError } from "./sender.js";

/** How much of the digest an operator compares across devices. The full value
 *  is unreadable aloud and nobody checks 64 characters; the prefix is what the
 *  approving surface shows too. */
const MATCH_CODE_LENGTH = 8;

function MatchCode({ digest }: { digest: string }) {
  const code = digest.slice(0, MATCH_CODE_LENGTH).toUpperCase();
  return (
    <span
      style={{
        fontFamily: font.mono,
        fontSize: t.lg,
        letterSpacing: 3,
        fontWeight: 650,
        color: c.text,
      }}
    >
      {code || "—"}
    </span>
  );
}

/** The ceremony panel. Shown in place of the confirm button once the agent has
 *  asked for approval; the operator's next move is on another device. */
export function ConsentCeremony({ pending }: { pending: ConsentRequiredError }) {
  return (
    <Note tone="accent">
      <div style={{ display: "grid", gap: 8 }}>
        <strong>Your agent will not run this until a human approves it.</strong>
        <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
          <span style={{ color: c.muted }}>Match code</span>
          <MatchCode digest={pending.payloadDigest} />
        </div>
        <span style={{ color: c.muted }}>
          Approve on your approving device, and check that the code shown there is the same. It
          is derived from this exact change — a different code means you would be approving
          something else.
          {pending.minApprovals > 1
            ? ` ${pending.minApprovals} approvals are required.`
            : ""}
        </span>
      </div>
    </Note>
  );
}

export interface DestructiveProps<P> {
  /** Button copy for the action itself, e.g. "Delete context". */
  label: string;
  /** Disabled reason, or null when the action is available. Shown rather than
   *  hiding the control — see `hasRole` in `use-vta.ts`. */
  disabledReason?: string | null;
  /** Ask the agent what the change would cost. */
  preview: () => Promise<P>;
  /** Render the agent's answer. Returning `false` from `blocking` keeps the
   *  confirm button disabled until `force` is ticked. */
  renderPreview: (preview: P) => ReactNode;
  /** Whether this preview describes collateral that `force` must override. */
  needsForce?: (preview: P) => boolean;
  /** Copy for the force tick, when `needsForce` is true. */
  forceLabel?: string;
  /** Perform it. */
  commit: (force: boolean) => Promise<void>;
  /** Called after a successful commit, so the caller can refetch. */
  onDone: () => void;
}

type Phase<P> =
  | { kind: "idle" }
  | { kind: "previewing" }
  | { kind: "preview"; preview: P }
  | { kind: "committing"; preview: P }
  | { kind: "consent"; pending: ConsentRequiredError }
  | { kind: "error"; message: string };

/**
 * The shared two-step for every irreversible action in this console.
 *
 * Generic over the preview shape because the previews differ (a context's keys
 * and DIDs, a key's usages, an ACL subject's grants) while the *shape of the
 * decision* does not: see the cost, then decide, with `force` as its own step.
 */
export function Destructive<P>({
  label,
  disabledReason = null,
  preview,
  renderPreview,
  needsForce,
  forceLabel = "Delete anyway, destroying the items listed above",
  commit,
  onDone,
}: DestructiveProps<P>) {
  const [phase, setPhase] = useState<Phase<P>>({ kind: "idle" });
  const [force, setForce] = useState(false);

  const reset = useCallback(() => {
    setPhase({ kind: "idle" });
    setForce(false);
  }, []);

  const start = useCallback(async () => {
    setPhase({ kind: "previewing" });
    try {
      setPhase({ kind: "preview", preview: await preview() });
    } catch (e) {
      setPhase({
        kind: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }, [preview]);

  const run = useCallback(
    async (p: P) => {
      setPhase({ kind: "committing", preview: p });
      try {
        await commit(force);
        reset();
        onDone();
      } catch (e) {
        // The one class that is not an error. See the header.
        if (e instanceof ConsentRequiredError) {
          setPhase({ kind: "consent", pending: e });
          return;
        }
        setPhase({ kind: "error", message: e instanceof Error ? e.message : String(e) });
      }
    },
    [commit, force, onDone, reset],
  );

  if (phase.kind === "idle") {
    return (
      <Button
        kind="danger"
        disabled={Boolean(disabledReason)}
        {...(disabledReason ? { title: disabledReason } : {})}
        onClick={() => void start()}
      >
        {label}
      </Button>
    );
  }

  if (phase.kind === "previewing") {
    return <span style={{ fontSize: t.sm, color: c.muted }}>Asking your agent what this would destroy…</span>;
  }

  if (phase.kind === "consent") {
    return (
      <div style={{ display: "grid", gap: 10 }}>
        <ConsentCeremony pending={phase.pending} />
        <div>
          <Button kind="quiet" onClick={reset}>
            Close
          </Button>
        </div>
      </div>
    );
  }

  if (phase.kind === "error") {
    return (
      <div style={{ display: "grid", gap: 10 }}>
        <Note tone="danger">{phase.message}</Note>
        <div>
          <Button kind="quiet" onClick={reset}>
            Back
          </Button>
        </div>
      </div>
    );
  }

  const p = phase.preview;
  const blocked = Boolean(needsForce?.(p)) && !force;
  const busy = phase.kind === "committing";

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <Note tone="danger">
        <div style={{ display: "grid", gap: 8 }}>{renderPreview(p)}</div>
      </Note>

      {needsForce?.(p) && (
        <label style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: t.sm }}>
          <input
            type="checkbox"
            checked={force}
            onChange={(e) => setForce(e.target.checked)}
            style={{ marginTop: 2 }}
          />
          <span>{forceLabel}</span>
        </label>
      )}

      <div style={{ display: "flex", gap: 8 }}>
        <Button kind="danger" disabled={blocked || busy} onClick={() => void run(p)}>
          {busy ? "Working…" : label}
        </Button>
        <Button kind="quiet" disabled={busy} onClick={reset}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/**
 * Run a non-destructive mutation, routing a consent refusal to the ceremony.
 *
 * Every mutating call in the console goes through this or through
 * {@link Destructive}; nothing calls an admin helper and catches `Error`
 * directly, because that is how a `ConsentRequiredError` ends up rendered as a
 * red string.
 */
export async function runMutation(
  action: () => Promise<void>,
  handlers: {
    onConsent: (pending: ConsentRequiredError) => void;
    onError: (message: string) => void;
  },
): Promise<boolean> {
  try {
    await action();
    return true;
  } catch (e) {
    if (e instanceof ConsentRequiredError) {
      handlers.onConsent(e);
      return false;
    }
    handlers.onError(e instanceof Error ? e.message : String(e));
    return false;
  }
}
