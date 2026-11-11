// Fake ComfyUI on an ephemeral port, CPU-only unless gpu() is called. The real
// client polls history; the WebSocket upgrade stays open and sends nothing but
// the progress frames a test asks for with progress().
// gpu(): /system_stats names a CUDA device, so the image fit runs. Use it only
// with the e2e stack, whose server reads the fake nvidia-smi
// (GATES_LOCAL_NVIDIA_SMI), never the real one.
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { Duplex } from "node:stream";

export async function fakeComfy() {
  let complete = false, missingModel = false, flux = false, cuda = false, unlisted = false;
  let n = 0;
  const active = new Set<string>();
  const runs: { id: string; startedAt: number; endedAt?: number }[] = [];
  /** Each /prompt body as sent: the graph the server built for a job. */
  const prompts: { prompt: Record<string, { class_type: string; inputs: Record<string, unknown> }> }[] = [];
  const sockets = new Set<Duplex>();
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const url = new URL(req.url ?? "/", "http://fake");
    let body: unknown = {};
    switch (url.pathname) {
      case "/system_stats": body = { system: {}, devices: [cuda ? { type: "cuda", torch_vram_total: 0 } : { type: "cpu" }] }; break;
      case "/object_info": if (unlisted) { res.writeHead(500); res.end("{}"); return; } body = {
        CheckpointLoaderSimple: { input: { required: { ckpt_name: [missingModel ? [] : ["sdxl_lightning_4step.safetensors"]] } } },
        LoraLoader: { input: { required: { lora_name: [["RW_pixelart_XL_v1.safetensors"]] } } },
        ...(flux ? {
          UNETLoader: { input: { required: { unet_name: [["flux-2-klein-4b-fp8.safetensors"]] } } },
          CLIPLoader: { input: { required: { clip_name: [["qwen_3_4b.safetensors"]] } } },
          VAELoader: { input: { required: { vae_name: [["flux2-vae.safetensors"]] } } },
        } : {}),
      }; break;
      case "/prompt": {
        const id = `p${++n}`; active.add(id); runs.push({ id, startedAt: Date.now() });
        prompts.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        body = { prompt_id: id }; break;
      }
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
    prompts: () => prompts.map((p) => p.prompt),
    /** Also list the FLUX.2 Klein files, so a second family of image model is installed. */
    withFlux: () => { flux = true; },
    /** Report a CUDA device: the image fit then measures the (fake) GPU. */
    gpu: () => { cuda = true; },
    /** Send a progress frame for the newest running prompt to every open socket. */
    progress: (value: number, max: number) => {
      const id = [...active].at(-1);
      if (id === undefined) throw new Error("no prompt is running");
      const payload = Buffer.from(JSON.stringify({ type: "progress", data: { prompt_id: id, value, max } }));
      if (payload.length > 125) throw new Error("progress frame too long for a one-byte length");
      for (const socket of sockets) socket.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]));
    },
    /** Fail /object_info (on) or answer it again (off): the app then has never read the file list. */
    unlisted: (on: boolean) => { unlisted = on; },
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
