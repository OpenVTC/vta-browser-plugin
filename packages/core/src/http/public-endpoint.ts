// Is this URL one the wallet may dial?
//
// Two egress points ask that question of a URL nobody has vetted: the push
// gateway an operator types into Settings (`device/register-gateway.ts` POSTs
// `push/register` to it, unauthenticated, from the service worker), and the
// `baseUrl` a page hands the extension's authenticated proxy. It is the same
// question, so it is answered once, here.
//
// **The check is by literal, because that is the whole of what a browser can
// do.** There is no DNS API in an extension, so a public name that *resolves*
// to a private address — `127.0.0.1.nip.io`, a rebinding domain — cannot be
// seen from here and passes. Only a caller that sees the address closes that:
// Node's `undici` `lookup` hook, or a resolver behind an authenticated backend.
// Where a redirect could reach such a host, refusing the redirect
// (`redirect: "error"`) is the only re-vetting a browser offers, since
// `redirect: "manual"` yields an opaque response nothing can inspect.
//
// What it does check:
//
//   - the scheme is `https:`, unless the caller allows loopback for a service
//     running on the same machine;
//   - there is no userinfo — `https://vta.example@127.0.0.1/` is a request to
//     127.0.0.1 that reads as a request to vta.example;
//   - an IP literal is a public address. The WHATWG URL parser has already
//     canonicalised every spelling it accepts, so `0x7f000001`, `127.1`,
//     `2130706433` and `192.168.257` all arrive here as the dotted quad they
//     become, and the address judged is the one that would be dialled;
//   - a name is not local-only: `localhost`, anything under `.localhost`,
//     `.local`, `.internal` or `.home.arpa`, and any single-label name
//     (`intranet`, `metadata`) — none of which can name a host on the public
//     internet.
//
// The ranges and names deliberately match the did:webvh host guard and the
// `net-guard` module a coming `@openvtc/vti-didcomm-js` release carries. These
// should end up as one module; keeping the tables identical is what makes that
// a deletion rather than a reconciliation.

/** How strict to be about a particular endpoint. */
export interface PublicEndpointOptions {
  /**
   * Permit a loopback host, `http:` included. For a locally run VTA or the
   * demo RP — real targets, and the reason `content-registration.ts` keeps
   * `http://localhost/*` grantable. Off by default: an operator-configured
   * service reached over plain http on a public network is not a thing to
   * allow by omission.
   */
  allowLoopback?: boolean;
  /** What to call this URL in the error, e.g. `"push gateway URL"`. */
  what?: string;
}

/**
 * Return `url` parsed, or throw saying why it must not be contacted.
 *
 * @throws {Error} when the URL does not parse, is not https (or loopback http
 *   with {@link PublicEndpointOptions.allowLoopback}), carries userinfo, or
 *   names a non-public address or a local-only name.
 */
export function assertPublicHttpsUrl(input: string, opts: PublicEndpointOptions = {}): URL {
  const what = opts.what ?? "URL";
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error(`${what} ${JSON.stringify(input)} is not a URL, so nothing was sent to it`);
  }

  const host = canonicalHost(url.hostname);
  const loopback = opts.allowLoopback === true && isLoopbackHost(host);

  if (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) {
    throw new Error(
      `${what} ${url.href} is ${url.protocol} — it must be https, so nothing was sent to it`,
    );
  }
  // Checked after the scheme and before the host, because this is the case
  // where the host in the text and the host in the request differ.
  if (url.username !== "" || url.password !== "") {
    // The URL itself is deliberately not quoted back: it holds the credential.
    throw new Error(
      `${what} carries a username or password in the URL, which hides the host it would ` +
        `actually reach (${host}), so nothing was sent to it`,
    );
  }
  if (loopback) return url;
  if (!isPublicHost(url.hostname)) {
    throw new Error(
      `${what}'s host ${host} is not a public internet host, so nothing was sent to it`,
    );
  }
  return url;
}

/** True if `hostname` names this machine: `127.0.0.0/8`, `::1`, `localhost`. */
export function isLoopbackHost(hostname: string): boolean {
  const host = canonicalHost(hostname);
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "::1") return true;
  const v4 = parseIpv4(host);
  return v4 !== null && v4[0] === 127;
}

/**
 * True if `hostname` — as the URL parser canonicalised it, brackets and all —
 * can name a host on the public internet.
 *
 * Fails closed: a literal that does not parse as an address is not public.
 */
export function isPublicHost(hostname: string): boolean {
  const host = canonicalHost(hostname);
  if (host === "") return false;
  if (hostname.startsWith("[")) return isPublicIpv6(host);
  const v4 = parseIpv4(host);
  if (v4) return !v4Blocked(v4ToUint(v4));
  return !isLocalOnlyName(host);
}

// ─── Names ─────────────────────────────────────────────────────────────

// Each entry refuses the name itself and everything under it.
const LOCAL_ONLY_SUFFIXES = ["localhost", "local", "internal", "home.arpa"];

function isLocalOnlyName(host: string): boolean {
  if (!host.includes(".")) return true; // single label: `intranet`, `metadata`
  return LOCAL_ONLY_SUFFIXES.some((name) => host === name || host.endsWith(`.${name}`));
}

function canonicalHost(hostname: string): string {
  const h = hostname.toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) return h.slice(1, -1);
  return h.replace(/\.+$/, ""); // a trailing root dot names the same host
}

// ─── Addresses ─────────────────────────────────────────────────────────

// [network, prefix length] — everything an endpoint must not be.
const V4_BLOCKED: ReadonlyArray<readonly [string, number]> = [
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
  ["240.0.0.0", 4], //      reserved, incl. the 255.255.255.255 broadcast
];

function v4Blocked(n: number): boolean {
  return V4_BLOCKED.some(([net, prefix]) => {
    const parsed = parseIpv4(net);
    if (!parsed) return false;
    const shift = 32 - prefix;
    return n >>> shift === v4ToUint(parsed) >>> shift;
  });
}

/**
 * IPv6, judged on its first hextet and its shape rather than by a full parse.
 *
 * Global unicast is `2000::/3` — first hextet `0x2000`-`0x3fff` — and
 * everything outside it is unspecified, loopback, ULA (`fc00::/7`), link-local
 * (`fe80::/10`), multicast or reserved. Any form that embeds an IPv4 address
 * (`::ffff:10.0.0.1`, `::1.2.3.4`, 6to4 `2002:…`) is refused outright: the
 * address actually dialled is the embedded one, and re-deriving it here would
 * be a second, subtly different copy of the table above. An endpoint reached
 * through a translation prefix can be spelled as the plain address instead.
 */
function isPublicIpv6(host: string): boolean {
  if (host.includes(".")) return false; // embeds an IPv4 address
  const hextet = (index: number): number => {
    const piece = host.split(":")[index] ?? "";
    const n = Number.parseInt(piece, 16);
    return Number.isFinite(n) ? n : 0;
  };
  const first = host.startsWith("::") ? 0 : hextet(0);
  if (first < 0x2000 || first > 0x3fff) return false;
  if (first === 0x2002) return false; // 6to4 — carries an IPv4 address
  if (first === 0x2001) {
    const second = hextet(1);
    if (second < 0x200) return false; // IETF assignments: Teredo, benchmarking
    if (second === 0xdb8) return false; // documentation
  }
  if (first === 0x3fff && hextet(1) < 0x1000) return false; // documentation
  return true;
}

/** Strict dotted quad. The URL parser has already rewritten every other IPv4
 *  spelling into this form, so nothing else needs recognising. */
function parseIpv4(host: string): readonly number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const out: number[] = [];
  for (const octet of m.slice(1)) {
    if (octet.length > 1 && octet.startsWith("0")) return null;
    const n = Number(octet);
    if (n > 255) return null;
    out.push(n);
  }
  return out;
}

function v4ToUint(octets: readonly number[]): number {
  return (
    (((octets[0] ?? 0) << 24) >>> 0) +
    ((octets[1] ?? 0) << 16) +
    ((octets[2] ?? 0) << 8) +
    (octets[3] ?? 0)
  );
}
