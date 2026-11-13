import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { WebSocketServer } from "ws";
import { afterEach, expect, it } from "vitest";
import type { ImageEvent } from "@gates-local/contracts";
import { createGpuLease } from "../gpu/lease.ts";
import { openThreadStore } from "../threads/store.ts";
import { createImageModule } from "./module.ts";
import { comfyInfo, KLEIN_FILES } from "../../test/comfy/info.ts";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

it("renders over fake HTTP and real WebSocket frames, ignoring unrelated object_info entries", async () => {
  const calls: string[] = [];
  const png = Buffer.from("iVBORw0KGgo=", "base64");
  let freeBytes = 2;
  const http = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://fake");
    calls.push(url.pathname);
    res.setHeader("Content-Type", "application/json");
    if (url.pathname === "/system_stats") return res.end(JSON.stringify({ system: {}, devices: [] }));
    if (url.pathname === "/object_info") return res.end(JSON.stringify({ UnrelatedOptionalNode: { input: { optional: {} } }, ...comfyInfo(KLEIN_FILES) }));
    if (url.pathname === "/queue") return res.end(JSON.stringify({ queue_running: [], queue_pending: [] }));
    if (url.pathname === "/api/generate") {
      let text = ""; for await (const chunk of req) text += String(chunk);
      expect(JSON.parse(text)).toEqual({ model: "app-only", keep_alive: 0 });
      freeBytes = 20; return res.end("{}");
    }
    if (url.pathname === "/prompt") {
      res.end(JSON.stringify({ prompt_id: "http-prompt" }));
      setImmediate(() => {
        for (const ws of wss.clients) {
          ws.send(JSON.stringify({ type: "progress", data: { prompt_id: "http-prompt", value: 1, max: 4 } }));
          ws.send(JSON.stringify({ type: "executing", data: { prompt_id: "http-prompt", node: null } }));
        }
      });
      return;
    }
    if (url.pathname === "/history/http-prompt") return res.end(JSON.stringify({ "http-prompt": { outputs: { "13": { images: [{ filename: "fake.png" }] } } } }));
    if (url.pathname === "/view") { res.setHeader("Content-Type", "image/png"); return res.end(png); }
    res.writeHead(404).end();
  });
  const wss = new WebSocketServer({ server: http });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address(); if (!address || typeof address === "string") throw new Error("no fake port");
  const dataDir = await mkdtemp(path.join(tmpdir(), "gates-image-http-"));
  dirs.push(dataDir);
  const store = openThreadStore(path.join(dataDir, "store.sqlite"));
  const events: ImageEvent[] = [];
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const image = createImageModule({ dataDir, store, lease: createGpuLease(), requiredBytes: 10,
    settings: () => ({ imageGen: true, comfyUrl: baseUrl }),
    imageMayUnload: () => ["app-only"], ollamaUrl: () => baseUrl,
    readGpu: async () => ({ freeBytes, holders: "whisper; external-chat" }),
    service: { inspect: async () => { throw new Error("custom URL must not inspect units"); }, start: async () => { throw new Error("must not start"); }, stop: async () => { throw new Error("must not stop"); } },
    push: (channel, payload) => { if (channel === "image.event") events.push(payload as ImageEvent); },
  });
  try {
    const { jobId } = await image.generate({ prompt: "tree" }); await image.wait(jobId);
    expect(events.at(-1)).toMatchObject({ state: "done", progress: 1 });
    expect(events.some((e) => e.progress === 0.25)).toBe(true);
    expect(await readFile(path.join(dataDir, "images", `${jobId}.png`))).toEqual(png);
    expect(calls.filter((p) => p === "/api/generate")).toHaveLength(1);
  } finally {
    await image.close(); store.close();
    for (const ws of wss.clients) ws.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => http.close(() => resolve()));
  }
});
