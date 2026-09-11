// What an operator runs to bring a room host up, as the New room form prints it.
//
// A printed command is a decision here, the same way `grant-command.ts` is: the
// operator pastes it into a terminal, and the host comes up with whatever
// identity and authority it names. Both ways of getting it wrong are silent:
//
// - A grant with no `--contexts` is not "no contexts" but every context the
//   agent has — to a process that holds ciphertext and needs one.
// - A host started without `--vta-context` enrols into `rooms`, room-host's
//   default, and serves as whatever DID *that* context carries rather than the
//   one just minted. Nothing about that looks wrong until a member resolves it.
//
// The flags are room-host's own (`room-host/src/main.rs` in
// verifiable-trust-infrastructure, as of #1418): `--vta-did` and `--vta-context`
// need a build with the `onboarding` feature, `--mediator-did` the `didcomm` one.
// The grant mirrors the text room-host itself prints on first start.
//
// A plain module rather than part of the form, so a test can reach it.

export interface RoomHostSetup {
  /** The agent the host enrols with — this console's VTA. */
  agentDid: string;
  /** The context whose DID the host serves as, and the one it is granted on. */
  context: string;
  /** Where members reach it over DIDComm and TSP. Absent: HTTP only. */
  mediatorDid?: string | undefined;
}

/** A value as a shell word: bare where nothing would split or expand it. */
function word(value: string): string {
  return /^[A-Za-z0-9._:/@+=#-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The command that starts room-host enrolled with this agent. */
export function roomHostCommand(setup: RoomHostSetup): string {
  return [
    "room-host",
    // Plain HTTP on loopback: TLS is whatever sits in front of it.
    "--listen 127.0.0.1:8300",
    // Without it the host resolves only did:key issuers, and a room's
    // credentials are issued by a did:webvh room — so it would serve almost
    // nothing, while looking healthy.
    "--resolve-dids",
    `--vta-did ${word(setup.agentDid)}`,
    `--vta-context ${word(setup.context)}`,
    ...(setup.mediatorDid ? [`--mediator-did ${word(setup.mediatorDid)}`] : []),
  ].join(" \\\n  ");
}

/**
 * The grant for the throwaway DID room-host prints on its first start.
 *
 * `application`, on exactly one context: a host holds ciphertext it cannot read,
 * so it needs to act in its context and needs no authority over it.
 */
export function hostGrantCommand(context: string): string {
  return `pnm acl create --did <the did:key it prints> --role application --contexts ${word(context)}`;
}

/** The hostname a certificate must name, from the host's URL. */
export function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

/**
 * The one wildcard that covers `hostname`, or `null` for a name too short to
 * have one (`example.net` has no parent a wildcard could sit on).
 *
 * A wildcard matches exactly one label, so the only wildcard naming
 * `rooms.vdr.example.net` is `*.vdr.example.net` — `*.example.net` does not,
 * which is precisely the certificate a subdomain deployment tends to already
 * have.
 */
export function coveringWildcard(hostname: string): string | null {
  const labels = hostname.split(".");
  return labels.length >= 3 ? `*.${labels.slice(1).join(".")}` : null;
}
