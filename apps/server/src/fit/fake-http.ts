// A fake HTTP server on port 0 for tests of the Ollama clients (fit and
// chat). Routes are "METHOD /path"; every request body is logged.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface LoggedRequest {
  method: string;
  path: string;
  body: unknown;
}

export type Route = (body: unknown, res: ServerResponse, req: IncomingMessage) => void | Promise<void>;

export interface FakeServer {
  baseUrl: string;
  requests: LoggedRequest[];
  close(): Promise<void>;
}

export function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}

export async function startFakeServer(routes: Record<string, Route>): Promise<FakeServer> {
  const requests: LoggedRequest[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      let body: unknown = text;
      try {
        body = text ? JSON.parse(text) : undefined;
      } catch {
        // keep the raw text
      }
      const path = new URL(req.url ?? "/", "http://x").pathname;
      requests.push({ method: req.method ?? "GET", path, body });
      const route = routes[`${req.method} ${path}`];
      if (!route) {
        json(res, 404, { error: `no route ${req.method} ${path}` });
        return;
      }
      Promise.resolve(route(body, res, req)).catch((error: unknown) => {
        if (!res.headersSent) json(res, 500, { error: String(error) });
        else res.destroy();
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
