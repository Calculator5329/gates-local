import type { IncomingMessage } from "node:http";
import { normalAddress, ownAddresses } from "./source.ts";

export interface PhoneGateOptions {
  readonly origin: string;
  readonly user: string;
  readonly peers?: readonly string[];
}

export type Admission = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export const SECURITY_HEADERS: ReadonlyArray<readonly [string, string]> = [
  ["X-Content-Type-Options", "nosniff"],
  ["Referrer-Policy", "no-referrer"],
  ["X-Frame-Options", "DENY"],
];

export function exactOrigin(text: string): URL | null {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username !== "" || url.password !== "") return null;
  return url.origin === text ? url : null;
}

export function validUser(user: string): boolean {
  // external: Node joins a repeated header with ", ", so a login with a comma could stand for two
  return /^[^\s\p{Cc},]+$/u.test(user);
}

// why: the phone has no way to receive a token, so Serve's headers are the identity
export function phoneGate(options: PhoneGateOptions): (req: IncomingMessage, kind: "request" | "upgrade") => Admission {
  const origin = exactOrigin(options.origin);
  if (origin === null) throw new Error("phone origin must be an exact http(s) origin");
  if (!validUser(options.user)) throw new Error("phone user must be a non-empty login with no spaces or commas");
  // external: a browser's Host header, and so Serve's X-Forwarded-Host, drops the default port
  const host = origin.host;
  const exact = origin.origin;
  const user = options.user;
  let peers: ReadonlySet<string> | null = null;
  if (options.peers !== undefined) {
    const listed = options.peers.map(normalAddress);
    if (listed.length === 0 || listed.some((p) => p === null)) throw new Error("phone peers must be IP addresses");
    peers = new Set(listed as string[]);
  }
  // external: Tailscale Serve (v1.104.4, ipn/ipnlocal/serve.go) sends a unix: backend Host: localhost,
  // X-Forwarded-Host as the browser's Host, Tailscale-User-Login with any the client sent deleted (none
  // for tagged nodes or Funnel), X-Forwarded-For as the one source address, and Origin unchanged. It also
  // names the owner for a dial from this machine itself, so this machine's addresses are refused.
  return (req, kind) => {
    const login = req.headers["tailscale-user-login"];
    if (login === undefined) return { ok: false, reason: "no Tailscale-User-Login" };
    if (login !== user) return { ok: false, reason: "wrong user" };
    if ((req.headers.host ?? "").toLowerCase() !== "localhost") return { ok: false, reason: "Host is not localhost (not Serve's Unix-backend shape)" };
    const forwardedFor = req.headers["x-forwarded-for"];
    if (forwardedFor === undefined) return { ok: false, reason: "no X-Forwarded-For" };
    const source = typeof forwardedFor === "string" ? normalAddress(forwardedFor) : null;
    if (source === null) return { ok: false, reason: "X-Forwarded-For is not one address" };
    // why: read per request, because interfaces come and go (tailscale0 among them)
    if (ownAddresses().has(source)) return { ok: false, reason: "source is this machine (Serve names its own owner for local dials)" };
    if (peers !== null && !peers.has(source)) return { ok: false, reason: "source is not in GATES_LOCAL_WEB_PEERS" };
    const forwarded = req.headers["x-forwarded-host"];
    if (forwarded === undefined) return { ok: false, reason: "no X-Forwarded-Host" };
    if (typeof forwarded !== "string" || forwarded.toLowerCase() !== host) return { ok: false, reason: "wrong X-Forwarded-Host" };
    if (kind === "upgrade" || (req.method !== "GET" && req.method !== "HEAD")) {
      const from = req.headers.origin;
      if (from === undefined) return { ok: false, reason: "no Origin" };
      if (from !== exact) return { ok: false, reason: "wrong Origin" };
    }
    return { ok: true };
  };
}
