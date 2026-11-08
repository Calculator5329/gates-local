// A loopback stand-in for Tailscale Serve in front of the phone listener's
// Unix socket, since a browser cannot open a Unix socket. It rewrites each
// request the way Serve v1.104.4 does for a unix: backend
// (ipn/ipnlocal/serve.go): Host becomes localhost, X-Forwarded-Host carries
// the browser's Host, the Tailscale identity headers the client sent are
// deleted and Tailscale-User-Login is set to the tailnet identity (here always
// the owner, PHONE_USER), and Origin passes through unchanged. Upgrades are
// piped raw. It proves the server admits Serve's shape end to end; it is not
// Serve, and the real headers are still to be read at deploy.
import { type IncomingHttpHeaders, type IncomingMessage, createServer, request } from "node:http";
import { connect } from "node:net";

const IDENTITY = ["tailscale-user-login", "tailscale-user-name", "tailscale-user-profile-pic", "tailscale-funnel-request", "tailscale-headers-info"];

export interface ServeStandIn {
  readonly port: number;
  close(): Promise<void>;
}

function serveHeaders(req: IncomingMessage, user: string): IncomingHttpHeaders {
  const out: IncomingHttpHeaders = { ...req.headers };
  for (const h of IDENTITY) delete out[h];
  out["x-forwarded-host"] = req.headers.host ?? "";
  out["x-forwarded-proto"] = "http";
  out["x-forwarded-for"] = "127.0.0.1";
  out.host = "localhost";
  out["tailscale-user-login"] = user;
  return out;
}

/** Listens on 127.0.0.1:port and proxies to socketPath as user. */
export async function startServeStandIn(port: number, socketPath: string, user: string): Promise<ServeStandIn> {
  // Upgraded sockets leave the http server's books; close() ends them too.
  const piped = new Set<{ destroy(): void }>();
  const server = createServer((req, res) => {
    const upstream = request({ socketPath, method: req.method, path: req.url, headers: serveHeaders(req, user) }, (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    });
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502).end();
      else res.destroy();
    });
    req.pipe(upstream);
  });
  server.on("upgrade", (req, socket, head) => {
    const upstream = connect(socketPath);
    piped.add(upstream);
    piped.add(socket);
    upstream.once("close", () => piped.delete(upstream));
    socket.once("close", () => piped.delete(socket));
    upstream.once("connect", () => {
      let text = `${req.method ?? "GET"} ${req.url ?? "/"} HTTP/1.1\r\n`;
      for (const [k, v] of Object.entries(serveHeaders(req, user))) {
        for (const one of [v].flat()) if (one !== undefined) text += `${k}: ${one}\r\n`;
      }
      upstream.write(`${text}\r\n`);
      if (head.length > 0) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
    upstream.on("close", () => socket.destroy());
    socket.on("close", () => upstream.destroy());
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  return {
    port,
    close: () =>
      new Promise((resolve) => {
        for (const s of piped) s.destroy();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
