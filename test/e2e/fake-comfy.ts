// CPU-only fake ComfyUI on an ephemeral port. The real client polls history;
// the WebSocket upgrade stays open without sending previews or progress.
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { Duplex } from "node:stream";

export async function fakeComfy() {
  let complete = false, missingModel = false;
  let n = 0;
  const active = new Set<string>();
  const runs: { id: string; startedAt: number; endedAt?: number }[] = [];
  const sockets = new Set<Duplex>();
  const server = createServer(async (req, res) => {
    for await (const _ of req) { /* consume the body */ }
    const url = new URL(req.url ?? "/", "http://fake");
    let body: unknown = {};
    switch (url.pathname) {
      case "/system_stats": body = { system: {}, devices: [{ type: "cpu" }] }; break;
      case "/object_info": body = {
        CheckpointLoaderSimple: { input: { required: { ckpt_name: [missingModel ? [] : ["sdxl_lightning_4step.safetensors"]] } } },
        LoraLoader: { input: { required: { lora_name: [["RW_pixelart_XL_v1.safetensors"]] } } },
      }; break;
      case "/prompt": { const id = `p${++n}`; active.add(id); runs.push({ id, startedAt: Date.now() }); body = { prompt_id: id }; break; }
      case "/queue": body = { queue_running: [...active].map(id => [1, id]), queue_pending: [] }; break;
      case "/interrupt": active.clear(); break;
      case "/view":
        res.writeHead(200, { "content-type": "image/png" });
        res.end(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64")); return;
      default:
        if (url.pathname.startsWith("/history/") && complete) {
          const id = url.pathname.slice("/history/".length); active.delete(id);
          const run = runs.find((entry) => entry.id === id);
          if (run) run.endedAt ??= Date.now();
          body = { [id]: { outputs: { "8": { images: [{ filename: "ship.png" }] } } } };
        }
    }
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(body));
  });
  server.on("upgrade", (req, socket) => {
    // The backend may reset its preview connection when it exits on restart.
    // This test-owned peer disconnect is expected; unrelated faults still fail.
    socket.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "ECONNRESET") throw error;
    });
    const key = req.headers["sec-websocket-key"];
    if (!key) { socket.destroy(); return; }
    const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    sockets.add(socket); socket.on("close", () => sockets.delete(socket));
    socket.on("data", () => {});
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fake ComfyUI did not bind");
  return {
    url: `http://127.0.0.1:${address.port}`,
    state: () => runs.map((run) => ({ ...run })),
    finish: () => { complete = true; },
    missing: () => { missingModel = true; },
    restore: (finish = true) => { missingModel = false; complete = finish; },
    close: () => new Promise<void>((resolve, reject) => {
      for (const socket of sockets) socket.destroy();
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
  };
}
