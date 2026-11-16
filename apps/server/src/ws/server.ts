import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
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
  type ScopeName,
  type SyncChange,
  type SyncMetadata,
  WireError,
  ORDERED_DOMAINS,
  PROTOCOL_VERSION,
  SENT_IN_ORDER,
  scopesOf,
  phoneMay,
  methodSync,
  pushSync,
  missingScope,
  decodeRequest,
  encodeErrorResponse,
  encodePush,
  encodeResult,
} from "@gates-local/contracts";
import { type WebSocket, WebSocketServer } from "ws";
import { serveImage } from "../image/files.ts";
import { createPageRoute } from "../pages/route.ts";
import { isThumbnailRequest, serveThumbnail } from "../pictures/serve.ts";
import { SECURITY_HEADERS, phoneGate } from "../web/phone.ts";
import { listenOwnerSocket } from "../web/socket.ts";
import { serveClient } from "../web/static.ts";

const epoch = randomUUID();

export interface HandlerContext {
  readonly clientId: number;
  readonly window?: number;
  readonly listener?: "desktop" | "phone";
  readonly signal?: AbortSignal;
  readonly capture?: (changes: readonly SyncChange[]) => void;
}

export type Handler<M extends MethodName> = (params: Params<M>, ctx: HandlerContext) => ResultOf<M> | Promise<ResultOf<M>>;

export type Handlers = { readonly [M in Exclude<MethodName, "sync.negotiate">]: Handler<M> };

export interface WsServerOptions {
  readonly host?: string;
  readonly port: number;
  readonly token: string;
  readonly allowedOrigins: readonly string[];
  readonly handlers: Partial<Handlers>;
  readonly log?: (line: string) => void;
  readonly maxPayloadBytes?: number;
  readonly onClientCount?: (count: number) => void;
  readonly onWindowGone?: (window: number) => void;
  readonly windowGraceMs?: number;
  readonly leavingGraceMs?: number;
  readonly dataDir?: string;
  readonly thumbnails?: (jobId: string) => Promise<Buffer | undefined>;
  readonly phone?: PhoneListenerOptions;
}

export interface PhoneListenerOptions {
  readonly socketPath: string;
  readonly origin: string;
  readonly user: string;
  readonly peers?: readonly string[];
  readonly webRoot: string;
}

export interface WsServer {
  readonly port: number;
  readonly phoneSocket?: string;
  push<C extends Channel>(channel: C, payload: Payload<C>, changes?: readonly SyncChange[]): void;
  close(): Promise<void>;
}

export const WINDOW_GRACE_MS = 120_000;
// external: a browser closes a page's socket with 1001 (going away) when it closes or reloads
export const LEAVING_GRACE_MS = 10_000;
const GOING_AWAY = 1001;

function windowKey(req: IncomingMessage | undefined): string | undefined {
  const key = new URL(req?.url ?? "/", "http://loopback").searchParams.get("window");
  return key !== null && /^[\w-]{8,64}$/.test(key) ? key : undefined;
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

  const pages = createPageRoute();
  const http = createServer((req, res) => {
    if (pages.matches(req)) { pages.handle(req, res, req.method === "POST" && admits(req).ok); return; }
    if (options.dataDir && (req.url ?? "").startsWith("/files/")) {
      const verdict = admits(req);
      if (!verdict.ok) { res.writeHead(verdict.status).end(); return; }
      const fail = () => { if (!res.headersSent) res.writeHead(500).end(); };
      if (isThumbnailRequest(req)) { void serveThumbnail(req, res, options.thumbnails ?? (async () => undefined)).catch(fail); return; }
      void serveImage(req, res, options.dataDir).catch(fail);
      return;
    }
    res.writeHead(426, { "Content-Type": "text/plain" }).end("WebSocket only\n");
  });
  // why: eight 10 MiB pasted images are about 107 MiB in base64
  const wss = new WebSocketServer({ noServer: true, maxPayload: options.maxPayloadBytes ?? 128 * 1024 * 1024 });
  const clients = new Set<WebSocket>();
  const negotiated = new WeakSet<WebSocket>();
  const issued = new Map<ScopeName, number>();
  const sent = (scope: ScopeName): SyncChange => {
    const rev = (issued.get(scope) ?? 0) + 1;
    issued.set(scope, rev);
    return { scope, kind: "snapshot", rev };
  };
  const phoneClients = new WeakSet<WebSocket>();
  const chatClients = new WeakSet<WebSocket>();
  let nextClientId = 1;
  const windowNumbers = new Map<string, number>();
  const windowSockets = new Map<number, Set<WebSocket>>();
  const windowsLeaving = new Map<number, ReturnType<typeof setTimeout>>();
  const windowGrace = options.windowGraceMs ?? WINDOW_GRACE_MS;
  const leavingGrace = Math.min(options.leavingGraceMs ?? LEAVING_GRACE_MS, windowGrace);
  let closing = false;

  const admits = (req: IncomingMessage): { ok: true } | { ok: false; status: 401 | 403; reason: string } => {
    const url = new URL(req.url ?? "/", "http://loopback");
    const token = url.searchParams.get("token") ?? "";
    // why: equal-length digests keep the compare constant-time whatever the token's length
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

  let phoneHttp: ReturnType<typeof createServer> | null = null;
  if (phone !== undefined && phoneAdmits !== null) {
    const phonePages = createPageRoute({ frameAncestors: phone.origin });
    phoneHttp = createServer((req, res) => {
      for (const [k, v] of SECURITY_HEADERS) res.setHeader(k, v);
      const verdict = phoneAdmits(req, "request");
      if (!verdict.ok) {
        log(`phone refused a request (${verdict.reason})`);
        res.writeHead(403, { "Content-Length": 0 }).end();
        return;
      }
      if (phonePages.matches(req)) { phonePages.handle(req, res, true); return; }
      const fail = () => { if (!res.headersSent) res.writeHead(500, { "Content-Length": 0 }).end(); };
      if ((req.url ?? "").startsWith("/files/")) {
        if (options.dataDir === undefined) { res.writeHead(404, { "Content-Length": 0 }).end(); return; }
        if (isThumbnailRequest(req)) { void serveThumbnail(req, res, options.thumbnails ?? (async () => undefined)).catch(fail); return; }
        void serveImage(req, res, options.dataDir).catch(fail);
        return;
      }
      res.setHeader("Content-Security-Policy", `frame-src ${phone.origin}/pages/`);
      void serveClient(req, res, phone.webRoot, phone.origin).catch(fail);
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
    const { id, method, params: decodedParams } = req.value;
    if (ctx.listener === "phone" && !phoneMay(method)) {
      return send(ws, encodeErrorResponse(id, "forbidden", "That can only be done on the computer running Gates Local."));
    }
    if (method === "sync.negotiate") {
      if (ORDERED_DOMAINS.some(domain => !decodedParams.ordered.includes(domain))) {
        return send(ws, encodeErrorResponse(id, "other-version", "This page is from another version of Gates Local. Reload it."));
      }
      const frame = encodeResult(id, method, { epoch, ordered: ORDERED_DOMAINS, protocol: PROTOCOL_VERSION });
      if (!frame.ok) throw frame.error;
      send(ws, frame.value);
      negotiated.add(ws);
      return;
    }
    const handler = handlers[method] as ((p: unknown, c: HandlerContext) => unknown) | undefined;
    if (handler === undefined) return send(ws, encodeErrorResponse(id, "not-implemented", `${method} has no handler`));
    let result: unknown;
    const row = methodSync(method);
    let captured: SyncMetadata | undefined = row !== undefined && SENT_IN_ORDER.includes(row.domain) ? { epoch, changes: scopesOf(row).map(sent) } : undefined;
    try {
      result = await handler(decodedParams, { ...ctx, capture: changes => { captured = { epoch, changes }; } });
    } catch (e) {
      const { code, message, blocking } = errorCode(e);
      if (code === "internal") log(`${method} handler threw: ${message}`);
      return send(ws, encodeErrorResponse(id, code, message, blocking));
    }
    const numbered = row !== undefined && negotiated.has(ws);
    const missing = numbered ? missingScope(row, decodedParams, captured, epoch) : undefined;
    if (missing !== undefined) {
      return send(ws, encodeErrorResponse(id, "bad-result", `${method} did not capture ${missing} metadata`));
    }
    const frame = encodeResult(id, method, result as never, numbered ? captured : undefined);
    if (!frame.ok) {
      log(`${method} returned a result that breaks its Schema: ${frame.error.message}`);
      return send(ws, encodeErrorResponse(id, frame.error.code, frame.error.message));
    }
    send(ws, frame.value);
  };

  wss.on("connection", (ws: WebSocket, req?: IncomingMessage) => {
    clients.add(ws);
    options.onClientCount?.(clients.size);
    const controller = new AbortController();
    const clientId = nextClientId++;
    const named = windowKey(req);
    const window = named === undefined ? clientId : windowNumbers.get(named) ?? nextClientId++;
    if (named !== undefined) windowNumbers.set(named, window);
    clearTimeout(windowsLeaving.get(window));
    windowsLeaving.delete(window);
    windowSockets.set(window, (windowSockets.get(window) ?? new Set()).add(ws));
    const ctx: HandlerContext = { clientId, window, listener: phoneClients.has(ws) ? "phone" : "desktop", signal: controller.signal };
    ws.on("message", (data, isBinary) => {
      chatClients.add(ws);
      const raw = isBinary ? data : Buffer.isBuffer(data) ? data.toString("utf8") : Buffer.concat(data as Buffer[]).toString("utf8");
      dispatch(ws, ctx, raw).catch((e: unknown) => log(`dispatch failed: ${String(e)}`));
    });
    ws.on("error", (e) => log(`client ${ctx.clientId} error: ${e.message}`));
    ws.on("close", (code) => {
      controller.abort();
      if (clients.delete(ws)) options.onClientCount?.(clients.size);
      const open = windowSockets.get(window);
      open?.delete(ws);
      if (open !== undefined && open.size > 0) return;
      windowSockets.delete(window);
      if (closing) return;
      if (named === undefined) return options.onWindowGone?.(window);
      windowsLeaving.set(window, setTimeout(() => {
        windowsLeaving.delete(window);
        windowNumbers.delete(named);
        options.onWindowGone?.(window);
      }, code === GOING_AWAY ? leavingGrace : windowGrace));
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
    push(channel, payload, given) {
      const frame = encodePush(channel, payload);
      if (!frame.ok) throw frame.error;
      const row = pushSync(channel);
      const changes = given ?? (row !== undefined && SENT_IN_ORDER.includes(row.domain) ? [sent(row.scope)] : undefined);
      const missing = row === undefined ? undefined : missingScope(row, payload, changes === undefined ? undefined : { epoch, changes }, epoch);
      if (missing !== undefined) throw new Error(`${channel} did not capture ${missing} metadata`);
      let versioned: string | undefined;
      for (const ws of clients) {
        if (channel === "reply.words" && !chatClients.has(ws)) continue;
        if (row !== undefined && changes !== undefined && negotiated.has(ws)) {
          if (versioned === undefined) {
            const encoded = encodePush(channel, payload, { epoch, changes });
            if (!encoded.ok) throw encoded.error;
            versioned = encoded.value;
          }
          send(ws, versioned);
        } else send(ws, frame.value);
      }
    },
    async close() {
      closing = true;
      for (const timer of windowsLeaving.values()) clearTimeout(timer);
      windowsLeaving.clear();
      for (const ws of clients) ws.terminate();
      clients.clear();
      options.onClientCount?.(0);
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await closeHttp(http);
      if (phoneHttp !== null) await closeHttp(phoneHttp);
    },
  };
}
