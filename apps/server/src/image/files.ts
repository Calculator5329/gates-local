import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";

/** Exact filenames only, with a realpath check and O_NOFOLLOW for symlink escapes. */
export async function serveImage(req: IncomingMessage, res: ServerResponse, dataDir: string): Promise<void> {
  const url = new URL(req.url ?? "/", "http://loopback");
  const match = /^\/files\/images\/([a-zA-Z0-9_-]+\.(png|jpeg|webp|gif))$/.exec(url.pathname);
  if (req.method !== "GET" || !match?.[1]) { res.writeHead(404).end(); return; }
  let handle;
  try {
    const root = path.join(await realpath(dataDir), "images");
    if (await realpath(root) !== root) { res.writeHead(404).end(); return; }
    const filename = path.join(root, match[1]);
    if (await realpath(filename) !== filename) { res.writeHead(404).end(); return; }
    handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    if (!(await handle.stat()).isFile()) { res.writeHead(404).end(); return; }
    const bytes = await handle.readFile();
    res.writeHead(200, { "Content-Type": `image/${match[2]}`, "Content-Length": bytes.length, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" }).end(bytes);
  } catch { if (!res.headersSent) res.writeHead(404).end(); }
  finally { await handle?.close(); }
}
