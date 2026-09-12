// Host guard for did:webvh resolution.
//
// A did:webvh names the host its log is fetched from, and the wallet resolves
// DIDs it did not choose: the consent prompt resolves whatever `rpDid` a page
// hands it, with no host grant and no user gesture (see
// `extension/src/host-permissions.ts`). Without a check here, a page can point
// the extension at `localhost`, a router on the local network, or a cloud
// metadata endpoint, and have it make that request while the prompt is still
// on screen.
//
// So before resolving, the host is judged here:
//
//   - it is percent-decoded (webvh encodes the port's `:`) and parsed with the
//     WHATWG URL parser, which is what the resolver itself uses to build the
//     fetch URL. That canonicalises every numeric spelling the parser accepts:
//     `127.1`, `0x7f000001`, `2130706433` and `192.168.257` are all judged as
//     the dotted-quad address they become;
//   - an IP literal is refused unless it is a public address: loopback,
//     RFC 1918, link-local and cloud metadata, CGNAT, `0.0.0.0/8`, broadcast,
//     and for IPv6 loopback, ULA, link-local and IPv4-mapped / -compatible
//     forms (judged by the embedded IPv4 address);
//   - a name is refused if it is `localhost`, ends in `.localhost`, `.local`,
//     `.internal` or `.home.arpa`, or is a single label (`intranet`), since
//     none of those can name a host on the public internet.
//
// This does not rely on `didwebvh-ts`'s own `isIPAddress` check. That check is
// incomplete (it misses every numeric form above and all names), and it could
// change on a dependency bump without anyone here noticing.
//
// What this cannot do: an extension has no DNS API, so a public name that
// *resolves* to a private address (`127.0.0.1.nip.io`, a rebinding domain)
// passes. Only a resolver that can see the address can stop that.
//
// The blocked ranges, names, error code and reasons deliberately match
// `net-guard.js` in `@openvtc/vti-didcomm-js`, so this module can be replaced
// by that one once it is released.

import { didWebvhDomain } from "./verify.js";

/** Stable `code` carried by every {@link BlockedEndpointError}. Match on this,
 *  never on the message (R3.7). */
export const BLOCKED_ENDPOINT = "E_BLOCKED_ENDPOINT";

/** Why a host was refused. */
export type BlockedReason = "invalid_url" | "private_address" | "private_name";

/** Thrown when a DID's host must not be contacted. */
export class BlockedEndpointError extends Error {
  readonly code = BLOCKED_ENDPOINT;
  readonly reason: BlockedReason;
  /** The canonical host that was judged, when there was one. */
  readonly host: string | undefined;

  constructor(message: string, reason: BlockedReason, host?: string) {
    super(message);
    this.name = "BlockedEndpointError";
    this.reason = reason;
    this.host = host;
  }
}

/**
 * True when `err` is a refusal to contact an endpoint.
 *
 * Structural on `code`, deliberately. There are two guards carrying this one
 * code: this module, for the host a did:webvh names, and
 * `@openvtc/vti-didcomm-js/net-guard`, for the endpoints a mediator's DID
 * document advertises and a VTA's REST base. They are separate classes, so an
 * `instanceof` here would silently miss the library's — which is the one a
 * hostile mediator document trips. Matching the code is the whole point of
 * having a stable one (R3.7).
 */
export function isBlockedEndpointError(err: unknown): err is Error & {
  code: typeof BLOCKED_ENDPOINT;
  reason?: string;
  host?: string;
  url?: string;
  label?: string;
} {
  return err instanceof Error && (err as { code?: unknown }).code === BLOCKED_ENDPOINT;
}

/**
 * Throw unless `did` is a did:webvh whose host is safe to fetch from: a public
 * IP address, or a name that is not local-only.
 *
 * @throws {BlockedEndpointError} with `reason` `"invalid_url"` when there is no
 *   usable host, `"private_address"` for a non-public IP literal, and
 *   `"private_name"` for a local-only name.
 */
export function assertResolvableWebvhHost(did: string): void {
  const raw = didWebvhDomain(did);
  const invalid = () =>
    new BlockedEndpointError(
      `the DID's host ${JSON.stringify(raw ?? "")} is not a valid host name, so it was not contacted`,
      "invalid_url",
    );
  if (!raw) throw invalid();

  let decoded: string;
  try {
    decoded = decodeURIComponent(raw).normalize("NFC");
  } catch {
    throw invalid();
  }
  // Anything that could make the URL parser see a different host from the one
  // the DID names: userinfo (`a@127.0.0.1`), a path, a query or fragment, a
  // second layer of percent-encoding, or whitespace. No real host contains one.
  if (decoded === "" || /[/\\@?#%\s]/.test(decoded)) throw invalid();

  // Parsing `host[:port]` as an authority both strips the port and applies the
  // parser's host canonicalisation. An unbracketed IPv6 literal fails here,
  // which refuses it.
  let url: URL;
  try {
    url = new URL(`https://${decoded}/`);
  } catch {
    throw invalid();
  }
  if (url.username !== "" || url.password !== "" || url.pathname !== "/") throw invalid();

  const bracketed = url.hostname.startsWith("[");
  const host = canonicalHost(url.hostname);
  if (host === "") throw invalid();

  if (bracketed || parseIpv4(host)) {
    if (isBlockedIp(host)) {
      // Name the spelling when the parser rewrote it (`127.1`, `0x7f000001`),
      // so the person reading the prompt can see what it really was.
      const written =
        bracketed || decoded.toLowerCase().startsWith(host) ? "" : ` (written ${decoded})`;
      throw new BlockedEndpointError(
        `the DID's host ${host}${written} is not a public internet address, so it was not contacted`,
        "private_address",
        host,
      );
    }
    return;
  }
  if (isBlockedName(host)) {
    throw new BlockedEndpointError(
      `the DID's host ${host} is a local-network name, not a public internet host, so it was not contacted`,
      "private_name",
      host,
    );
  }
}

// ─── Names ─────────────────────────────────────────────────────────────

// Each entry blocks the name itself and every name under it.
const BLOCKED_NAMES = ["localhost", "local", "internal", "home.arpa"];

function isBlockedName(host: string): boolean {
  if (!host.includes(".")) return true; // single label: `intranet`, `metadata`
  return BLOCKED_NAMES.some((name) => host === name || host.endsWith(`.${name}`));
}

function canonicalHost(hostname: string): string {
  const h = hostname.toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) return h.slice(1, -1);
  return h.replace(/\.+$/, "");
}

// ─── IP classification ─────────────────────────────────────────────────

type Ipv4 = readonly [number, number, number, number];

// [network, prefix length].
const V4_BLOCKED: ReadonlyArray<readonly [number, number]> = (
  [
    ["0.0.0.0", 8], //        "this network"
    ["10.0.0.0", 8], //       private (RFC 1918)
    ["100.64.0.0", 10], //    shared address space / CGNAT
    ["127.0.0.0", 8], //      loopback
    ["169.254.0.0", 16], //   link-local, incl. cloud metadata
    ["172.16.0.0", 12], //    private (RFC 1918)
    ["192.0.0.0", 24], //     IETF protocol assignments
    ["192.0.2.0", 24], //     documentation (TEST-NET-1)
    ["192.168.0.0", 16], //   private (RFC 1918)
    ["198.18.0.0", 15], //    benchmarking
    ["198.51.100.0", 24], //  documentation (TEST-NET-2)
    ["203.0.113.0", 24], //   documentation (TEST-NET-3)
    ["224.0.0.0", 4], //      multicast
    ["240.0.0.0", 4], //      reserved, incl. 255.255.255.255 broadcast
  ] as const
).map(([net, prefix]) => [v4ToUint(parseIpv4(net)!), prefix] as const);

/**
 * True if `ip` (dotted-quad IPv4, or IPv6 with or without brackets) is not a
 * public address. Fails closed: anything that is not a well-formed literal
 * returns `true`.
 */
function isBlockedIp(ip: string): boolean {
  const v4 = parseIpv4(ip);
  if (v4) return v4Blocked(v4ToUint(v4));
  const v6 = parseIpv6(ip);
  if (v6) return v6Blocked(v6);
  return true;
}

function v4Blocked(n: number): boolean {
  return V4_BLOCKED.some(([net, prefix]) => {
    const shift = 32 - prefix;
    return n >>> shift === net >>> shift;
  });
}

function v6Blocked(groups: readonly number[]): boolean {
  const g = (i: number): number => groups[i] ?? 0;
  const zeros = (from: number, to: number) => groups.slice(from, to).every((x) => x === 0);
  const embedded = (hi: number, lo: number) => v4Blocked(((hi << 16) >>> 0) + lo);

  // ::/96: unspecified, loopback and IPv4-compatible (`::a.b.c.d`). `::` and
  // `::1` land in 0.0.0.0/8 and are blocked.
  if (zeros(0, 6)) return embedded(g(6), g(7));
  // ::ffff:0:0/96 IPv4-mapped.
  if (zeros(0, 5) && g(5) === 0xffff) return embedded(g(6), g(7));
  // ::ffff:0:0:0/96 IPv4-translated (RFC 2765).
  if (zeros(0, 4) && g(4) === 0xffff && g(5) === 0) return embedded(g(6), g(7));
  // 64:ff9b::/96 well-known NAT64 prefix.
  if (g(0) === 0x64 && g(1) === 0xff9b && zeros(2, 6)) return embedded(g(6), g(7));
  // 64:ff9b:1::/48 local-use NAT64: can translate to anything.
  if (g(0) === 0x64 && g(1) === 0xff9b && g(2) === 1) return true;
  // 2002::/16 6to4: the IPv4 address sits in groups 1-2.
  if (g(0) === 0x2002) return embedded(g(1), g(2));
  // 2001::/23 IETF protocol assignments (Teredo, benchmarking, ORCHID).
  if (g(0) === 0x2001 && g(1) < 0x200) return true;
  // 2001:db8::/32 and 3fff::/20 documentation.
  if (g(0) === 0x2001 && g(1) === 0xdb8) return true;
  if (g(0) === 0x3fff && (g(1) & 0xf000) === 0) return true;
  // Everything outside 2000::/3 global unicast is reserved or local
  // (fc00::/7 ULA, fe80::/10 link-local, fec0::/10 site-local, ff00::/8
  // multicast, 100::/64 discard).
  return (g(0) & 0xe000) !== 0x2000;
}

// Strict dotted-quad: four decimal octets, no leading zeros. The URL parser
// has already rewritten every other IPv4 spelling into this form.
function parseIpv4(s: string): Ipv4 | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  const out: number[] = [];
  for (const octet of m.slice(1)) {
    if (octet.length > 1 && octet.startsWith("0")) return null;
    const n = Number(octet);
    if (n > 255) return null;
    out.push(n);
  }
  return out as unknown as Ipv4;
}

function v4ToUint([a, b, c, d]: Ipv4): number {
  return ((a << 24) >>> 0) + (b << 16) + (c << 8) + d;
}

// RFC 4291 text form → eight 16-bit groups, or null. Zone IDs are refused.
function parseIpv6(input: string): number[] | null {
  let s = input;
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
  if (!/^[0-9A-Fa-f:.]+$/.test(s)) return null;
  const lastColon = s.lastIndexOf(":");
  if (lastColon === -1) return null;

  let tail: number[] = [];
  if (s.includes(".")) {
    const v4 = parseIpv4(s.slice(lastColon + 1));
    if (!v4) return null;
    tail = [(v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]];
    s = s.slice(0, lastColon + 1);
    if (!s.endsWith("::")) s = s.slice(0, -1);
  }

  const want = 8 - tail.length;
  const groups = (part: string): number[] | null => {
    if (part === "") return [];
    const out: number[] = [];
    for (const piece of part.split(":")) {
      if (!/^[0-9A-Fa-f]{1,4}$/.test(piece)) return null;
      out.push(parseInt(piece, 16));
    }
    return out;
  };

  const gap = s.indexOf("::");
  if (gap === -1) {
    const all = groups(s);
    if (!all || all.length !== want) return null;
    return [...all, ...tail];
  }
  if (gap !== s.lastIndexOf("::")) return null;
  const head = groups(s.slice(0, gap));
  const rest = groups(s.slice(gap + 2));
  if (!head || !rest) return null;
  const fill = want - head.length - rest.length;
  if (fill < 1) return null;
  return [...head, ...new Array<number>(fill).fill(0), ...rest, ...tail];
}
