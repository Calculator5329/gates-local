import { isIP } from "node:net";
import os from "node:os";

export function normalAddress(text: string): string | null {
  const zone = text.indexOf("%");
  const zoneless = zone === -1 ? text : text.slice(0, zone);
  const kind = isIP(zoneless);
  if (kind === 4 && zone === -1) return zoneless;
  if (kind !== 6 || (zone !== -1 && !/^%[A-Za-z0-9._-]+$/.test(text.slice(zone)))) return null;
  // external: Node's URL parser prints IPv6 compressed and lower-case
  const canonical = new URL(`http://[${zoneless}]/`).hostname.slice(1, -1);
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(canonical);
  if (mapped === null) return canonical;
  const hi = Number.parseInt(mapped[1] ?? "0", 16);
  const lo = Number.parseInt(mapped[2] ?? "0", 16);
  return [hi >> 8, hi & 255, lo >> 8, lo & 255].join(".");
}

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
