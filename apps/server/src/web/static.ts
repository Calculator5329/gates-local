// The built web client on the phone listener. GET / and any path that is not
// a file answer index.html with the same-origin meta, which tells the client
// to open its socket on this page's own host (apps/web/src/session.ts).
// Paths are checked twice: lexically on the raw request (no "..", ".",
// backslash, NUL or doubled slash after decoding) and on the resolved real
// path, so a symlink under the dist dir cannot reach a file outside it.
import { readFile, realpath, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";

export const SAME_ORIGIN_META = '<meta name="gates-local-server" content="same-origin">';
/** Vite builds with base "./"; this keeps asset URLs right when the fallback serves index.html at a deeper path. */
const BASE = '<base href="/">';

const TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
};

/** The path segments a request names under the dist dir, or null when the raw path tries to leave it. */
export function clientSegments(rawUrl: string): string[] | null {
  const raw = rawUrl.split(/[?#]/, 1)[0] ?? "";
  if (!raw.startsWith("/") || raw.startsWith("//")) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (decoded.includes("\0") || decoded.includes("\\") || decoded.startsWith("//")) return null;
  const segments = decoded.slice(1).split("/");
  if (segments.some((s) => s === ".." || s === ".")) return null;
  // A trailing slash leaves one empty segment; an empty one in the middle is a doubled slash.
  if (segments.slice(0, -1).some((s) => s === "")) return null;
  return segments.filter((s) => s !== "");
}

function inside(root: string, file: string): boolean {
  const rel = path.relative(root, file);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** index.html with the meta (and a root base) as the first thing in its head. */
export function withMeta(html: string): string {
  const head = /<head(\s[^>]*)?>/i;
  return head.test(html) ? html.replace(head, (tag) => `${tag}${SAME_ORIGIN_META}${BASE}`) : `${SAME_ORIGIN_META}${BASE}${html}`;
}

function send(req: IncomingMessage, res: ServerResponse, status: number, headers: Record<string, string | number>, body: Buffer | string): void {
  const bytes = typeof body === "string" ? Buffer.from(body, "utf8") : body;
  res.writeHead(status, { ...headers, "Content-Length": bytes.length });
  res.end(req.method === "HEAD" ? undefined : bytes);
}

async function sendIndex(req: IncomingMessage, res: ServerResponse, realRoot: string): Promise<void> {
  const file = path.join(realRoot, "index.html");
  let html: string;
  try {
    if ((await realpath(file)) !== file) return send(req, res, 403, {}, "");
    html = await readFile(file, "utf8");
  } catch {
    return send(req, res, 503, { "Content-Type": "text/plain; charset=utf-8" }, "The web client is not built.\n");
  }
  send(req, res, 200, { "Content-Type": TYPES[".html"] ?? "text/html", "Cache-Control": "no-cache" }, withMeta(html));
}

export async function serveClient(req: IncomingMessage, res: ServerResponse, webRoot: string): Promise<void> {
  if (req.method !== "GET" && req.method !== "HEAD") return send(req, res, 405, { Allow: "GET, HEAD" }, "");
  const segments = clientSegments(req.url ?? "/");
  if (segments === null) return send(req, res, 403, {}, "");
  let realRoot: string;
  try {
    realRoot = await realpath(webRoot);
  } catch {
    return send(req, res, 503, { "Content-Type": "text/plain; charset=utf-8" }, "The web client is not built.\n");
  }
  if (segments.length === 0) return sendIndex(req, res, realRoot);
  let real: string;
  try {
    real = await realpath(path.join(realRoot, ...segments));
  } catch {
    return sendIndex(req, res, realRoot); // not a file: the client's own route
  }
  if (!inside(realRoot, real)) return send(req, res, 403, {}, "");
  if (real === path.join(realRoot, "index.html")) return sendIndex(req, res, realRoot);
  let bytes: Buffer;
  try {
    if (!(await stat(real)).isFile()) return sendIndex(req, res, realRoot);
    bytes = await readFile(real);
  } catch {
    return send(req, res, 404, {}, "");
  }
  const type = TYPES[path.extname(real).toLowerCase()] ?? "application/octet-stream";
  // Vite's /assets/ names carry a content hash.
  const cache = segments[0] === "assets" ? "public, max-age=31536000, immutable" : "no-cache";
  send(req, res, 200, { "Content-Type": type, "Cache-Control": cache }, bytes);
}
