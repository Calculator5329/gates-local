// Where a phone request came from, as Tailscale Serve says in
// X-Forwarded-For. Serve (v1.104.4, ipn/ipnlocal/serve.go
// addProxyForwardedHeaders) Sets it to the connection's source address,
// `c.SrcAddr.Addr().String()`, and Go's ReverseProxy has already deleted any
// the client sent because Serve uses Rewrite. So a real value is exactly one
// address with no port.
//
// Serve also stamps the owner's login on a connection from this machine: a
// local dial to the desktop's own Tailscale address comes from that address,
// and WhoIs finds the self node by it (local.go WhoIs, node_backend.go
// updateNodeByAddrLocked indexes nm.SelfNode). Any local account could do
// that, so a source that is one of this machine's addresses is refused.
import { isIP } from "node:net";
import os from "node:os";

/**
 * One address in a canonical spelling, or null: IPv4 dotted, IPv6 lower-case
 * and compressed, zone id dropped, IPv4-mapped IPv6 turned into IPv4. A list,
 * a port, brackets or padding are not an address.
 */
export function normalAddress(text: string): string | null {
  // A zone id (fe80::1%wlan0) only ever follows an IPv6 address.
  const zone = text.indexOf("%");
  const zoneless = zone === -1 ? text : text.slice(0, zone);
  const kind = isIP(zoneless);
  if (kind === 4 && zone === -1) return zoneless;
  if (kind !== 6 || (zone !== -1 && !/^%[A-Za-z0-9._-]+$/.test(text.slice(zone)))) return null;
  // The WHATWG URL parser prints IPv6 compressed and lower-case.
  const canonical = new URL(`http://[${zoneless}]/`).hostname.slice(1, -1);
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(canonical);
  if (mapped === null) return canonical;
  const hi = Number.parseInt(mapped[1] ?? "0", 16);
  const lo = Number.parseInt(mapped[2] ?? "0", 16);
  return [hi >> 8, hi & 255, lo >> 8, lo & 255].join(".");
}

/** This machine's addresses on every interface (loopback and tailscale0 included), read now. */
export function ownAddresses(): ReadonlySet<string> {
  const out = new Set<string>();
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) {
      const n = normalAddress(a.address);
      if (n !== null) out.add(n);
    }
  }
  return out;
}

/** GATES_LOCAL_WEB_PEERS: comma-separated addresses, normalised; null when any item is not an address. */
export function parsePeers(text: string): string[] | null {
  const items = text.split(",").map((s) => s.trim());
  const out: string[] = [];
  for (const item of items) {
    const n = normalAddress(item);
    if (n === null) return null;
    out.push(n);
  }
  return out;
}
