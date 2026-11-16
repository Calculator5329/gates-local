import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export const PAGE_MAX_BYTES = 2 * 1024 * 1024;
export const PAGE_TTL_MS = 60_000;
export const PAGES_KEPT = 32;

export function pagePolicy(nonce: string): string {
  return [
    "default-src 'none'",
    // external: a browser that does not know script-src-elem and script-src-attr falls back to script-src.
    "script-src 'unsafe-inline'",
    // external: a browser checks a javascript: address against script-src-elem, and it carries no nonce, so a page cannot navigate its frame to one.
    `script-src-elem 'nonce-${nonce}' 'strict-dynamic'`,
    "script-src-attr 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    "img-src data:",
    "font-src data:",
    "media-src data:",
    // external: a child frame is a fresh browser window, with the WebRTC constructors back.
    "frame-src 'none'",
    "child-src 'none'",
    "worker-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "sandbox allow-scripts",
  ].join("; ");
}

// why: no nonce and no host here, so a script element with an address fails however it is marked.
export const PAGE_NO_REMOTE_SCRIPT = "script-src 'unsafe-inline'";

export const pageNonce = (): string => randomBytes(16).toString("hex");

const RTC = ["RTCPeerConnection", "webkitRTCPeerConnection", "RTCDataChannel", "RTCSessionDescription", "RTCIceCandidate"];
const head = (nonce: string) => `<script nonce=${nonce}>for(const k of ${JSON.stringify(RTC)}){try{Object.defineProperty(window,k,{value:undefined,writable:false,configurable:false})}catch{}}</script>`;
const SCRIPT_TAG = /<script(?=[\s/>])/gi;

export function pageDocument(code: string, nonce: string): string {
  // external: a browser keeps standards mode only when the doctype comes before everything else.
  const doctype = /^\s*<!doctype[^>]*>/i.exec(code);
  // why: the nonce is first and unquoted: one the page wrote loses, and no string in its script ends.
  const rest = (doctype === null ? code : code.slice(doctype[0].length)).replace(SCRIPT_TAG, `<script nonce=${nonce} `);
  return `${doctype === null ? "<!doctype html>" : doctype[0]}${head(nonce)}${rest}`;
}

export function pageHeaders(nonce: string, frameAncestors?: string): Record<string, string> {
  const policy = pagePolicy(nonce);
  return {
    "Content-Type": "text/html; charset=utf-8",
    // external: a browser splits this header at the comma, and a script must pass every policy in it.
    "Content-Security-Policy": `${frameAncestors === undefined ? policy : `${policy}; frame-ancestors ${frameAncestors}`}, ${PAGE_NO_REMOTE_SCRIPT}`,
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
  readonly frameAncestors?: string;
  readonly now?: () => number;
}

export interface PageRoute {
  matches(req: IncomingMessage): boolean;
  handle(req: IncomingMessage, res: ServerResponse, admitted: boolean): void;
  readonly size: number;
}

export function createPageRoute(options: PageRouteOptions = {}): PageRoute {
  const now = options.now ?? Date.now;
  const kept = new Map<string, { readonly doc: string; readonly nonce: string; readonly until: number }>();

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
      const nonce = pageNonce();
      kept.set(id, { doc: pageDocument(Buffer.concat(chunks).toString("utf8"), nonce), nonce, until: now() + PAGE_TTL_MS });
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
      // why: the phone's listener denies framing on every answer; a page alone is framed, by its origin.
      res.removeHeader("X-Frame-Options");
      res.writeHead(200, { ...pageHeaders(page.nonce, options.frameAncestors), "Content-Length": String(body.length) }).end(body);
    },
    get size() {
      sweep();
      return kept.size;
    },
  };
}
