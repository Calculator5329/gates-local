// Admission for the phone listener. Tailscale Serve proxies the owner's
// tailnet requests to an owner-only Unix socket (src/web/socket.ts), so the
// only callers are this user and root's tailscaled; the headers below then
// carry what Serve says about the request. There is no token: the phone has
// no way to receive one.
//
// What Serve sends a Unix backend (tailscale v1.104.4, ipn/ipnlocal/serve.go):
//   - Host: localhost. proxyHandlerForBackend parses "http://localhost" for a
//     unix: target, and reverseProxy.ServeHTTP does
//     `if rp.socketPath != "" { r.Out.Host = rp.url.Host }`.
//   - X-Forwarded-Host: the browser's Host. addProxyForwardedHeaders does
//     `r.Out.Header.Set("X-Forwarded-Host", r.In.Host)`.
//   - Tailscale-User-Login: addTailscaleIdentityHeaders deletes any the client
//     sent, then sets the source node's login (none for tagged nodes or
//     Funnel).
//   - Origin: passed through unchanged.
// So a request is admitted when the login is exactly the one user, Host is
// localhost (a TCP-backend or hand-made shape is not Serve's to this socket),
// and X-Forwarded-Host is the public origin's host (the page was loaded from
// that name, not another one that resolves to the tailnet address). The
// WebSocket upgrade and any request that is not GET or HEAD also need the
// exact Origin, so another site the phone visits cannot drive the app.
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
  // URL.host drops the default port, as a browser's Host header (and so
  // Serve's X-Forwarded-Host) does.
  const host = origin.host;
  const exact = origin.origin;
  const user = options.user;
  return (req, kind) => {
    const login = req.headers["tailscale-user-login"];
    if (login === undefined) return { ok: false, reason: "no Tailscale-User-Login" };
    if (login !== user) return { ok: false, reason: "wrong user" };
    if ((req.headers.host ?? "").toLowerCase() !== "localhost") return { ok: false, reason: "Host is not localhost (not Serve's Unix-backend shape)" };
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
