// What the Mediator Lens shows, decided without React.
//
// Free of relative imports so it can be unit-tested in plain Node — the same
// constraint `carrier.ts` observes.

/** Where the lens is pointed: a relay, and the agent whose holder looks through it. */
export interface LensRoute {
  mediatorDid?: string;
  vtaDid?: string;
  /** A DID whose mediator the lens should find (the "where does its mail go" entry). */
  locate?: string;
}

/** `#mediator?relay=…&agent=…` → the route. Unknown members are ignored. */
export function parseLensRoute(hash: string): LensRoute {
  const q = hash.replace(/^#/, "").split("?")[1] ?? "";
  const params = new URLSearchParams(q);
  const out: LensRoute = {};
  const relay = params.get("relay");
  const agent = params.get("agent");
  const locate = params.get("locate");
  if (relay) out.mediatorDid = relay;
  if (agent) out.vtaDid = agent;
  if (locate) out.locate = locate;
  return out;
}

/** The hash that opens the lens at `route`. */
export function lensHref(route: LensRoute): string {
  const params = new URLSearchParams();
  if (route.mediatorDid) params.set("relay", route.mediatorDid);
  if (route.vtaDid) params.set("agent", route.vtaDid);
  if (route.locate) params.set("locate", route.locate);
  const q = params.toString();
  return q ? `#mediator?${q}` : "#mediator";
}

/** Seconds as the coarsest unit that reads naturally: `40s`, `18m`, `2h 14m`, `3d`. */
export function ageText(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds)) return "—";
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** Bytes in the unit a person reads: `512 B`, `20.5 KB`, `311 MB`. */
export function bytesText(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return "—";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/** A count with thousands folded: `418`, `92.4K`, `1.2M`. */
export function countText(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return "—";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}K`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** Uptime as days/hours/minutes. */
export function uptimeText(seconds: number): string {
  return ageText(seconds);
}

/**
 * How full a queue is, as a word the semantic colours can carry.
 *
 * Thresholds, not a gradient: the question an operator asks of a queue is
 * "does this need me", and three answers are the ones that change what they
 * do. `unlimited` is its own answer — a queue with no limit is not empty.
 */
export type Pressure = "ok" | "warn" | "danger" | "unlimited";

export function pressureOf(saturation: number | undefined): Pressure {
  if (saturation === undefined) return "unlimited";
  if (saturation >= 0.9) return "danger";
  if (saturation >= 0.65) return "warn";
  return "ok";
}

/** A shortened account hash for a table cell: `b48a…1f29`. */
export function shortHash(hash: string): string {
  return hash.length > 12 ? `${hash.slice(0, 4)}…${hash.slice(-4)}` : hash;
}

/** One glyph per traffic direction, so a scrolling tape scans without reading. */
export function directionGlyph(direction: string): string {
  if (direction === "inbound") return "▶";
  if (direction === "outbound") return "◀";
  return "·";
}

/**
 * Whether a monitor event describes something going wrong.
 *
 * A `refused` stage always does, and any event carrying an `outcome` does; an
 * `expired` message is one nobody collected, which is exactly the kind of
 * silent loss the lens exists to make visible.
 */
export function isTrouble(event: { stage: string; outcome?: unknown }): boolean {
  return event.stage === "refused" || event.stage === "expired" || event.outcome !== undefined;
}

/** Keep at most `max` items, newest last. */
export function capTape<T>(tape: readonly T[], add: readonly T[], max: number): T[] {
  const next = [...tape, ...add];
  return next.length > max ? next.slice(next.length - max) : next;
}

/** `security.trust_task_verification` as the lens reports it. `warn` runs an
 *  unverified task anyway, which is the setting worth flagging on a mediator
 *  that grants admin to browser-held keys. */
export function verificationModeOf(
  fields: readonly { key: string; value?: unknown }[] | undefined,
): "enforce" | "warn" | "unknown" {
  const f = fields?.find((x) => x.key === "security.trust_task_verification");
  if (f?.value === "enforce") return "enforce";
  if (f?.value === "warn") return "warn";
  return "unknown";
}
