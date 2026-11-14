// A page a model wrote, served to the frame that runs it. The client hands
// the page's code over with POST /pages (the token and an allowed Origin on
// the computer's listener; Serve's admission on the phone's) and gets back a
// one-time id; the frame then loads /pages/<id>, an address with no token in
// it. The first GET of an id serves the page and forgets it; an unknown, used
// or expired id gets an empty 404. The page's limits travel as response
// headers, so a page that replaces its own document cannot take them off:
// no network, no child frames, no forms, scripts sandboxed to an opaque origin.
import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

/** The largest page served, in bytes of UTF-8 (the client checks the same number first: apps/web/src/pages/page-doc.ts). */
export const PAGE_MAX_BYTES = 2 * 1024 * 1024;
/** How long a handed-over page waits for its frame. */
export const PAGE_TTL_MS = 60_000;
/** Pages waiting for a frame at once; the oldest goes first past this. */
export const PAGES_KEPT = 32;

/**
 * Everything the page may use: its own inline scripts and styles, and pictures, fonts and media
 * from data: addresses. Nothing loads from or goes out to anywhere else, it cannot hold a frame of
 * its own (a fresh child window would have the WebRTC constructors back), and the sandbox gives it
 * an opaque origin with scripts only, even if its address is opened on its own.
 */
export const PAGE_POLICY = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data:",
  "font-src data:",
  "media-src data:",
  "frame-src 'none'",
  "child-src 'none'",
  "worker-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "sandbox allow-scripts",
].join("; ");

const RTC = ["RTCPeerConnection", "webkitRTCPeerConnection", "RTCDataChannel", "RTCSessionDescription", "RTCIceCandidate"];
/** Runs before the page's own scripts: the WebRTC constructors are gone, and cannot be put back. */
const HEAD = `<script>for(const k of ${JSON.stringify(RTC)}){try{Object.defineProperty(window,k,{value:undefined,writable:false,configurable:false})}catch{}}</script>`;

/** The page's code with the WebRTC removal first, after its doctype so it keeps standards mode. */
export function pageDocument(code: string): string {
  const doctype = /^\s*<!doctype[^>]*>/i.exec(code);
  return doctype === null ? `<!doctype html>${HEAD}${code}` : `${doctype[0]}${HEAD}${code.slice(doctype[0].length)}`;
}

/** The headers a served page carries; `frameAncestors` names the one origin that may frame it. */
export function pageHeaders(frameAncestors?: string): Record<string, string> {
  return {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": frameAncestors === undefined ? PAGE_POLICY : `${PAGE_POLICY}; frame-ancestors ${frameAncestors}`,
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-DNS-Prefetch-Control": "off",
    "Cache-Control": "no-store",
  };
}

const ID = /^[0-9a-f]{32}$/;

const empty = (res: ServerResponse, status: number, headers: Record<string, string> = {}) => {
  res.writeHead(status, { ...headers, "Content-Length": "0", "Cache-Control": "no-store" }).end();
};

export interface PageRouteOptions {
  /** The origin allowed to frame a served page (the phone listener's own); absent leaves frame-ancestors out. */
  readonly frameAncestors?: string;
  readonly now?: () => number;
}

export interface PageRoute {
  /** True for /pages and /pages/<anything>: this route answers it. */
  matches(req: IncomingMessage): boolean;
  /**
   * Answers a matching request. `admitted` says the caller passed the listener's own admission,
   * Origin included (only a POST needs it); an admitted POST's Origin is echoed for CORS.
   */
  handle(req: IncomingMessage, res: ServerResponse, admitted: boolean): void;
  /** Pages waiting for their frame. */
  readonly size: number;
}

export function createPageRoute(options: PageRouteOptions = {}): PageRoute {
  const now = options.now ?? Date.now;
  const kept = new Map<string, { readonly doc: string; readonly until: number }>();

  const sweep = () => {
    const t = now();
    for (const [id, p] of kept) if (p.until <= t) kept.delete(id);
  };

  const take = (req: IncomingMessage, res: ServerResponse) => {
    const cors: Record<string, string> = typeof req.headers.origin === "string" ? { "Access-Control-Allow-Origin": req.headers.origin, Vary: "Origin" } : {};
    const chunks: Buffer[] = [];
    let bytes = 0;
    let over = false;
    req.on("data", (chunk: Buffer) => {
      if (over) return;
      bytes += chunk.length;
      if (bytes > PAGE_MAX_BYTES) {
        over = true;
        chunks.length = 0;
        empty(res, 413, cors);
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (over) return;
      sweep();
      while (kept.size >= PAGES_KEPT) kept.delete(kept.keys().next().value!);
      const id = randomBytes(16).toString("hex");
      kept.set(id, { doc: pageDocument(Buffer.concat(chunks).toString("utf8")), until: now() + PAGE_TTL_MS });
      const body = JSON.stringify({ id });
      res.writeHead(201, { ...cors, "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(body)), "Cache-Control": "no-store" }).end(body);
    });
    req.on("error", () => { if (!res.headersSent) empty(res, 400, cors); });
  };

  return {
    matches(req) {
      const path = new URL(req.url ?? "/", "http://loopback").pathname;
      return path === "/pages" || path.startsWith("/pages/");
    },
    handle(req, res, admitted) {
      const path = new URL(req.url ?? "/", "http://loopback").pathname;
      if (path === "/pages") {
        if (req.method !== "POST") return empty(res, 405, { Allow: "POST" });
        if (!admitted) return empty(res, 401);
        return take(req, res);
      }
      const id = path.slice("/pages/".length);
      if (req.method !== "GET" || !ID.test(id)) return empty(res, 404);
      sweep();
      const page = kept.get(id);
      kept.delete(id);
      if (page === undefined) return empty(res, 404);
      const body = Buffer.from(page.doc, "utf8");
      // the phone listener frames nothing else: its page alone may be framed, by its own origin
      res.removeHeader("X-Frame-Options");
      res.writeHead(200, { ...pageHeaders(options.frameAncestors), "Content-Length": String(body.length) }).end(body);
    },
    get size() {
      sweep();
      return kept.size;
    },
  };
}
