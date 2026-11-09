// The server end of the one WebSocket. Loopback only; the upgrade needs the
// per-launch token and an absent or allowed Origin, so another local web
// page cannot drive the app. Every inbound frame is decoded against the
// contracts tables; a bad one gets a named error and the socket stays up.
// With `phone` set a second listener, on an owner-only Unix socket
// (src/web/socket.ts), serves the web client and the same socket on /ws,
// admitted by Tailscale Serve's headers instead of the token
// (src/web/phone.ts); both listeners share handlers and pushes.
import { createHash, timingSafeEqual } from "node:crypto";
import { type IncomingMessage, createServer } from "node:http";
import { isIP } from "node:net";
import type { Duplex } from "node:stream";
import {
  type BlockingTurn,
  type Channel,
  type MethodName,
  type Params,
  type Payload,
  type ResultOf,
  WireError,
  decodeRequest,
  encodeErrorResponse,
  encodePush,
  encodeResult,
} from "@gates-local/contracts";
import { type WebSocket, WebSocketServer } from "ws";
import { serveImage } from "../image/files.ts";
import { SECURITY_HEADERS, phoneGate } from "../web/phone.ts";
import { listenOwnerSocket } from "../web/socket.ts";
import { serveClient } from "../web/static.ts";

export interface HandlerContext {
  /** Stable per connection, for handlers that track who started what. */
  readonly clientId: number;
  readonly listener?: "desktop" | "phone";
  readonly signal?: AbortSignal;
}

export type Handler<M extends MethodName> = (params: Params<M>, ctx: HandlerContext) => ResultOf<M> | Promise<ResultOf<M>>;

/** The full registry, for the composer to `satisfies` once every module is wired. */
export type Handlers = { readonly [M in MethodName]: Handler<M> };

export interface WsServerOptions {
  /** Loopback only: 127.0.0.0/8 or ::1. Default 127.0.0.1. */
  readonly host?: string;
  /** 0 picks a free port. */
  readonly port: number;
  /** Per-launch secret; the upgrade URL must carry it as `?token=`. */
  readonly token: string;
  /** Exact Origin header values allowed. A request with no Origin (Electron main, node) is allowed. */
  readonly allowedOrigins: readonly string[];
  /** Methods without a handler answer "not-implemented". */
  readonly handlers: Partial<Handlers>;
  readonly log?: (line: string) => void;
  /** Largest inbound frame. Default 16 MiB. */
  readonly maxPayloadBytes?: number;
  /** Called with the number of open clients after each connect and close (the GPU poll runs only while it is above 0). */
  readonly onClientCount?: (count: number) => void;
  /** Synchronous snapshot at the first request, before this client receives chat broadcasts. */
  readonly onClientReady?: (push: <C extends Channel>(channel: C, payload: Payload<C>) => void) => void;
  readonly dataDir?: string;
  /** A second listener for the phone through Tailscale Serve (apps/server/src/web/phone.ts); off when absent. */
  readonly phone?: PhoneListenerOptions;
}

export interface PhoneListenerOptions {
  /** Absolute path of the owner-only Unix socket Tailscale Serve proxies to; its parent must be 0700 and ours, or missing. */
  readonly socketPath: string;
  /** The exact public origin the phone loads the client from. */
  readonly origin: string;
  /** The one Tailscale-User-Login value admitted. */
  readonly user: string;
  /** When set, the only source addresses (Serve's X-Forwarded-For) admitted. */
  readonly peers?: readonly string[];
  /** The built web client served on GET. */
  readonly webRoot: string;
}

export interface WsServer {
  readonly port: number;
  /** The phone listener's socket path, when it is on. */
  readonly phoneSocket?: string;
  push<C extends Channel>(channel: C, payload: Payload<C>): void;
  close(): Promise<void>;
}

export function isLoopbackHost(host: string): boolean {
  if (host === "::1") return true;
  return isIP(host) === 4 && host.startsWith("127.");
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function refuse(socket: Duplex, status: 401 | 403 | 404, reason: string, headers: ReadonlyArray<readonly [string, string]> = []): void {
  const extra = headers.map(([k, v]) => `${k}: ${v}\r\n`).join("");
  socket.end(`HTTP/1.1 ${status} ${reason}\r\n${extra}Connection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

function listen(server: ReturnType<typeof createServer>, port: number, host: string): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      const address = server.address();
      if (address === null || typeof address === "string") reject(new Error("ws server has no TCP address"));
      else resolve(address.port);
    });
  });
}

function closeHttp(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
}

function send(ws: WebSocket, frame: string): void {
  if (ws.readyState === ws.OPEN) ws.send(frame);
}

/** Thrown values with a string `code` keep it; anything else is "internal". */
function errorCode(e: unknown): { code: string; message: string; blocking?: readonly BlockingTurn[] } {
  if (typeof e === "object" && e !== null) {
    const { code, message, blocking } = e as { code?: unknown; message?: unknown; blocking?: unknown };
    return {
      code: typeof code === "string" && code !== "" ? code : "internal",
      message: typeof message === "string" ? message : String(e),
      ...(Array.isArray(blocking) ? { blocking: blocking as BlockingTurn[] } : {}),
    };
  }
  return { code: "internal", message: String(e) };
}

export async function startWsServer(options: WsServerOptions): Promise<WsServer> {
  const host = options.host ?? "127.0.0.1";
  if (!isLoopbackHost(host)) throw new WireError("bad-params", `refusing to bind ${host}: loopback only`);
  if (options.token === "") throw new WireError("bad-params", "token must not be empty");
  const phone = options.phone;
  const phoneAdmits = phone === undefined ? null : phoneGate(phone);
  const log = options.log ?? ((line: string) => console.warn(`[ws] ${line}`));
  const tokenDigest = digest(options.token);
  const allowed = new Set(options.allowedOrigins);
  const handlers = options.handlers;

  const http = createServer((req, res) => {
    if (options.dataDir && (req.url ?? "").startsWith("/files/")) {
      const verdict = admits(req);
      if (!verdict.ok) { res.writeHead(verdict.status).end(); return; }
      void serveImage(req, res, options.dataDir).catch(() => { if (!res.headersSent) res.writeHead(500).end(); });
      return;
    }
    res.writeHead(426, { "Content-Type": "text/plain" }).end("WebSocket only\n");
  });
  // Eight 10 MiB pasted images expand to about 107 MiB in base64. Saved threads carry paths only.
  const wss = new WebSocketServer({ noServer: true, maxPayload: options.maxPayloadBytes ?? 128 * 1024 * 1024 });
  const clients = new Set<WebSocket>();
  const phoneClients = new WeakSet<WebSocket>();
  // Before the snapshot, active replies are recovered from that snapshot and
  // completed ones from RPC history. Keeping no chat backlog bounds idle clients.
  const chatClients = new WeakSet<WebSocket>();
  let nextClientId = 1;

  const admits = (req: IncomingMessage): { ok: true } | { ok: false; status: 401 | 403; reason: string } => {
    const url = new URL(req.url ?? "/", "http://loopback");
    const token = url.searchParams.get("token") ?? "";
    // Digests make the compare constant-time whatever the lengths.
    if (!timingSafeEqual(digest(token), tokenDigest)) return { ok: false, status: 401, reason: "Unauthorized" };
    const origin = req.headers.origin;
    if (origin !== undefined && !allowed.has(origin)) return { ok: false, status: 403, reason: "Forbidden" };
    return { ok: true };
  };

  http.on("upgrade", (req, socket, head) => {
    const verdict = admits(req);
    if (!verdict.ok) {
      log(`upgrade refused (${verdict.status}) origin=${req.headers.origin ?? "none"}`);
      return refuse(socket, verdict.status, verdict.reason);
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  // The phone listener: same handlers and push set, header admission instead
  // of the token. Refusals log the reason only, never a header value.
  let phoneHttp: ReturnType<typeof createServer> | null = null;
  if (phone !== undefined && phoneAdmits !== null) {
    phoneHttp = createServer((req, res) => {
      for (const [k, v] of SECURITY_HEADERS) res.setHeader(k, v);
      const verdict = phoneAdmits(req, "request");
      if (!verdict.ok) {
        log(`phone refused a request (${verdict.reason})`);
        res.writeHead(403, { "Content-Length": 0 }).end();
        return;
      }
      const fail = () => { if (!res.headersSent) res.writeHead(500, { "Content-Length": 0 }).end(); };
      if ((req.url ?? "").startsWith("/files/")) {
        if (options.dataDir === undefined) { res.writeHead(404, { "Content-Length": 0 }).end(); return; }
        void serveImage(req, res, options.dataDir).catch(fail);
        return;
      }
      void serveClient(req, res, phone.webRoot).catch(fail);
    });
    phoneHttp.on("upgrade", (req, socket, head) => {
      const verdict = phoneAdmits(req, "upgrade");
      if (!verdict.ok) {
        log(`phone refused an upgrade (${verdict.reason})`);
        return refuse(socket, 403, "Forbidden", SECURITY_HEADERS);
      }
      if (new URL(req.url ?? "/", "http://loopback").pathname !== "/ws") return refuse(socket, 404, "Not Found", SECURITY_HEADERS);
      wss.handleUpgrade(req, socket, head, (ws) => { phoneClients.add(ws); wss.emit("connection", ws, req); });
    });
    phoneHttp.on("clientError", (_e, socket) => socket.destroy());
  }

  const dispatch = async (ws: WebSocket, ctx: HandlerContext, raw: unknown) => {
    const req = decodeRequest(raw);
    if (!req.ok) {
      if (req.id === undefined) return log(`dropped frame with no usable id: ${req.error.code}: ${req.error.message}`);
      return send(ws, encodeErrorResponse(req.id, req.error.code, req.error.message));
    }
    const { id, method } = req.value;
    if (ctx.listener === "phone" && method.startsWith("update.") && method !== "update.status") {
      return send(ws, encodeErrorResponse(id, "forbidden", "Updates can only be controlled from the computer running Gates Local."));
    }
    let params: unknown = req.value.params;
    if (ctx.listener === "phone" && req.value.method === "settings.update") {
      // Reset still succeeds on phones, but desktop update preferences stay put.
      const { updateAutomatic: _automatic, updateEveryChange: _channel, ...phonePatch } = req.value.params;
      params = phonePatch;
    }
    const handler = handlers[method] as ((p: unknown, c: HandlerContext) => unknown) | undefined;
    if (handler === undefined) return send(ws, encodeErrorResponse(id, "not-implemented", `${method} has no handler`));
    let result: unknown;
    try {
      result = await handler(params, ctx);
    } catch (e) {
      const { code, message, blocking } = errorCode(e);
      if (code === "internal") log(`${method} handler threw: ${message}`);
      return send(ws, encodeErrorResponse(id, code, message, blocking));
    }
    const frame = encodeResult(id, method, result as never);
    if (!frame.ok) {
      log(`${method} returned a result that breaks its Schema: ${frame.error.message}`);
      return send(ws, encodeErrorResponse(id, frame.error.code, frame.error.message));
    }
    send(ws, frame.value);
  };

  wss.on("connection", (ws: WebSocket) => {
    clients.add(ws);
    if (options.onClientReady === undefined) chatClients.add(ws);
    options.onClientCount?.(clients.size);
    const controller = new AbortController();
    const ctx: HandlerContext = { clientId: nextClientId++, listener: phoneClients.has(ws) ? "phone" : "desktop", signal: controller.signal };
    ws.on("message", (data, isBinary) => {
      if (!chatClients.has(ws)) {
        try {
          options.onClientReady?.((channel, payload) => {
            const frame = encodePush(channel, payload);
            if (!frame.ok) throw frame.error;
            send(ws, frame.value);
          });
          chatClients.add(ws);
        } catch (e) {
          log(`client snapshot failed: ${String(e)}`);
          ws.close(1011, "Chat snapshot failed");
          return;
        }
      }
      // Binary frames fail the text check in decodeRequest and are dropped with a log.
      const raw = isBinary ? data : Buffer.isBuffer(data) ? data.toString("utf8") : Buffer.concat(data as Buffer[]).toString("utf8");
      dispatch(ws, ctx, raw).catch((e: unknown) => log(`dispatch failed: ${String(e)}`));
    });
    ws.on("error", (e) => log(`client ${ctx.clientId} error: ${e.message}`));
    ws.on("close", () => {
      controller.abort();
      if (clients.delete(ws)) options.onClientCount?.(clients.size);
    });
  });

  const port = await listen(http, options.port, host);
  if (phoneHttp !== null && phone !== undefined) {
    try {
      await listenOwnerSocket(phoneHttp, phone.socketPath);
    } catch (e) {
      await closeHttp(http).catch(() => undefined);
      throw e;
    }
  }

  return {
    port,
    ...(phone === undefined ? {} : { phoneSocket: phone.socketPath }),
    push(channel, payload) {
      const frame = encodePush(channel, payload);
      if (!frame.ok) throw frame.error;
      for (const ws of clients) if (channel !== "chat.event" || chatClients.has(ws)) send(ws, frame.value);
    },
    async close() {
      for (const ws of clients) ws.terminate();
      clients.clear();
      options.onClientCount?.(0);
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await closeHttp(http);
      if (phoneHttp !== null) await closeHttp(phoneHttp);
    },
  };
}
