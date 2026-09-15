// A did:webvh log, as something the console can list.
//
// `vta/webvh/dids/get` returns the log as **one string**: JSON Lines, one entry
// per line, in the order they were appended. That is the right wire shape — it
// is what the hosting server serves and what a verifier replays — and the wrong
// shape for a screen, so this turns it into records.
//
// **Every field here is optional, and the parser never fails on a line it does
// not recognise.** The log is the DID's whole history, written by whichever
// version of whichever agent held it at the time; a screen that refuses to draw
// a log because one entry has a member it did not expect is a screen that goes
// blank exactly for the DIDs whose history is worth reading. So an entry the
// parser cannot make sense of is still an entry: its raw line is kept, and the
// caller shows that.
//
// A plain module rather than part of the pane so a test can reach it — the pane
// is `.tsx`.

/** One line of the log. */
export interface LogEntry {
  /** Position in the log, from 1. Derived from order, never from the line —
   *  `versionId` is `<n>-<hash>` and an entry that omits it still has a place. */
  index: number;
  /** `versionId` as the entry spells it, e.g. `1-Qm…`. */
  versionId?: string;
  /** When this entry was appended, as the entry states it. */
  versionTime?: string;
  /** The entry's `parameters`, which is where `portable`, `scid`, `method`,
   *  `updateKeys` and `nextKeyHashes` live. */
  parameters?: Record<string, unknown>;
  /** The DID document this entry puts into effect. */
  state?: Record<string, unknown>;
  /** Proofs on the entry. Counted rather than rendered — an unsigned entry is
   *  worth noticing, and the signatures themselves are not readable. */
  proofCount: number;
  /** The line exactly as it arrived, for copying and for the entries this
   *  parser could not read. */
  raw: string;
  /** Why this line was not understood, or `null`. */
  problem: string | null;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Split a DID log into its entries.
 *
 * Blank lines are dropped — a trailing newline is normal JSONL and not an
 * entry. Everything else becomes a record, understood or not.
 */
export function parseDidLog(log: string): LogEntry[] {
  const lines = log.split("\n").filter((l) => l.trim() !== "");
  return lines.map((raw, i) => entryFromLine(raw, i + 1));
}

function entryFromLine(raw: string, index: number): LogEntry {
  const base = { index, proofCount: 0, raw };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...base, problem: "This line is not JSON." };
  }
  if (!isObject(parsed)) {
    return { ...base, problem: "This line is JSON, but not an object." };
  }

  const proof = parsed["proof"];
  return {
    ...base,
    ...(typeof parsed["versionId"] === "string" ? { versionId: parsed["versionId"] } : {}),
    ...(typeof parsed["versionTime"] === "string" ? { versionTime: parsed["versionTime"] } : {}),
    ...(isObject(parsed["parameters"]) ? { parameters: parsed["parameters"] } : {}),
    ...(isObject(parsed["state"]) ? { state: parsed["state"] } : {}),
    // A single proof may be an object rather than a one-element array — both
    // are legal in the data-integrity vocabulary, and counting only the array
    // form would report a signed entry as unsigned.
    proofCount: Array.isArray(proof) ? proof.length : isObject(proof) ? 1 : 0,
    problem: null,
  };
}

/**
 * The service entries a log entry's document publishes, flattened for a list.
 *
 * `serviceEndpoint` is deliberately stringified rather than rendered: it is
 * `string | object | array` in the DID Core vocabulary, and a screen that
 * assumed a string would print `[object Object]` for the two shapes a mediator
 * entry actually uses.
 */
export interface ServiceLine {
  id: string;
  type: string;
  endpoint: string;
}

export function servicesOf(entry: LogEntry): ServiceLine[] {
  const raw = entry.state?.["service"];
  if (!Array.isArray(raw)) return [];
  return raw.filter(isObject).map((s) => ({
    id: typeof s["id"] === "string" ? s["id"] : "",
    type:
      typeof s["type"] === "string"
        ? s["type"]
        : Array.isArray(s["type"])
          ? s["type"].join(", ")
          : "",
    endpoint:
      typeof s["serviceEndpoint"] === "string"
        ? s["serviceEndpoint"]
        : s["serviceEndpoint"] === undefined
          ? ""
          : JSON.stringify(s["serviceEndpoint"]),
  }));
}

/** The verification-method ids a log entry's document declares. */
export function methodsOf(entry: LogEntry): string[] {
  const raw = entry.state?.["verificationMethod"];
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(isObject)
    .map((m) => m["id"])
    .filter((id): id is string => typeof id === "string");
}
