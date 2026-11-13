// GET /files/thumbs/<jobId>.webp, behind the same admission as /files/images (ws/server.ts admits first).
// A job id never names two pictures, so a thumbnail is cached for good.
import type { IncomingMessage, ServerResponse } from "node:http";

const THUMB = /^\/files\/thumbs\/([0-9a-f-]{36})\.webp$/;

export const isThumbnailRequest = (req: IncomingMessage) => new URL(req.url ?? "/", "http://loopback").pathname.startsWith("/files/thumbs/");

export async function serveThumbnail(req: IncomingMessage, res: ServerResponse, thumbnail: (jobId: string) => Promise<Buffer | undefined>): Promise<void> {
  const match = THUMB.exec(new URL(req.url ?? "/", "http://loopback").pathname);
  if (req.method !== "GET" || !match?.[1]) { res.writeHead(404).end(); return; }
  const bytes = await thumbnail(match[1]).catch(() => undefined);
  if (!bytes) { res.writeHead(404).end(); return; }
  res.writeHead(200, { "Content-Type": "image/webp", "Content-Length": bytes.length, "Cache-Control": "private, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff" }).end(bytes);
}
