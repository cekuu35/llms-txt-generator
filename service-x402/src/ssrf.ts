/**
 * SSRF defense. Two layers:
 *  - `assertUrlAllowedStatic`  : URL-shape checks (scheme, credentials, port,
 *                                 literal-IP hostnames). Runs before payment.
 *  - `assertAddressAllowed`    : classifies a *resolved* IP and rejects any
 *                                 non-global-unicast address. Runs after DNS,
 *                                 for the origin and for every redirect hop.
 *
 * The policy is allow-list-by-exclusion: we reject private, loopback,
 * link-local, reserved, multicast, IPv4-mapped/embedded and unspecified
 * addresses for both IPv4 and IPv6, and only global unicast survives.
 */

export class SsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfError';
  }
}

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

export function ipVersion(host: string): 0 | 4 | 6 {
  if (IPV4_RE.test(host)) return 4;
  // Bracket-stripped IPv6 literal check (very permissive; parseIPv6 validates).
  if (host.includes(':')) return 6;
  return 0;
}

function ipv4Octets(host: string): number[] | null {
  const m = IPV4_RE.exec(host);
  if (!m) return null;
  const o = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  if (o.some((n) => n < 0 || n > 255)) return null;
  return o;
}

/** True when the IPv4 address is anything other than public global unicast. */
function isDisallowedIpv4(host: string): boolean {
  const o = ipv4Octets(host);
  if (!o) return true; // unparseable => reject
  const [a, b] = o;
  if (a === 0) return true; // 0.0.0.0/8 "this network"
  if (a === 10) return true; // private
  if (a === 127) return true; // loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
  if (a === 169 && b === 254) return true; // link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 0) return true; // 192.0.0/24 + 192.0.2/24 reserved/TEST-NET-1
  if (a === 192 && b === 88 && o[2] === 99) return true; // 6to4 relay anycast
  if (a === 192 && b === 168) return true; // private
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51 && o[2] === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && o[2] === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // 224/4 multicast + 240/4 reserved + 255.255.255.255
  return false;
}

/** Expand an IPv6 literal to eight 16-bit hextets, or null if malformed. */
export function parseIpv6(input: string): number[] | null {
  let s = input.trim();
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  // Strip zone id (fe80::1%eth0).
  const pct = s.indexOf('%');
  if (pct !== -1) s = s.slice(0, pct);
  if (s === '' || !s.includes(':')) return null;

  // Handle embedded IPv4 tail (e.g. ::ffff:1.2.3.4).
  let tail: number[] = [];
  const lastColon = s.lastIndexOf(':');
  const maybeV4 = s.slice(lastColon + 1);
  if (maybeV4.includes('.')) {
    const o = ipv4Octets(maybeV4);
    if (!o) return null;
    tail = [(o[0] << 8) | o[1], (o[2] << 8) | o[3]];
    s = s.slice(0, lastColon + 1) + '0:0';
  }

  const halves = s.split('::');
  if (halves.length > 2) return null;

  const toGroups = (part: string): number[] | null => {
    if (part === '') return [];
    const gs = part.split(':');
    const out: number[] = [];
    for (const g of gs) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };

  let hextets: number[];
  if (halves.length === 2) {
    const head = toGroups(halves[0]);
    const back = toGroups(halves[1]);
    if (head === null || back === null) return null;
    const fill = 8 - head.length - back.length;
    if (fill < 0) return null;
    hextets = [...head, ...new Array(fill).fill(0), ...back];
  } else {
    const g = toGroups(halves[0]);
    if (g === null) return null;
    hextets = g;
  }

  // Re-apply embedded-v4 tail into the last two hextets.
  if (tail.length === 2) {
    hextets[6] = tail[0];
    hextets[7] = tail[1];
  }
  if (hextets.length !== 8) return null;
  return hextets;
}

/** True when the IPv6 address is anything other than public global unicast. */
function isDisallowedIpv6(host: string): boolean {
  const h = parseIpv6(host);
  if (!h) return true;
  const first = h[0];
  const allZeroExceptLast = h.slice(0, 7).every((x) => x === 0);
  if (allZeroExceptLast && (h[7] === 0 || h[7] === 1)) return true; // :: and ::1
  // IPv4-mapped ::ffff:0:0/96 and IPv4-compatible ::/96 -> reject outright.
  if (h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0 && h[4] === 0) {
    if (h[5] === 0xffff || h[5] === 0) return true;
  }
  if (first === 0x0064 && h[1] === 0xff9b) return true; // 64:ff9b::/96 NAT64
  if (first === 0x0100) return true; // 100::/64 discard
  // Only 2000::/3 (global unicast) is allowed.
  if (first < 0x2000 || first > 0x3fff) return true;
  if (first === 0x2001 && h[1] === 0x0db8) return true; // documentation
  return false;
}

/** Reject a *resolved* IP address that is not public global unicast. */
export function assertAddressAllowed(ip: string): void {
  const v = ipVersion(ip);
  if (v === 4) {
    if (isDisallowedIpv4(ip)) throw new SsrfError(`blocked IPv4 address: ${ip}`);
    return;
  }
  if (v === 6) {
    if (isDisallowedIpv6(ip)) throw new SsrfError(`blocked IPv6 address: ${ip}`);
    return;
  }
  throw new SsrfError(`unrecognized IP address: ${ip}`);
}

/**
 * URL-shape SSRF checks that need no DNS. Throws SsrfError on violation.
 * Enforces: https only, no embedded credentials, default port only, and
 * rejects literal-IP hostnames that resolve to disallowed ranges plus the
 * localhost name family.
 */
export function assertUrlAllowedStatic(url: URL): void {
  if (url.protocol !== 'https:') throw new SsrfError('only https is allowed');
  if (url.username !== '' || url.password !== '') {
    throw new SsrfError('credentials in URL are not allowed');
  }
  if (url.port !== '' && url.port !== '443') {
    throw new SsrfError(`custom ports are not allowed: ${url.port}`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === '' ) throw new SsrfError('empty hostname');
  if (host === 'localhost' || host.endsWith('.localhost')) {
    throw new SsrfError('localhost is not allowed');
  }
  const v = ipVersion(host);
  if (v !== 0) assertAddressAllowed(host); // literal IP: check immediately
}

/** Same-origin comparison (scheme + host + port), used across redirects. */
export function sameOrigin(a: URL, b: URL): boolean {
  return a.origin === b.origin;
}
