// A DID's did:scid alias: whether its document lists it, and listing or
// removing it.
//
// **The consequence is not in the payload, so it is on the screen.** Listing
// the alias is a one-line change to `alsoKnownAs`, and publishing it rotates
// the DID's update key exactly as any other update does: the key that could
// authorise changes before this entry cannot afterwards, and the entry itself
// is permanent. `vta/webvh/dids/update/1.1` says a consent surface MUST say so,
// and the operator's consent surface here is the preview — so it does, before
// the button that publishes.
//
// The state is read from the latest log entry's document, which `did-detail`
// has already fetched. The request is a flag: the agent derives the DID URL
// itself, and reports it back as `scidDidUrl`, which is what is shown after.

import { useState } from "react";
import { webvhDidUpdate, type WebvhDidRecord } from "@openvtc/pnm-core/webvh";
import { CopyButton, Did, Note } from "../../ui.js";
import { c, t, font } from "../../theme.js";
import { managerSender } from "../sender.js";
import { RelayTaskError } from "../carrier.js";
import { Destructive } from "../destructive.js";
import { scidAliasOf } from "../scid-alias.js";
import type { LogEntry } from "../did-log.js";
import type { Parties } from "../use-vta.js";

type Published = Awaited<ReturnType<typeof webvhDidUpdate>>;

/** What the last attempt from this panel came to, kept until the next one. */
type Outcome = { kind: "published"; res: Published } | { kind: "noChange"; list: boolean };

const NO_CHANGE = "vta/webvh/dids/update:noChange";
const ALIAS_REQUIRED = "vta/webvh/dids/update:scidAliasRequired";
const VERSION_CONFLICT = "vta/webvh/dids/update:versionConflict";
const NOT_FOUND = "vta/webvh/dids/update:notFound";

const mono: React.CSSProperties = {
  fontFamily: font.mono,
  fontSize: t.xs,
  wordBreak: "break-all",
};

export function ScidAlias({
  parties,
  record,
  latest,
  disabledReason,
  onChanged,
}: {
  parties: Parties;
  record: WebvhDidRecord;
  /** The log's last entry, or `null` while the log is not in hand. */
  latest: LogEntry | null;
  disabledReason: string | null;
  /** After an attempt that may have appended to the log. */
  onChanged: () => void;
}) {
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  // The document's own id is the did:webvh form whichever form the agent
  // lists the record under; the record's is the fallback.
  const stateId = latest?.state?.["id"];
  const webvhDid =
    typeof stateId === "string" && stateId.startsWith("did:webvh:") ? stateId : record.did;
  // The identity the agent gives out is did:scid, which exists only while the
  // alias is listed — so removal is not offered, and the agent would refuse it.
  const presentedAsScid = record.did.startsWith("did:scid:");
  const alias = latest ? scidAliasOf(webvhDid, latest.state?.["alsoKnownAs"]) : null;
  if (latest && !alias) return null;

  const change = (list: boolean, label: string) => (
    <Destructive<boolean>
      label={label}
      disabledReason={disabledReason}
      preview={async () => list}
      renderPreview={(l) => <ChangePreview list={l} />}
      commit={async () => {
        setOutcome(null);
        try {
          const res = await webvhDidUpdate(managerSender, {
            ...parties,
            did: webvhDid,
            scidAlsoKnownAs: list,
            ...(latest?.versionId ? { expectedVersionId: latest.versionId } : {}),
            label: list ? "list the did:scid alias" : "remove the did:scid alias",
          });
          setOutcome({ kind: "published", res });
        } catch (e) {
          // `noChange` is an answer, not a failure: nothing was published and
          // the key did not rotate. The log is re-read either way.
          if (e instanceof RelayTaskError && e.code === NO_CHANGE) {
            setOutcome({ kind: "noChange", list });
            return;
          }
          throw refusalInWords(e);
        }
      }}
      onDone={onChanged}
    />
  );

  return (
    <div style={{ display: "grid", gap: 8, minWidth: 0 }}>
      <span
        style={{
          fontSize: t.xs,
          color: c.faint,
          textTransform: "uppercase",
          letterSpacing: 0.4,
          fontWeight: 640,
        }}
      >
        did:scid alias
      </span>

      {!latest && (
        <span style={{ fontSize: t.sm, color: c.muted }}>Reading this DID&apos;s document…</span>
      )}

      {alias?.kind === "listed" && (
        <div style={{ display: "grid", gap: 4, minWidth: 0 }}>
          <span style={{ fontSize: t.sm }}>
            Listed. The document names this log&apos;s did:scid DID in <code>alsoKnownAs</code>, so
            the two forms are one subject.
          </span>
          <AliasLine value={alias.url} />
        </div>
      )}
      {alias?.kind === "elsewhere" && (
        <div style={{ display: "grid", gap: 4, minWidth: 0 }}>
          <span style={{ fontSize: t.sm }}>
            Listed for an old location. <code>alsoKnownAs</code> names this log&apos;s did:scid DID
            with a locator that is not where the log is served now, so a recipient following it
            looks in the wrong place. Listing it again replaces it with the current one.
          </span>
          {alias.urls.map((u) => (
            <AliasLine key={u} value={u} />
          ))}
        </div>
      )}
      {alias?.kind === "absent" && (
        <span style={{ fontSize: t.sm }}>
          Not listed. This log also verifies{" "}
          <span style={mono}>did:scid:vh:1:{record.scid}</span>, but until the document lists it in{" "}
          <code>alsoKnownAs</code> the two are separate identities.
        </span>
      )}

      {alias && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-start" }}>
          {alias.kind === "absent" && change(true, "List the did:scid alias")}
          {alias.kind === "elsewhere" && change(true, "List it for this location")}
          {alias.kind !== "absent" && !presentedAsScid && change(false, "Remove the did:scid alias")}
        </div>
      )}
      {alias && alias.kind !== "absent" && presentedAsScid && (
        <span style={{ fontSize: t.xs, color: c.muted }}>
          Your agent gives this identity out as did:scid, which exists only while this document
          lists the alias — so it cannot be removed.
        </span>
      )}

      {outcome?.kind === "noChange" && (
        <Note tone="accent">
          Nothing published. The latest entry already{" "}
          {outcome.list ? "lists the alias for this location" : "lists no did:scid alias"}, so your
          agent made no entry and the update key did not rotate.
        </Note>
      )}
      {outcome?.kind === "published" && <PublishedCard res={outcome.res} />}
    </div>
  );
}

/** One did:scid DID URL, copyable. */
function AliasLine({ value }: { value: string }) {
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "flex-start", flexWrap: "wrap" }}>
      <Did value={value} size={t.xs} />
      <CopyButton value={value} title={`Copy ${value}`} />
    </div>
  );
}

/**
 * What publishing will do, said before it is done.
 *
 * The rotation leads, because it is the half nobody asked for: the operator
 * pressed a button about an alias and is about to replace the key that
 * controls the identity.
 */
function ChangePreview({ list }: { list: boolean }) {
  return (
    <>
      <strong>This publishes a new log entry and rotates this DID&apos;s update key.</strong>
      <span>
        {list
          ? "The document's alsoKnownAs gains the did:scid DID URL for where this log is served now, replacing any for an old location. From that entry on, the did:webvh and did:scid forms are one subject."
          : "Every did:scid entry for this log is removed from the document's alsoKnownAs. From that entry on, the did:webvh and did:scid forms are separate identities, and nothing may treat them as one."}
      </span>
      <span>
        The current update key stops being able to authorise changes, and new pre-rotation
        commitments are published. The entry is public and permanent: a later one can supersede it,
        nothing can unpublish it.
      </span>
    </>
  );
}

/** The entry the agent published, and the did:scid DID URL it reported. */
function PublishedCard({ res }: { res: Published }) {
  return (
    <Note tone="accent">
      <div style={{ display: "grid", gap: 7, minWidth: 0 }}>
        <strong>
          Published{" "}
          <span style={mono}>{res.newVersionId}</span>. The update key has rotated.
        </strong>
        {res.scidDidUrl && (
          <div style={{ display: "grid", gap: 4, minWidth: 0 }}>
            <span style={{ fontSize: t.xs, color: c.muted }}>
              {res.scidAlsoKnownAs
                ? "did:scid — listed in alsoKnownAs, the DID with the locator a recipient needs to resolve it"
                : "did:scid — not listed, so a separate identity verified by the same log"}
            </span>
            <div style={{ display: "flex", gap: 8, alignItems: "flex-start", flexWrap: "wrap" }}>
              <Did value={res.scidDidUrl} size={t.xs} />
              <CopyButton value={res.scidDidUrl} title="Copy the did:scid DID URL" />
            </div>
          </div>
        )}
        {res.serverless && (
          <span style={{ fontSize: t.sm }}>
            No hosting server serves this log, so the new entry does not resolve until you fetch the
            log and serve it again.
          </span>
        )}
      </div>
    </Note>
  );
}

/**
 * The refusals this action can meet, in words — matched on the agent's code
 * (R3.7). Anything else keeps the agent's own message.
 */
function refusalInWords(e: unknown): unknown {
  if (!(e instanceof RelayTaskError)) return e;
  switch (e.code) {
    case ALIAS_REQUIRED:
      return new Error(
        "Not removed. Your agent gives this identity out as did:scid, and that form exists only " +
          "while the did:webvh document lists the alias — removing it would end the identity. " +
          "Nothing was published.",
      );
    case VERSION_CONFLICT:
      return new Error(
        "Not published. This DID gained an entry since its log was read here, so the change " +
          "was refused rather than applied to a document you have not seen. Close the DID and " +
          "open it again to read its current state.",
      );
    case NOT_FOUND:
      return new Error(
        "Not published. Your agent holds no update key for this DID, so it cannot add an entry " +
          "to its log.",
      );
    default:
      return e;
  }
}
