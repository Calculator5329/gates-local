// Admission for the phone listener. Tailscale Serve proxies the owner's
// tailnet requests to a loopback port and adds Tailscale-User-Login; this
// listener admits a request only when that header names the one allowed user
// and Host is the public origin's host. The WebSocket upgrade also needs the
// exact Origin, so another site the phone visits cannot open the socket.
// There is no token here: the phone has no way to receive one. The loopback
// bind plus these headers is the boundary, as for every hub app on this
// machine; any local process can still reach a loopback port.
import type { IncomingMessage } from "node:http";

export interface PhoneGateOptions {
  /** The exact public origin, e.g. https://hub.example.ts.net:8456. */
  readonly origin: string;
  /** The one Tailscale-User-Login value admitted. */
  readonly user: string;
}

export type Admission = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/** Sent on every response from the phone listener, refusals included. */
export const SECURITY_HEADERS: ReadonlyArray<readonly [string, string]> = [
  ["X-Content-Type-Options", "nosniff"],
  ["Referrer-Policy", "no-referrer"],
  ["X-Frame-Options", "DENY"],
];

/** The origin as given when it is an exact http(s) origin (no path, credentials, query or trailing slash), else null. */
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

/** A Tailscale login: no whitespace, control characters or commas (Node joins a repeated header with ", "). */
export function validUser(user: string): boolean {
  return /^[^\s\p{Cc},]+$/u.test(user);
}

/** The admission check for one listener; throws on an origin or user that would never match. */
export function phoneGate(options: PhoneGateOptions): (req: IncomingMessage, kind: "request" | "upgrade") => Admission {
  const origin = exactOrigin(options.origin);
  if (origin === null) throw new Error("phone origin must be an exact http(s) origin");
  if (!validUser(options.user)) throw new Error("phone user must be a non-empty login with no spaces or commas");
  // URL.host drops the default port, as a browser's Host header does.
  const host = origin.host;
  const exact = origin.origin;
  const user = options.user;
  return (req, kind) => {
    const login = req.headers["tailscale-user-login"];
    if (login === undefined) return { ok: false, reason: "no Tailscale-User-Login" };
    if (login !== user) return { ok: false, reason: "wrong user" };
    if ((req.headers.host ?? "").toLowerCase() !== host) return { ok: false, reason: "wrong Host" };
    if (kind === "upgrade") {
      const from = req.headers.origin;
      if (from === undefined) return { ok: false, reason: "no Origin" };
      if (from !== exact) return { ok: false, reason: "wrong Origin" };
    }
    return { ok: true };
  };
}
