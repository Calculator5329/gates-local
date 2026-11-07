import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { ImageEvent, ImageStatus, Params } from "@gates-local/contracts";
import type { Push } from "../app.ts";
import { readGpu } from "../fit/gpu.ts";
import type { GpuLease } from "../gpu/lease.ts";
import type { ThreadStore } from "../threads/store.ts";
import { createComfyClient, type ComfyClientDeps } from "./client.ts";
import { createComfyService, type ComfyService } from "./service.ts";
import { IMAGE_ESTIMATED_BYTES } from "./workflow.ts";

export interface ImageDeps extends ComfyClientDeps {
  dataDir: string;
  lease: GpuLease;
  store: ThreadStore;
  push: Push;
  settings(): { imageGen: boolean; comfyUrl?: string };
  /** Only models the app loaded, never the complete /api/ps list. */
  appLoadedModels(): readonly string[];
  ollamaUrl(): string | undefined;
  onModelUnloaded?(model: string): void;
  readGpu?(): Promise<{ freeBytes: number; holders: string }>;
  service?: ComfyService;
  requiredBytes?: number;
  idleMs?: number;
  startupTimeoutMs?: number;
  jobTimeoutMs?: number;
}

export interface ImageModule {
  current(): ImageStatus;
  status(): Promise<ImageStatus>;
  generate(params: Params<"image.generate">): Promise<{ jobId: string }>;
  cancel(jobId: string): { cancelled: boolean };
  /** Test/CLI completion seam; errors are reported on image.event. */
  wait(jobId: string): Promise<void>;
  stopIdle(): Promise<void>;
  close(): Promise<void>;
}

const DEFAULT_URL = "http://127.0.0.1:8188";
const detail = (error: unknown) => error instanceof Error ? error.message : String(error);
const imageError = (code: string, message: string) => Object.assign(new Error(message), { code });

export function createImageModule(deps: ImageDeps): ImageModule {
  const service = deps.service ?? createComfyService();
  const jobs = new Map<string, { controller: AbortController; ended: Promise<void> }>();
  let status: ImageStatus = { state: "off", owner: "none" };
  let owned: { pid: number; baseUrl: string } | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let activeJob: string | undefined;
  const emit: Push = (channel, payload) => { try { deps.push(channel, payload); } catch { /* a disconnected client cannot strand a GPU job */ } };
  const update = (next: ImageStatus): ImageStatus => { status = next; emit("image.status", status); return status; };
  const config = () => {
    const settings = deps.settings();
    const url = new URL(settings.comfyUrl ?? DEFAULT_URL);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw imageError("image-config", "Set a ComfyUI HTTP address without credentials or query parameters in Settings.");
    const baseUrl = url.href.replace(/\/$/, "");
    return { enabled: settings.imageGen, baseUrl, managed: baseUrl === DEFAULT_URL && settings.comfyUrl === undefined };
  };
  const client = (baseUrl: string) => createComfyClient(baseUrl, deps);
  const clearIdle = () => { clearTimeout(idleTimer); idleTimer = undefined; };
  const armIdle = () => {
    clearIdle();
    if (!owned || closed) return;
    idleTimer = setTimeout(() => { void module.stopIdle().catch((error: unknown) => update({ ...status, state: "error", detail: `ComfyUI idle stop failed: ${detail(error)}` })); }, deps.idleMs ?? 300_000);
    idleTimer.unref();
  };
  const discover = async (): Promise<ImageStatus> => {
    const cfg = config();
    if (!cfg.enabled) return update({ state: "off", owner: owned ? "app" : "none" });
    if (jobs.size > 0) return status;
    if (await client(cfg.baseUrl).healthy()) {
      if (jobs.size > 0) return status;
      if (owned) {
        const unit = await service.inspect();
        if (unit.pid !== owned.pid || !unit.active) owned = undefined;
      }
      if (jobs.size > 0) return status;
      return update({ state: "ready", owner: owned?.baseUrl === cfg.baseUrl ? "app" : "external", baseUrl: cfg.baseUrl });
    }
    const unit = cfg.managed ? await service.inspect() : { present: false, active: false, pid: 0 };
    if (jobs.size > 0) return status;
    if (owned?.baseUrl === cfg.baseUrl && (!unit.active || unit.pid !== owned.pid)) owned = undefined;
    return update({ state: unit.active ? "starting" : unit.present ? "stopped" : "missing", owner: owned?.baseUrl === cfg.baseUrl ? "app" : unit.active ? "external" : "none", baseUrl: cfg.baseUrl,
      detail: unit.active ? "ComfyUI is running but its HTTP interface is not ready yet." : unit.present ? "ComfyUI will start when you make an image." : "ComfyUI did not answer. Install the local user service or set a running ComfyUI address in Settings." });
  };
  const measure = deps.readGpu ?? (async () => {
    const gpu = await readGpu();
    return { freeBytes: gpu.freeBytes, holders: gpu.tenants.map((t) => `${t.label} (${t.usedBytes ?? "unknown"} bytes)`).join(", ") || "unlisted GPU occupants" };
  });
  const fit = async (signal: AbortSignal) => {
    const need = deps.requiredBytes ?? IMAGE_ESTIMATED_BYTES;
    let gpu = await measure();
    if (!Number.isFinite(gpu.freeBytes) || gpu.freeBytes < 0) throw new Error("GPU free memory could not be measured. Retry when the GPU status is available.");
    if (gpu.freeBytes < need) {
      const models = [...new Set(deps.appLoadedModels())];
      const ollama = deps.ollamaUrl();
      if (ollama) for (const model of models) {
        signal.throwIfAborted();
        const response = await (deps.fetch ?? fetch)(`${ollama.replace(/\/$/, "")}/api/generate`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model, keep_alive: 0 }),
          signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
        });
        if (!response.ok) throw new Error(`Could not unload app chat model ${model}: Ollama HTTP ${response.status}.`);
        await response.arrayBuffer();
        deps.onModelUnloaded?.(model);
      }
      gpu = await measure();
    }
    signal.throwIfAborted();
    if (!Number.isFinite(gpu.freeBytes) || gpu.freeBytes < 0) throw new Error("GPU free memory could not be measured after unloading app chat.");
    if (gpu.freeBytes < need) throw imageError("wont-fit", `Image generation needs an estimated ${need} bytes; ${gpu.freeBytes} bytes are free, a shortfall of ${need - gpu.freeBytes} bytes. Memory holders: ${gpu.holders}. Close another GPU app or choose a smaller image setup. Protected occupants are left running.`);
  };
  const ensure = async (baseUrl: string, managed: boolean, signal: AbortSignal) => {
    const comfy = client(baseUrl);
    if (await comfy.healthy()) {
      if (owned) { const unit = await service.inspect(); if (owned.pid !== unit.pid || !unit.active) owned = undefined; }
      return comfy;
    }
    const before = managed ? await service.inspect() : { present: false, active: false, pid: 0 };
    if (!before.present) throw imageError("image-missing", "ComfyUI did not answer. Install comfyui.service or set a running ComfyUI address in Settings.");
    update({ state: "starting", owner: owned ? "app" : "none", baseUrl });
    signal.throwIfAborted();
    // An already-active but unresponsive unit is not ours. Wait, never adopt it.
    if (!before.active) {
      await service.start();
      const after = await service.inspect();
      if (!after.active || after.pid <= 0) throw new Error("ComfyUI started without a live MainPID. Check comfyui.service and retry.");
      owned = { pid: after.pid, baseUrl };
    }
    const deadline = Date.now() + (deps.startupTimeoutMs ?? 60_000);
    while (!await comfy.healthy()) {
      signal.throwIfAborted();
      if (Date.now() >= deadline) throw new Error("ComfyUI did not become ready within the startup timeout. Check comfyui.service and retry.");
      await delay(250, undefined, { signal });
    }
    signal.throwIfAborted();
    return comfy;
  };
  const module: ImageModule = {
    current: () => status,
    status: discover,
    async generate(params) {
      if (closed) throw imageError("shutting-down", "Image generation is shutting down.");
      let cfg = config();
      if (!cfg.enabled) throw imageError("image-off", "Image generation is off. Turn it on in Settings first.");
      if (!params.prompt.trim()) throw imageError("bad-params", "Describe the image you want to make.");
      if (params.threadId) deps.store.getThread(params.threadId);
      clearIdle();
      const jobId = randomUUID();
      const controller = new AbortController();
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(deps.jobTimeoutMs ?? 600_000)]);
      const event = (state: ImageEvent["state"], rest: Partial<ImageEvent> = {}) => emit("image.event", { jobId, ...params.threadId ? { threadId: params.threadId } : {}, state, ...rest });
      event("queued");
      // Begin after registering the promise; generate returns before any running event.
      const ended = Promise.resolve().then(async () => {
        try {
          await deps.lease.run("image", signal, async () => {
            const latest = config();
            if (!latest.enabled) throw imageError("image-off", "Image generation was turned off while this job waited.");
            cfg = latest;
            activeJob = jobId;
            update({ state: "busy", owner: owned ? "app" : "none", baseUrl: cfg.baseUrl });
            await fit(signal);
            const comfy = await ensure(cfg.baseUrl, cfg.managed, signal);
            await fit(signal); // startup or another GPU app may have changed the room
            update({ state: "busy", owner: owned?.baseUrl === cfg.baseUrl ? "app" : "external", baseUrl: cfg.baseUrl });
            event("running", { progress: 0 });
            const bytes = await comfy.render(params.prompt, jobId, signal, (progress) => event("running", { progress }));
            signal.throwIfAborted();
            const imagePath = `images/${jobId}.png`;
            await mkdir(path.join(deps.dataDir, "images"), { recursive: true });
            const pendingPath = path.join(deps.dataDir, "images", `${jobId}.pending`);
            await writeFile(pendingPath, bytes, { flag: "wx", signal });
            signal.throwIfAborted();
            await rename(pendingPath, path.join(deps.dataDir, imagePath));
            signal.throwIfAborted();
            if (params.threadId) {
              deps.store.appendMessage({ threadId: params.threadId, role: "assistant", content: params.prompt, images: [imagePath] });
              emit("threads.changed", { threadId: params.threadId });
            }
            event("done", { progress: 1, imagePath });
            update({ state: "ready", owner: owned?.baseUrl === cfg.baseUrl ? "app" : "external", baseUrl: cfg.baseUrl });
          });
        } catch (error) {
          const message = signal.aborted && !controller.signal.aborted ? "Image exceeded its run timeout. Retry when ComfyUI is ready." : detail(error);
          event(controller.signal.aborted ? "cancelled" : "error", { message });
          if (controller.signal.aborted && activeJob === jobId) {
            const healthy = await client(cfg.baseUrl).healthy();
            if (activeJob === jobId) update({ state: healthy ? "ready" : "stopped", owner: owned?.baseUrl === cfg.baseUrl ? "app" : healthy ? "external" : "none", baseUrl: cfg.baseUrl });
          } else if (!controller.signal.aborted && (activeJob === jobId || activeJob === undefined)) {
            update({ state: "error", owner: owned?.baseUrl === cfg.baseUrl ? "app" : "none", baseUrl: cfg.baseUrl, detail: message });
          }
        } finally {
          if (activeJob === jobId) activeJob = undefined;
          jobs.delete(jobId);
          if (jobs.size === 0) armIdle();
        }
      });
      jobs.set(jobId, { controller, ended });
      return { jobId };
    },
    cancel(jobId) {
      const job = jobs.get(jobId);
      if (!job || job.controller.signal.aborted) return { cancelled: false };
      job.controller.abort(new Error("Image cancelled.")); return { cancelled: true };
    },
    async wait(jobId) { await jobs.get(jobId)?.ended; },
    async stopIdle() {
      clearIdle();
      if (!owned || jobs.size > 0) return;
      await deps.lease.run("image", undefined, async () => {
        if (!owned || jobs.size > 0) return;
        const unit = await service.inspect();
        if (!unit.active || unit.pid !== owned.pid) { owned = undefined; return; }
        // Another Comfy client may have submitted work since ours ended.
        if (!await client(owned.baseUrl).idle()) { armIdle(); return; }
        const latest = await service.inspect();
        if (!latest.active || latest.pid !== owned.pid) { owned = undefined; return; }
        if (jobs.size > 0) return;
        await service.stop();
        const baseUrl = owned.baseUrl; owned = undefined;
        update({ state: "stopped", owner: "none", baseUrl });
      });
    },
    async close() {
      closed = true; clearIdle();
      const pending = [...jobs.values()];
      for (const job of pending) job.controller.abort(new Error("Image generation is shutting down."));
      await Promise.all(pending.map((job) => job.ended));
      await module.stopIdle();
    },
  };
  return module;
}
