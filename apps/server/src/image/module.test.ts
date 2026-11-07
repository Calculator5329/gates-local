import { mkdtemp, readFile, symlink, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ImageEvent } from "@gates-local/contracts";
import { createGpuLease } from "../gpu/lease.ts";
import { openThreadStore } from "../threads/store.ts";
import { startWsServer } from "../ws/server.ts";
import { createImageModule } from "./module.ts";
import { createImageHandlers } from "./handlers.ts";

const png = Buffer.from("iVBORw0KGgo=", "base64");
const instances: { close(): Promise<void> }[] = [];
afterEach(async () => { vi.useRealTimers(); await Promise.all(instances.splice(0).map((i) => i.close())); });

async function fixture() {
  const dataDir = await mkdtemp(path.join(tmpdir(), "gates-image-"));
  const lease = createGpuLease();
  const events: ImageEvent[] = [];
  const calls: string[] = [];
  let enabled = true, answering = true, present = true, pid = 42, freeBytes = 20_000;
  let hold = false, missingModel = false, die = false, running = false;
  let swapPidOnQueue = false;
  let freeAfterStart: number | undefined;
  let activeOverride: boolean | undefined;
  let socket: EventTarget | undefined;
  const store = openThreadStore(path.join(dataDir, "threads.sqlite"));
  instances.push({ close: async () => store.close() });
  const module = createImageModule({
    dataDir, lease, store, requiredBytes: 10_000, idleMs: 20,
    settings: () => ({ imageGen: enabled }),
    appLoadedModels: () => ["app-chat"], ollamaUrl: () => "http://fake-ollama",
    readGpu: async () => ({ freeBytes, holders: "whisper 2000 bytes; other-app 3000 bytes" }),
    service: {
      inspect: async () => ({ present, active: activeOverride ?? answering, pid }),
      start: async () => { calls.push("start"); answering = true; if (freeAfterStart !== undefined) freeBytes = freeAfterStart; },
      stop: async () => { calls.push("stop"); answering = false; },
    },
    socket: () => {
      socket = new EventTarget();
      Object.defineProperty(socket, "readyState", { value: 1 });
      Object.assign(socket, { close() {} });
      return socket as WebSocket;
    },
    fetch: async (input, init) => {
      const url = new URL(String(input)); calls.push(url.pathname);
      if (url.host === "fake-ollama") {
        expect(JSON.parse(String(init?.body))).toEqual({ model: "app-chat", keep_alive: 0 });
        freeBytes += 6000; return Response.json({});
      }
      if (!answering) throw new Error("offline");
      if (url.pathname === "/system_stats") return Response.json({ system: { comfyui_version: "fake" }, devices: [] });
      if (url.pathname === "/object_info") return Response.json({
        CheckpointLoaderSimple: { input: { required: { ckpt_name: [missingModel ? [] : ["sdxl_lightning_4step.safetensors"]] } } },
        LoraLoader: { input: { required: { lora_name: [["RW_pixelart_XL_v1.safetensors"]] } } },
      });
      if (url.pathname === "/queue") { if (swapPidOnQueue) pid = 99; return Response.json({ queue_running: running ? [[1, "p1"]] : [], queue_pending: [] }); }
      if (url.pathname === "/prompt") {
        running = true;
        const body = JSON.parse(String(init?.body));
        expect(body.prompt["3"].inputs.text).toBe("a tree");
        queueMicrotask(() => {
          socket?.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "progress", data: { prompt_id: "p1", value: 2, max: 4 } }) }));
          if (die) { running = false; socket?.dispatchEvent(new Event("close")); }
          else if (!hold) { running = false; socket?.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "executing", data: { prompt_id: "p1", node: null } }) })); }
        });
        return Response.json({ prompt_id: "p1" });
      }
      if (url.pathname === "/history/p1") return Response.json({ p1: { outputs: { "8": { images: [{ filename: "out.png", subfolder: "", type: "output" }] } } } });
      if (url.pathname === "/view") return new Response(png);
      if (url.pathname === "/interrupt") { running = false; return Response.json({}); }
      throw new Error(`unexpected ${url.pathname}`);
    },
    push: (channel, payload) => { if (channel === "image.event") events.push(payload as ImageEvent); },
  });
  instances.push(module);
  const handlers = createImageHandlers({ image: module });
  return { module, handlers, lease, store, events, calls, dataDir,
    configure: (v: { enabled?: boolean; answering?: boolean; present?: boolean; pid?: number; freeBytes?: number; hold?: boolean; missingModel?: boolean; die?: boolean; swapPidOnQueue?: boolean; freeAfterStart?: number; activeOverride?: boolean }) => {
      enabled = v.enabled ?? enabled; answering = v.answering ?? answering; present = v.present ?? present;
      pid = v.pid ?? pid; freeBytes = v.freeBytes ?? freeBytes; hold = v.hold ?? hold;
      missingModel = v.missingModel ?? missingModel; die = v.die ?? die;
      swapPidOnQueue = v.swapPidOnQueue ?? swapPidOnQueue; freeAfterStart = v.freeAfterStart ?? freeAfterStart;
      activeOverride = v.activeOverride ?? activeOverride;
    },
  };
}

describe("image lifecycle (injected fake Comfy HTTP/WebSocket and Ollama)", () => {
  it("reports off, missing and stopped without starting anything", async () => {
    const f = await fixture();
    f.configure({ enabled: false }); expect((await f.module.status()).state).toBe("off");
    await expect(f.module.generate({ prompt: "a tree" })).rejects.toThrow(/off/i);
    f.configure({ enabled: true, answering: false, present: false }); expect((await f.module.status()).state).toBe("missing");
    f.configure({ present: true }); expect((await f.module.status()).state).toBe("stopped");
    expect(f.calls).not.toContain("start");
  });
  it("reports an active external unit awaiting HTTP as starting, without adopting or starting it", async () => {
    const f = await fixture(); f.configure({ answering: false, activeOverride: true });
    expect(await f.module.status()).toMatchObject({ state: "starting", owner: "external" });
    await f.module.stopIdle(); expect(f.calls).not.toContain("start"); expect(f.calls).not.toContain("stop");
  });
  it("saves a fitting image, pushes progress, appends to its thread and leaves external Comfy running", async () => {
    const f = await fixture(); const thread = f.store.createThread({});
    const { jobId } = await f.handlers["image.generate"]({ prompt: "a tree", threadId: thread.id });
    await f.module.wait(jobId);
    expect(f.events.some((e) => e.progress === 0.5)).toBe(true);
    expect(f.events.at(-1)?.state).toBe("done");
    expect(await readFile(path.join(f.dataDir, "images", `${jobId}.png`))).toEqual(png);
    expect(f.store.getThread(thread.id).messages[0]?.images).toEqual([`images/${jobId}.png`]);
    await f.module.stopIdle(); expect(f.calls).not.toContain("stop"); expect(f.calls).not.toContain("/api/generate");
  });
  it("starts a stopped unit and stops it at idle only while MainPID matches", async () => {
    const f = await fixture(); f.configure({ answering: false });
    const { jobId } = await f.module.generate({ prompt: "a tree" }); await f.module.wait(jobId);
    expect((await f.module.status()).owner).toBe("app"); expect(f.calls).toContain("start");
    vi.useFakeTimers(); await f.module.stopIdle(); expect(f.calls).toContain("stop");
    vi.useRealTimers();
    f.configure({ answering: false }); const next = await f.module.generate({ prompt: "a tree" }); await f.module.wait(next.jobId);
    f.configure({ pid: 99 }); const count = f.calls.filter((c) => c === "stop").length;
    await f.module.stopIdle(); expect(f.calls.filter((c) => c === "stop")).toHaveLength(count);
  });
  it("unloads only app-loaded chat and measures again; refuses with numbers and occupants if still short", async () => {
    const f = await fixture(); f.configure({ freeBytes: 5000 });
    const first = await f.module.generate({ prompt: "a tree" }); await f.module.wait(first.jobId);
    expect(f.events.at(-1)?.state).toBe("done"); expect(f.calls.filter((c) => c === "/api/generate")).toHaveLength(1);
    f.configure({ freeBytes: 100 }); const next = await f.module.generate({ prompt: "a tree" }); await f.module.wait(next.jobId);
    expect(f.events.at(-1)).toMatchObject({ state: "error", message: expect.stringMatching(/10000.*6100.*3900.*whisper.*other-app/) });
    expect(f.lease.status().holder).toBeNull();
  });
  it("cancels a queued image without interrupting Comfy", async () => {
    const f = await fixture(); const release = await f.lease.acquire("chat");
    const { jobId } = await f.module.generate({ prompt: "a tree" });
    expect(f.module.cancel(jobId)).toEqual({ cancelled: true }); await f.module.wait(jobId);
    expect(f.events.at(-1)?.state).toBe("cancelled"); expect(f.calls).not.toContain("/interrupt");
    expect(f.lease.status().waiting).toEqual([]); release();
  });
  it("interrupts its running job and releases the lease", async () => {
    const f = await fixture(); f.configure({ hold: true });
    const { jobId } = await f.module.generate({ prompt: "a tree" });
    await vi.waitFor(() => expect(f.events.some((e) => e.progress === 0.5)).toBe(true));
    f.module.cancel(jobId); await f.module.wait(jobId);
    expect(f.calls).toContain("/interrupt"); expect(f.events.at(-1)?.state).toBe("cancelled"); expect(f.lease.status().holder).toBeNull();
    expect(f.module.current().state).toBe("ready");
  });
  it("releases on Comfy death and reports error; refuses absent checkpoints before submit", async () => {
    const f = await fixture(); f.configure({ die: true });
    const first = await f.module.generate({ prompt: "a tree" }); await f.module.wait(first.jobId);
    expect(f.events.at(-1)?.state).toBe("error"); expect(f.module.current().state).toBe("error"); expect(f.lease.status().holder).toBeNull();
    f.configure({ die: false, missingModel: true }); const second = await f.module.generate({ prompt: "a tree" }); await f.module.wait(second.jobId);
    expect(f.events.at(-1)?.message).toMatch(/sdxl_lightning_4step.*install/i);
  });
  it("uses the idle timer after an app-owned job", async () => {
    const f = await fixture(); f.configure({ answering: false });
    vi.useFakeTimers(); const { jobId } = await f.module.generate({ prompt: "a tree" }); await f.module.wait(jobId);
    await vi.advanceTimersByTimeAsync(21); expect(f.calls).toContain("stop");
  });
  it("keeps the active image busy when another queued image is cancelled", async () => {
    const f = await fixture(); f.configure({ hold: true });
    const active = await f.module.generate({ prompt: "a tree" });
    await vi.waitFor(() => expect(f.events.some((e) => e.progress === 0.5)).toBe(true));
    const queued = await f.module.generate({ prompt: "a tree" }); f.module.cancel(queued.jobId); await f.module.wait(queued.jobId);
    expect((await f.module.status()).state).toBe("busy");
    f.module.cancel(active.jobId); await f.module.wait(active.jobId);
  });
  it("rechecks MainPID after the idle queue read", async () => {
    const f = await fixture(); f.configure({ answering: false });
    const { jobId } = await f.module.generate({ prompt: "a tree" }); await f.module.wait(jobId);
    f.configure({ swapPidOnQueue: true }); await f.module.stopIdle(); expect(f.calls).not.toContain("stop");
  });
  it("remeasures the room after Comfy starts, before submitting an image", async () => {
    const f = await fixture(); f.configure({ answering: false, freeAfterStart: 0 });
    const { jobId } = await f.module.generate({ prompt: "a tree" }); await f.module.wait(jobId);
    expect(f.events.at(-1)?.state).toBe("error"); expect(f.calls).not.toContain("/prompt");
  });
});

it("serves only token-authorized PNGs inside images, refusing traversal and symlinks", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "gates-files-")); await mkdir(path.join(dir, "images"));
  await writeFile(path.join(dir, "images", "job.png"), png); await writeFile(path.join(dir, "outside.png"), png);
  await symlink(path.join(dir, "outside.png"), path.join(dir, "images", "link.png"));
  const server = await startWsServer({ port: 0, token: "test-launch", allowedOrigins: [], handlers: {}, dataDir: dir }); instances.push(server);
  const base = `http://127.0.0.1:${server.port}`;
  expect((await fetch(`${base}/files/images/job.png?token=bad`)).status).toBe(401);
  const ok = await fetch(`${base}/files/images/job.png?token=test-launch`); expect(ok.status).toBe(200); expect(ok.headers.get("content-type")).toBe("image/png");
  expect(Buffer.from(await ok.arrayBuffer())).toEqual(png);
  for (const url of ["/files/images/%2e%2e%2foutside.png", "/files/images/link.png"]) expect((await fetch(`${base}${url}?token=test-launch`)).status).toBe(404);
});
