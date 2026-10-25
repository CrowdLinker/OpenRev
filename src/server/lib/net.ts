/**
 * Guards for URLs the server fetches on a user's behalf (alert webhooks), so a site admin can't point
 * OpenRev at loopback, private-network or link-local services.
 */

const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home.arpa", ".intranet", ".corp"];

function ipv4Parts(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((n) => n <= 255) ? parts : null;
}

function isPublicIpv4([a, b, c]: number[]): boolean {
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false; // this network, private, loopback, multicast/reserved
  if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT
  if (a === 169 && b === 254) return false; // link-local (cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false; // IETF protocol assignments, TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
  if (a === 198 && b === 51 && c === 100) return false; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return false; // TEST-NET-3
  return true;
}

function expandIpv6(host: string): number[] | null {
  let h = host.toLowerCase();
  // IPv4-mapped / embedded forms such as ::ffff:10.0.0.1
  const v4 = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(h);
  let tail: number[] = [];
  if (v4) {
    const p = ipv4Parts(v4[1]);
    if (!p) return null;
    tail = [(p[0] << 8) | p[1], (p[2] << 8) | p[3]];
    h = h.slice(0, -v4[1].length).replace(/:$/, ":0").replace(/:0$/, "") || "::";
    if (h.endsWith(":") && !h.endsWith("::")) h = h.slice(0, -1);
  }
  const [head, rest] = h.split("::");
  if (h.split("::").length > 2) return null;
  const parse = (s: string) => (s ? s.split(":").map((x) => parseInt(x, 16)) : []);
  const hi = parse(head);
  const lo = [...parse(rest ?? ""), ...tail];
  const fill = rest === undefined ? 0 : 8 - hi.length - lo.length;
  const all = rest === undefined ? [...hi, ...tail] : [...hi, ...Array(Math.max(fill, 0)).fill(0), ...lo];
  if (all.length !== 8 || all.some((n) => !Number.isInteger(n) || n < 0 || n > 0xffff)) return null;
  return all;
}

function isPublicIpv6(groups: number[]): boolean {
  if (groups.slice(0, 5).every((g) => g === 0) && (groups[5] === 0xffff || groups[5] === 0)) {
    // IPv4-mapped (::ffff:a.b.c.d) or IPv4-compatible (::a.b.c.d, which also covers :: and ::1)
    return isPublicIpv4([groups[6] >> 8, groups[6] & 255, groups[7] >> 8, groups[7] & 255]);
  }
  // Only global unicast (2000::/3) is public; also block NAT64 (64:ff9b::/96) and documentation (2001:db8::/32).
  if (groups[0] < 0x2000 || groups[0] > 0x3fff) return false;
  if (groups[0] === 0x2001 && groups[1] === 0x0db8) return false;
  return true;
}

/** True when `address` is a literal IP that is publicly routable. */
export function isPublicIp(address: string): boolean {
  const v4 = ipv4Parts(address);
  if (v4) return isPublicIpv4(v4);
  const v6 = expandIpv6(address.replace(/^\[|\]$/g, ""));
  return v6 ? isPublicIpv6(v6) : false;
}

/**
 * Checks that `raw` is an https URL whose host is a public name or public IP literal.
 * Hostnames that resolve to private addresses are caught at send time by `Runtime.checkHost` (Node).
 */
export function publicHttpsUrl(raw: unknown): URL | null {
  let url: URL;
  try {
    url = new URL(String(raw ?? ""));
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host || host === "localhost" || BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) return null;
  if (ipv4Parts(host) || host.startsWith("[")) return isPublicIp(host) ? url : null;
  if (!host.includes(".")) return null; // single-label names resolve inside the local network
  return url;
}
