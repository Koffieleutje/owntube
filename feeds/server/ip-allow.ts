/**
 * IP allow-list matching for the `/publish` endpoint. Pure + testable: no DNS,
 * no env, no I/O. `server.ts` resolves any allowed hostnames to IPs and passes
 * the union of IPs/CIDRs here.
 *
 * Everything is compared as raw bytes, so an IPv4 rule matches an IPv4-mapped
 * IPv6 client (`::ffff:1.2.3.4`) and vice-versa, and CIDRs work for both
 * families.
 */

/** Parse an IPv4/IPv6 string to its raw bytes (4 or 16). Returns null if invalid. */
export function ipToBytes(input: string): Uint8Array | null {
  const s = input.trim().toLowerCase().replace(/%.*$/, ""); // drop zone id
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) {
    const parts = s.split(".").map((p) => Number.parseInt(p, 10));
    if (parts.some((n) => n < 0 || n > 255)) return null;
    return Uint8Array.from(parts);
  }
  if (!s.includes(":")) return null;
  const bytes = parseIpv6(s);
  if (!bytes) return null;
  // IPv4-mapped (::ffff:a.b.c.d) -> treat as the IPv4 address so v4 rules match.
  if (
    bytes.length === 16 &&
    bytes.slice(0, 10).every((b) => b === 0) &&
    bytes[10] === 0xff &&
    bytes[11] === 0xff
  ) {
    return bytes.slice(12);
  }
  return bytes;
}

function parseIpv6(s: string): Uint8Array | null {
  const halves = s.split("::");
  if (halves.length > 2) return null;

  const groupsToBytes = (groups: string[]): number[] | null => {
    const out: number[] = [];
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      if (g === "") return null;
      if (g.includes(".")) {
        // Embedded IPv4 tail, only valid as the last group.
        if (i !== groups.length - 1) return null;
        if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(g)) return null;
        const v4 = g.split(".").map((p) => Number.parseInt(p, 10));
        if (v4.some((n) => n > 255)) return null;
        out.push(...v4);
      } else {
        if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
        const n = Number.parseInt(g, 16);
        out.push((n >> 8) & 0xff, n & 0xff);
      }
    }
    return out;
  };

  const head = halves[0] ? groupsToBytes(halves[0].split(":")) : [];
  if (head === null) return null;

  if (halves.length === 1) {
    return head.length === 16 ? Uint8Array.from(head) : null;
  }

  const tail = halves[1] ? groupsToBytes(halves[1].split(":")) : [];
  if (tail === null) return null;
  const gap = 16 - head.length - tail.length;
  if (gap < 0) return null;
  return Uint8Array.from([...head, ...new Array(gap).fill(0), ...tail]);
}

function prefixMatches(a: Uint8Array, net: Uint8Array, bits: number): boolean {
  if (a.length !== net.length) return false;
  if (bits < 0 || bits > a.length * 8) return false;
  const fullBytes = bits >> 3;
  for (let i = 0; i < fullBytes; i++) if (a[i] !== net[i]) return false;
  const rem = bits & 7;
  if (rem) {
    const mask = (0xff << (8 - rem)) & 0xff;
    if ((a[fullBytes] & mask) !== (net[fullBytes] & mask)) return false;
  }
  return true;
}

/**
 * True when `clientIp` matches any rule. Each rule is an exact IP or a CIDR
 * (`10.0.0.0/8`, `2a02:a45d:15fe::/48`). Invalid rules/inputs are skipped.
 */
export function isIpAllowed(clientIp: string, rules: string[]): boolean {
  const client = ipToBytes(clientIp);
  if (!client) return false;
  for (const rule of rules) {
    const slash = rule.indexOf("/");
    if (slash >= 0) {
      const net = ipToBytes(rule.slice(0, slash));
      const bits = Number.parseInt(rule.slice(slash + 1), 10);
      if (!net || net.length !== client.length || Number.isNaN(bits)) continue;
      if (prefixMatches(client, net, bits)) return true;
    } else {
      const net = ipToBytes(rule);
      if (
        net &&
        net.length === client.length &&
        net.every((b, i) => b === client[i])
      ) {
        return true;
      }
    }
  }
  return false;
}
