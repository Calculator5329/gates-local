import { mkdtemp, readFile, readdir, rm, symlink, writeFile, mkdir } from "node:fs/promises";
import * as files from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FitReport, GpuStatus, ImageChoice, ImageDownload, ImageEvent, ModelLoad, Params } from "@gates-local/contracts";
import { imageFitEdges } from "@gates-local/contracts/testing";
import { startFakeOllama } from "../../../../test/fake-ollama/fake-ollama.ts";
import { createModelLoader } from "../runtime/load.ts";
import { listLoaded } from "../runtime/models.ts";
import { DEFAULT_CHOICE, NO_GPU, PRESETS, resolveChoice, SLOW } from "./presets.ts";
import { cellsFor } from "./styles.ts";
import { comfyInfo, KLEIN_COMPACT_FILES, KLEIN_FILES, MOSS_FILES, SDXL_FILES, ZIMAGE_FILES } from "../../test/comfy/info.ts";
import { createGpuLease } from "../gpu/lease.ts";
import { openThreadStore } from "../threads/store.ts";
import { startWsServer } from "../ws/server.ts";
import { createImageModule, imageFitError, imageRoom, isLocalHost, type GpuHolder, type ImageDeps } from "./module.ts";
import { createImageHandlers } from "./handlers.ts";
import { createComfyService } from "./service.ts";
import { createServerShutdown, HARD_EXIT_MS } from "../shutdown.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, writeFile: vi.fn(actual.writeFile) };
});

const png = Buffer.from("iVBORw0KGgo=", "base64");
const noop = () => undefined;
/** This machine is 192.168.1.20 and is called mybox; the hosts file maps mybox to 127.0.1.1. */
const NAMES: Record<string, readonly string[]> = {
  "mybox": ["127.0.1.1"], "mybox.home.arpa": ["192.168.1.20"], "remote-comfy": ["10.0.0.5"],
  "elsewhere": ["10.0.0.9"], "split-name": ["10.0.0.7", "192.168.1.20"],
};
const fakeLookup = async (name: string) => {
  // An absolute name ("mybox.") resolves as its table entry, with no search suffix.
  const found = NAMES[name] ?? NAMES[name.replace(/\.$/, "")];
  if (!found) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${name}`), { code: "ENOTFOUND" });
  return found;
};
/** A host as config() passes it: the URL parser's hostname spelling. */
const configHostname = (h: string) => new URL(`http://${h}:8188`).hostname;
const instances: { close(): Promise<void> }[] = [];
const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks(); vi.useRealTimers();
  try {
    for (const instance of instances.splice(0).toReversed()) await instance.close();
  } finally {
    await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
  }
});

/** `realOllama`: requests to this address go to that server (the repo's fake Ollama), the rest to the fake Comfy below. */
async function fixture(options: Partial<ImageDeps> = {}, realOllama?: string) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "gates-image-"));
  dirs.push(dataDir);
  const lease = createGpuLease();
  const events: ImageEvent[] = [];
  const downloads: ImageDownload[] = [];
  /** threads.changed pushes, by thread id. */
  const changed: string[] = [];
  const calls: string[] = [];
  let enabled = true, answering = true, present = true, pid = 42, freeBytes = 20_000;
  let hold = false, missingModel = false, die = false;
  let busy = false, noImage = false, invalidPng = false;
  const running = new Set<string>(); // hosts whose fake ComfyUI is running a prompt; each address has its own queue
  let swapPidOnQueue = false;
  let freeAfterStart: number | undefined;
  let activeOverride: boolean | undefined;
  let activeState: string | undefined;
  let resident = 0;
  let comfyUrl: string | undefined, cpu = false, gpuError = false, stuck = false, queueErrors = 0;
  let measurements = 0;
  let choice: ImageChoice | undefined, noMoss = false, flux = false;
  // ComfyUI's template, saved-workflow and folder routes (path and query): what each answers; any other is a 404
  let workflowRoutes: Record<string, unknown> = {};
  let moreLoras: string[] = []; // LoRAs /object_info lists besides the app's own
  // Ollama's /api/ps (undefined: it answers 500), and the app's loaded models, pruned on unload as main.ts does
  let listed: string[] | undefined = ["foreign-chat", "app-chat"];
  let appLoaded = ["app-chat"];
  const graphs: Record<string, { class_type: string; inputs: Record<string, unknown> }>[] = [];
  const ollamaPosts: unknown[] = [];
  let fakeFetch!: typeof fetch;
  let socket: EventTarget | undefined;
  const store = openThreadStore(path.join(dataDir, "threads.sqlite"));
  instances.push({ close: async () => store.close() });
  const module = createImageModule({
    dataDir, lease, store, requiredBytes: 10_000, idleMs: 20,
    log: () => {},
    // No test reaches real DNS or this machine's real interfaces.
    localAddresses: () => ["192.168.1.20"], lookupHost: fakeLookup,
    settings: () => ({ imageGen: enabled, ...(comfyUrl ? { comfyUrl } : {}), ...(choice ? { imageChoice: choice } : {}) }),
    imageMayUnload: () => appLoaded, ollamaUrl: () => "http://fake-ollama",
    readGpu: async () => {
      measurements++;
      if (gpuError) throw Object.assign(new Error("nvidia-smi failed"), { code: "gpu-unreadable" });
      return { freeBytes, holders: "whisper 2000 bytes; other-app 3000 bytes", tenants: [{ pid, usedBytes: resident }] };
    },
    service: {
      inspect: async () => { calls.push("inspect"); return { present, active: activeOverride ?? answering, activeState: activeState ?? ((activeOverride ?? answering) ? "active" : "inactive"), pid }; },
      start: async () => { calls.push("start"); answering = true; activeState = "active"; if (freeAfterStart !== undefined) freeBytes = freeAfterStart; },
      stop: async () => { calls.push("stop"); answering = false; activeState = "inactive"; },
    },
    socket: () => {
      socket = new EventTarget();
      Object.defineProperty(socket, "readyState", { value: 1 });
      Object.assign(socket, { close() {} });
      return socket as WebSocket;
    },
    fetch: fakeFetch = async (input, init) => {
      const url = new URL(String(input)); calls.push(url.pathname);
      if (realOllama !== undefined && String(input).startsWith(realOllama)) { ollamaPosts.push(JSON.parse(String(init?.body))); return fetch(input, init); }
      if (url.host === "fake-ollama") {
        if (url.pathname === "/api/ps") return listed === undefined ? new Response("down", { status: 500 }) : Response.json({ models: listed.map((name) => ({ name })) });
        const body: unknown = JSON.parse(String(init?.body)); ollamaPosts.push(body);
        expect(body).toEqual({ model: "app-chat", keep_alive: 0 });
        freeBytes += 6000; return Response.json({});
      }
      if (!answering) throw new Error("offline");
      if (url.pathname.startsWith("/templates/") || url.pathname.startsWith("/userdata") || url.pathname.startsWith("/internal/")) {
        const route = `${url.pathname}${url.search}`;
        return route in workflowRoutes ? Response.json(workflowRoutes[route]) : new Response("not found", { status: 404 });
      }
      if (url.pathname === "/system_stats") return Response.json({ system: { comfyui_version: "fake" }, devices: [{ type: cpu ? "cpu" : "cuda", torch_vram_total: resident }] });
      // Z-Image int8's and MOSS's files (missingModel: neither diffusion model; noMoss: MOSS's text encoder gone), a person's own SDXL files, and with `flux` Klein's
      if (url.pathname === "/object_info") return Response.json(comfyInfo(
        { ...ZIMAGE_FILES, ...missingModel ? { diffusion_models: [] } : {} },
        { ...MOSS_FILES, ...missingModel ? { diffusion_models: [] } : {}, ...noMoss ? { text_encoders: [] } : {} },
        { ...SDXL_FILES, loras: [...SDXL_FILES.loras ?? [], ...moreLoras] },
        ...flux ? [KLEIN_FILES, KLEIN_COMPACT_FILES] : [],
      ));
      if (url.pathname === "/queue") { if (queueErrors-- > 0) throw new Error("queue temporarily unavailable"); if (swapPidOnQueue) pid = 99; return Response.json({ queue_running: busy ? [[1, "foreign"]] : running.has(url.host) ? [[1, "p1"]] : [], queue_pending: [] }); }
      if (url.pathname === "/prompt") {
        running.add(url.host);
        const body = JSON.parse(String(init?.body));
        graphs.push(body.prompt);
        if (!flux) expect(Object.values(body.prompt as Record<string, { inputs: { text?: unknown } }>).map((n) => n.inputs.text)).toContain("a tree");
        queueMicrotask(() => {
          socket?.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "progress", data: { prompt_id: "p1", value: 2, max: 4 } }) }));
          if (die) { running.delete(url.host); answering = false; socket?.dispatchEvent(new Event("close")); }
          else if (!hold) { running.delete(url.host); socket?.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "executing", data: { prompt_id: "p1", node: null } }) })); }
        });
        return Response.json({ prompt_id: "p1" });
      }
      if (url.pathname === "/history/p1") return Response.json(hold ? {} : { p1: { outputs: noImage ? {} : { "8": { images: [{ filename: "out.png", subfolder: "", type: "output" }] } } } });
      if (url.pathname === "/view") return new Response(invalidPng ? Buffer.from("not a PNG") : png);
      if (url.pathname === "/interrupt") { if (!stuck) running.delete(url.host); return Response.json({}); }
      throw new Error(`unexpected ${url.pathname}`);
    },
    push: (channel, payload) => {
      if (channel === "image.event") events.push(payload as ImageEvent);
      if (channel === "image.download") downloads.push(payload as ImageDownload);
      if (channel === "threads.changed") changed.push((payload as { threadId: string }).threadId);
    },
    swapWaitMs: 50, swapPollMs: 5,
    ...options,
    onModelUnloaded: (model) => { appLoaded = appLoaded.filter((m) => m !== model); options.onModelUnloaded?.(model); },
  });
  instances.push(module);
  const handlers = createImageHandlers({ image: module });
  return { module, handlers, lease, store, events, downloads, changed, calls, dataDir, ollamaPosts, graphs, ps: () => fakeFetch("http://fake-ollama/api/ps"), measurements: () => measurements,
    choose: (next: ImageChoice | undefined) => { choice = next; },
    files: (v: { noMoss?: boolean; flux?: boolean; loras?: string[] }) => { noMoss = v.noMoss ?? noMoss; flux = v.flux ?? flux; moreLoras = v.loras ?? moreLoras; },
    workflows: (routes: Record<string, unknown>) => { workflowRoutes = routes; },
    ollamaLists: (models: string[] | undefined) => { listed = models; },
    configure: (v: { enabled?: boolean; answering?: boolean; present?: boolean; pid?: number; freeBytes?: number; hold?: boolean; missingModel?: boolean; die?: boolean; swapPidOnQueue?: boolean; freeAfterStart?: number; activeOverride?: boolean; activeState?: string; resident?: number; comfyUrl?: string; cpu?: boolean; gpuError?: boolean; stuck?: boolean; queueErrors?: number; busy?: boolean; noImage?: boolean; invalidPng?: boolean }) => {
      enabled = v.enabled ?? enabled; answering = v.answering ?? answering; present = v.present ?? present;
      pid = v.pid ?? pid; freeBytes = v.freeBytes ?? freeBytes; hold = v.hold ?? hold;
      missingModel = v.missingModel ?? missingModel; die = v.die ?? die;
      swapPidOnQueue = v.swapPidOnQueue ?? swapPidOnQueue; freeAfterStart = v.freeAfterStart ?? freeAfterStart;
      activeOverride = v.activeOverride ?? activeOverride;
      activeState = v.activeState ?? activeState; resident = v.resident ?? resident;
      comfyUrl = v.comfyUrl ?? comfyUrl; cpu = v.cpu ?? cpu; gpuError = v.gpuError ?? gpuError; stuck = v.stuck ?? stuck; queueErrors = v.queueErrors ?? queueErrors;
      busy = v.busy ?? busy; noImage = v.noImage ?? noImage; invalidPng = v.invalidPng ?? invalidPng;
    },
  };
}

describe("image lifecycle (injected fake Comfy HTTP/WebSocket and Ollama)", () => {
  it.each(["owned", "foreign", "changed", "unreadable"])("SN-CO-06 shutdown's deadline stops only the current app-started unit (%s)", async kind => {
    let up = kind === "foreign";
    const stop = vi.fn();
    const read = vi.fn(() => {
      if (kind === "unreadable") throw new Error("Unit read timed out");
      return kind === "changed" ? "99" : "42";
    });
    let f: Awaited<ReturnType<typeof fixture>>;
    const service = createComfyService("linux", async args => {
      if (args[1] === "start") { up = true; f.configure({ answering: true }); }
      if (args[1] === "stop") up = false;
      return `LoadState=loaded\nActiveState=${up ? "active" : "inactive"}\nMainPID=42\n`;
    }, { read, stop });
    f = await fixture({ service, idleMs: 60_000 });
    f.configure({ answering: up, hold: true });
    const job = await f.module.generate({ prompt: "a tree" });
    await vi.waitFor(() => expect(f.calls).toContain("/prompt"));
    expect(f.module.activeJobs?.()).toBe(1);
    let release: () => void = vi.fn();
    const stalled = new Promise<void>(resolve => { release = resolve; });
    const idle = { close: noop };
    const exit = vi.fn();
    vi.useFakeTimers();
    const shutdown = createServerShutdown({ admission: idle, stopAutomatic: noop, app: { shutdown: noop }, update: idle, imports: { close: () => stalled }, loader: idle, image: f.module, server: () => idle, store: idle, models: { close: noop, killRuntimeNow: noop }, log: noop, exit });
    const closing = shutdown("SIGTERM");
    try {
      await vi.advanceTimersByTimeAsync(HARD_EXIT_MS);
      expect(exit).toHaveBeenCalledExactlyOnceWith(1);
      expect(stop).toHaveBeenCalledTimes(kind === "owned" ? 1 : 0);
      expect(read).toHaveBeenCalledTimes(kind === "foreign" ? 0 : 1);
      f.module.killRuntimeNow?.();
      expect(stop).toHaveBeenCalledTimes(kind === "owned" ? 1 : 0);
      expect(read).toHaveBeenCalledTimes(kind === "foreign" ? 0 : 1);
    } finally { vi.useRealTimers(); release(); await closing; await f.module.wait(job.jobId); }
  });
  it("AU-01 image jobs pass admission before any job or Comfy request", async () => {
    const options = { admit: () => { throw Object.assign(new Error("Gates Local is closing to update."), { code: "update-installing" }); } };
    const f = await fixture(options);
    await expect(f.module.generate({ prompt: "Do not start" })).rejects.toMatchObject({ code: "update-installing" });
    expect(f.module.activeJobs?.()).toBe(0);
    expect(f.calls).toEqual([]);
  });
  it("rolls back the retry card if linking the original attempt fails", async () => {
    const f = await fixture(); const thread = f.store.createThread();
    f.store.saveImageJob({ jobId: "failed", threadId: thread.id, state: "error" }, "a tree");
    const db = new DatabaseSync(f.store.dbPath);
    db.exec("CREATE TRIGGER refuse_retry_link BEFORE UPDATE ON messages WHEN OLD.id = 'failed' BEGIN SELECT RAISE(ABORT, 'write failed'); END");
    try {
      await expect(f.module.generate({ prompt: "a tree", threadId: thread.id, retryOf: "failed" })).rejects.toThrow("write failed");
      expect(f.store.getThread(thread.id).messages).toMatchObject([{ id: "failed", imageJob: { state: "error" } }]);
      expect(f.store.getThread(thread.id).messages).toHaveLength(1);
      expect(f.lease.status().waiting).toEqual([]);
    } finally { db.close(); }
  });
  it("keeps retry identity after completion and database reopen, using the original prompt", async () => {
    const f = await fixture(); const thread = f.store.createThread();
    f.store.saveImageJob({ jobId: "failed", threadId: thread.id, state: "error" }, "a tree");
    const retry = await f.module.generate({ prompt: "an altered prompt", threadId: thread.id, retryOf: "failed" });
    await f.module.wait(retry.jobId);
    expect(f.store.getThread(thread.id).messages[1]).toMatchObject({ content: "a tree", imageJob: { state: "done" } });
    const reopened = openThreadStore(f.store.dbPath);
    try {
      expect(reopened.claimImageRetry(thread.id, "failed", "duplicate", { preset: "z-image-int8", width: 1024, height: 1024 })).toEqual({ jobId: retry.jobId, prompt: "a tree", choice: { preset: "z-image-int8", width: 1024, height: 1024 }, created: false });
      expect(await f.module.generate({ prompt: "a tree", threadId: thread.id, retryOf: "failed" })).toEqual(retry);
      expect(reopened.getThread(thread.id).messages).toHaveLength(2);
      expect(f.calls.filter(c => c === "/prompt")).toHaveLength(1);
    } finally { reopened.close(); }
  });
  it("rejects retries of a running job or a job from another thread", async () => {
    const f = await fixture(); const thread = f.store.createThread(); const other = f.store.createThread();
    const release = await f.lease.acquire("chat");
    const job = await f.module.generate({ prompt: "a tree", threadId: thread.id });
    try {
      await expect(f.module.generate({ prompt: "a tree", threadId: thread.id, retryOf: job.jobId })).rejects.toThrow("only a failed or cancelled");
      await expect(f.module.generate({ prompt: "a tree", threadId: other.id, retryOf: job.jobId })).rejects.toThrow("not in this thread");
      expect(f.store.getThread(thread.id).messages).toHaveLength(1);
      expect(f.store.getThread(other.id).messages).toHaveLength(0);
    } finally { f.module.cancel(job.jobId); release(); await f.module.wait(job.jobId); }
  });
  it("deduplicates two clients retrying the same failed image and records both cards atomically", async () => {
    const f = await fixture(); const thread = f.store.createThread();
    f.configure({ missingModel: true });
    const original = await f.module.generate({ prompt: "a tree", threadId: thread.id });
    await f.module.wait(original.jobId);
    f.configure({ missingModel: false });
    const observer = openThreadStore(f.store.dbPath);
    const release = await f.lease.acquire("chat");
    const attempts = await Promise.all([1, 2].map(() => f.module.generate({ prompt: "a tree", threadId: thread.id, retryOf: original.jobId })));
    try {
      expect(attempts[0]?.jobId).toBe(attempts[1]?.jobId);
      expect(observer.getThread(thread.id).messages).toMatchObject([
        { id: original.jobId, imageJob: { state: "error", retryJobId: attempts[0]?.jobId } },
        { id: attempts[0]?.jobId, imageJob: { state: "queued" } },
      ]);
      expect(f.lease.status().waiting).toEqual(["image"]);
    } finally { for (const job of attempts) f.module.cancel(job.jobId); release(); await Promise.all(attempts.map(job => f.module.wait(job.jobId))); observer.close(); }
  });
  it("recovers queued and running cards after reopening the database, without touching ComfyUI", async () => {
    const f = await fixture(); const thread = f.store.createThread();
    for (const state of ["queued", "running"] as const) f.store.saveImageJob({ jobId: state, threadId: thread.id, state }, "private prompt");
    f.store.close();
    const store = openThreadStore(f.store.dbPath);
    instances.push({ close: async () => store.close() });
    const fetcher = vi.fn(); const log = vi.fn();
    const recovered = createImageModule({ dataDir: f.dataDir, store, lease: f.lease, fetch: fetcher, log,
      settings: () => ({ imageGen: false }), imageMayUnload: () => [], ollamaUrl: () => undefined, push: () => {},
    });
    instances.push(recovered);
    expect(store.getThread(thread.id).messages.map(m => m.imageJob)).toEqual(["queued", "running"].map(jobId => ({
      jobId, threadId: thread.id, state: "error", errorKind: "restarted", message: "The app restarted before this image finished; try again.",
    })));
    expect(fetcher).not.toHaveBeenCalled();
    expect(log.mock.calls).toEqual([["job queued failed kind=restarted"], ["job running failed kind=restarted"]]);
  });
  it("ends a job whose lease stays busy, without spending a render budget or contacting ComfyUI", async () => {
    const f = await fixture({ queueTimeoutMs: 10 });
    const thread = f.store.createThread();
    const release = await f.lease.acquire("chat");
    const { jobId } = await f.module.generate({ prompt: "a tree", threadId: thread.id });
    try {
      await vi.waitFor(() => expect(f.store.getThread(thread.id).messages[0]).toMatchObject({ imageJob: { state: "error", errorKind: "timeout" } }), { timeout: 250 });
    } finally { f.module.cancel(jobId); release(); await f.module.wait(jobId); }
    expect(f.calls).toEqual([]);
  });
  it("persists a waiting card before returning, then updates the same card through completion", async () => {
    const f = await fixture(); const thread = f.store.createThread();
    const release = await f.lease.acquire("chat");
    const { jobId } = await f.module.generate({ prompt: "a tree", threadId: thread.id });
    expect(f.store.getThread(thread.id).messages).toMatchObject([{ id: jobId, imageJob: { state: "queued" } }]);
    release(); await f.module.wait(jobId);
    expect(f.store.getThread(thread.id).messages).toMatchObject([{ id: jobId, imageJob: { state: "done" }, images: [`images/${jobId}.png`] }]);
  });
  it("indexes a finished picture with the seed it drew and its run time, and makes its thumbnail before done", async () => {
    const seenAtThumbnail: string[] = [];
    const thumbnail = vi.fn(async (_jobId: string, _png: Buffer) => { seenAtThumbnail.push(f.events.at(-1)?.state ?? "none"); });
    const f = await fixture({ thumbnail }); const thread = f.store.createThread({ title: "trees" });
    const { jobId } = await f.module.generate({ prompt: "a tree", threadId: thread.id }); await f.module.wait(jobId);
    const sampler = Object.values(f.graphs[0]!).find((node) => typeof node.inputs["seed"] === "number" || typeof node.inputs["noise_seed"] === "number")!;
    const drawn = sampler.inputs["seed"] ?? sampler.inputs["noise_seed"];
    expect(thumbnail).toHaveBeenCalledExactlyOnceWith(jobId, png);
    expect(seenAtThumbnail).toEqual(["running"]);
    const { pictures } = f.store.pictures.list({ limit: 10 });
    // The fake's PNG has no size of its own, so the size is the one the job ran.
    const ran = f.events.at(-1)!.choice!;
    expect(pictures).toEqual([{
      jobId, threadId: thread.id, threadTitle: "trees", prompt: "a tree", preset: ran.preset, width: ran.width, height: ran.height,
      seed: drawn, steps: sampler.inputs["steps"], queuedAt: expect.any(Number), doneAt: expect.any(Number), runMs: expect.any(Number), bytes: png.length, imagePath: `images/${jobId}.png`,
    }]);
    expect(typeof drawn).toBe("number");
    // A thumbnail that fails leaves the picture made.
    const failing = await fixture({ thumbnail: async () => { throw new Error("encoder failed"); } }); const other = failing.store.createThread();
    const second = await failing.module.generate({ prompt: "a tree", threadId: other.id }); await failing.module.wait(second.jobId);
    expect(failing.events.at(-1)).toMatchObject({ state: "done" });
    expect(failing.store.pictures.list({ limit: 10 }).count).toBe(1);
  });
  it.each(["fit", "missing", "model", "disconnected", "timeout", "off", "cancelled", "busy", "workflow", "invalid", "save", "config"] as const)("persists the %s end state with an actionable reason", async (kind) => {
    const log = vi.fn();
    const f = await fixture({ jobTimeoutMs: kind === "timeout" ? 40 : 1000, log });
    const thread = f.store.createThread();
    if (kind === "fit") f.configure({ freeBytes: 0 });
    if (kind === "missing") f.configure({ answering: false, present: false });
    if (kind === "model") f.configure({ missingModel: true });
    if (kind === "disconnected") f.configure({ die: true });
    if (kind === "timeout") f.configure({ hold: true });
    if (kind === "busy") f.configure({ busy: true });
    if (kind === "workflow") f.configure({ noImage: true });
    if (kind === "invalid") f.configure({ invalidPng: true });
    if (kind === "save") vi.mocked(files.writeFile).mockRejectedValueOnce(new Error("No space left"));
    if (kind === "config") f.configure({ comfyUrl: "file:///bad" });
    const release = kind === "off" || kind === "cancelled" ? await f.lease.acquire("chat") : undefined;
    const { jobId } = await f.module.generate({ prompt: "a tree", threadId: thread.id });
    if (kind === "off") f.configure({ enabled: false });
    if (kind === "cancelled") f.module.cancel(jobId);
    release?.(); await f.module.wait(jobId);
    const card = f.store.getThread(thread.id).messages[0];
    expect(card).toMatchObject({ id: jobId, imageJob: { state: kind === "cancelled" ? "cancelled" : "error", message: expect.any(String), errorKind: expect.any(String) } });
    expect(card?.images).toBeUndefined();
    expect(log).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/^job [\w-]+ failed kind=[\w-]+$/));
  });
  it("reports off, missing and stopped without starting anything", async () => {
    const f = await fixture();
    f.configure({ enabled: false }); expect((await f.module.status()).state).toBe("off");
    const off = await f.module.generate({ prompt: "a tree" }); await f.module.wait(off.jobId);
    expect(f.events.at(-1)).toMatchObject({ state: "error", errorKind: "image-off" });
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
  it.each(["inactive", "failed"])("starts a stopped %s unit and stops it at idle only while MainPID matches", async (activeState) => {
    const f = await fixture(); f.configure({ answering: false, activeState });
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
    expect(await (await f.ps()).json()).toEqual({ models: [{ name: "foreign-chat" }, { name: "app-chat" }] });
    const first = await f.module.generate({ prompt: "a tree" }); await f.module.wait(first.jobId);
    expect(f.events.at(-1)?.state).toBe("done"); expect(f.calls.filter((c) => c === "/api/generate")).toHaveLength(1);
    expect(f.ollamaPosts).toEqual([{ model: "app-chat", keep_alive: 0 }]);
    f.configure({ freeBytes: 100 }); const next = await f.module.generate({ prompt: "a tree" }); await f.module.wait(next.jobId);
    expect(f.events.at(-1)).toMatchObject({ state: "error", errorKind: "wont-fit" });
    expect(f.module.current().detail).toMatch(/needs 0.0 GiB, 0.0 GiB free, 0.0 GiB short.*whisper.*other-app/);
    expect(f.lease.status().holder).toBeNull();
  });
  it("the swap waits for the memory: reads that still show the old number after the unload do not refuse", async () => {
    let unloaded = false, after = 0;
    const f = await fixture({ swapWaitMs: 5000, swapPollMs: 1, onModelUnloaded: () => { unloaded = true; }, readGpu: async () => {
      if (unloaded) after++;
      return { freeBytes: unloaded && after > 4 ? 20_000 : 5000, holders: "ollama", tenants: [] };
    } });
    f.choose({ preset: "z-image-int8", width: 1024, height: 1024 }); // saved: the fit runs first, ComfyUI after it
    const { jobId } = await f.module.generate({ prompt: "a tree" }); await f.module.wait(jobId);
    expect(f.ollamaPosts).toEqual([{ model: "app-chat", keep_alive: 0 }]);
    expect(f.events.at(-1)?.state).toBe("done");
    expect(after).toBeGreaterThan(4);
    // "Freeing memory" is said while the unload and the wait run, and only then: the wait's own
    // event ends it, before ComfyUI's start and the model load, not the render's first progress
    const running = f.events.filter((e) => e.state === "running");
    const freeing = running.findIndex((e) => e.phase === "freeing");
    expect(running.map((e) => e.phase ?? "making").slice(0, freeing + 1)).toEqual(["making", "freeing"]);
    expect(running[freeing + 1]).toEqual(expect.objectContaining({ progress: 0 }));
    expect(running[freeing + 1]).not.toHaveProperty("phase");
    expect(running.slice(freeing + 1).map((e) => e.phase)).not.toContain("freeing");
    expect(f.events.at(-1)).not.toHaveProperty("phase");
  });
  it("a reading after the unload that cannot be right (negative free) ends in the error alone, with no freeing-ended event before it", async () => {
    // ComfyUI's credit covers the need on that reading, so the fit alone would say it fits
    const f: Awaited<ReturnType<typeof fixture>> = await fixture({ swapWaitMs: 50, swapPollMs: 1, onModelUnloaded: () => f.configure({ freeBytes: -1, resident: 20_000 }) });
    f.configure({ freeBytes: 5000 });
    const { jobId } = await f.module.generate({ prompt: "a tree" }); await f.module.wait(jobId);
    expect(f.ollamaPosts).toEqual([{ model: "app-chat", keep_alive: 0 }]);
    expect(f.events.at(-1)).toMatchObject({ state: "error" });
    expect(f.module.current().detail).toContain("could not be measured after unloading");
    const running = f.events.filter((e) => e.state === "running");
    expect(running.at(-1), "the last running event is the freeing step; the error ends it").toMatchObject({ phase: "freeing" });
  });
  it("memory back at exactly the need after the unload: made at once, no wait for the bound", async () => {
    let unloaded = false, after = 0;
    const f = await fixture({ swapWaitMs: 5000, swapPollMs: 1, onModelUnloaded: () => { unloaded = true; }, readGpu: async () => {
      if (unloaded) after++;
      return { freeBytes: unloaded ? 10_000 : 5000, holders: "ollama", tenants: [] }; // requiredBytes is 10_000
    } });
    const started = Date.now();
    const { jobId } = await f.module.generate({ prompt: "a tree" }); await f.module.wait(jobId);
    expect(f.events.at(-1)?.state).toBe("done");
    expect(Date.now() - started).toBeLessThan(2000);
    expect(after, "one read after the unload, then the second fit's").toBeLessThanOrEqual(2);
  });
  it("the swap refuses when the memory never comes back: after the bound, not before, and not hung", async () => {
    let unloadedAt = 0, reads = 0;
    const f = await fixture({ swapWaitMs: 300, swapPollMs: 20, onModelUnloaded: () => { unloadedAt = Date.now(); reads = 0; },
      readGpu: async () => { reads++; return { freeBytes: 5000, holders: "ollama", tenants: [] }; } });
    const { jobId } = await f.module.generate({ prompt: "a tree" }); await f.module.wait(jobId);
    const waited = Date.now() - unloadedAt;
    expect(f.events.at(-1)).toMatchObject({ state: "error", errorKind: "wont-fit" });
    expect(f.events.at(-1)).not.toHaveProperty("phase");
    expect(waited).toBeGreaterThanOrEqual(300);
    expect(waited).toBeLessThan(3000);
    expect(reads).toBeGreaterThan(3);
  });
  describe("a refusal says what is true, in one sentence from the measured holders", () => {
    const gib = 1024 ** 3;
    /** `listed`: what Ollama's /api/ps lists after the wait ("down": it cannot be read). 3.5 GiB free fits no setup: none offered. */
    const refuse = async (options: Partial<ImageDeps>, listed: string[] | "down" = ["foreign-chat", "app-chat"]) => {
      const f = await fixture({ requiredBytes: 9 * gib, ...options });
      f.ollamaLists(listed === "down" ? undefined : listed);
      const { jobId } = await f.module.generate({ prompt: "a tree" }); await f.module.wait(jobId);
      expect(f.events.at(-1)).toMatchObject({ state: "error", errorKind: "wont-fit" });
      return { f, said: f.events.at(-1)?.message ?? "" };
    };
    it("this app's chat model still holding the memory: names it and never says to close another app", async () => {
      const { f, said } = await refuse({ readGpu: async () => ({ freeBytes: 3.5 * gib, holders: "ollama; whisper", tenants: [
        { pid: 7, label: "whisper-server", role: "whisper", usedBytes: 2 * gib }, { pid: 8, label: "ollama", role: "ollama", usedBytes: 8.3 * gib }] }) });
      expect(said).toBe("The image needs 9.0 GiB and 3.5 GiB is free; this app's chat model app-chat still holds 8.3 GiB, try again in a moment.");
      expect(said).not.toMatch(/close/i);
      expect(f.module.current().detail, "the long form stays in the status").toContain("Memory holders: ollama; whisper");
    });
    it("another app holding the most: names it and says to close it", async () => {
      const { said } = await refuse({ imageMayUnload: () => [], readGpu: async () => ({ freeBytes: 3.5 * gib, holders: "media-vault", tenants: [
        { pid: 8, label: "ollama", role: "ollama", usedBytes: 1 * gib }, { pid: 9, label: "media-vault vision runtime", role: "occupant", usedBytes: 6 * gib }] }) });
      expect(said).toBe("The image needs 9.0 GiB and 3.5 GiB is free; media-vault vision runtime holds 6.0 GiB, close it.");
    });
    it("a chat model this app never used holding the most: says so, not that it is this app's", async () => {
      const { said } = await refuse({ imageMayUnload: () => [], readGpu: async () => ({ freeBytes: 3.5 * gib, holders: "ollama", tenants: [
        { pid: 8, label: "ollama", role: "ollama", usedBytes: 7 * gib }] }) });
      expect(said).toBe("The image needs 9.0 GiB and 3.5 GiB is free; a chat model this app did not load holds 7.0 GiB, stop it.");
    });
    it("ComfyUI's own memory is credited, never named as the holder", async () => {
      const { said } = await refuse({ imageMayUnload: () => [], readGpu: async () => ({ freeBytes: 1 * gib, holders: "ComfyUI", tenants: [
        { pid: 42, label: "python3", role: "occupant", usedBytes: 2 * gib }, { pid: 9, label: "steam", role: "occupant", usedBytes: 3 * gib }] }) });
      expect(said).toBe("The image needs 7.0 GiB and 1.0 GiB is free; steam holds 3.0 GiB, close it.");
    });
    // The app loaded app-chat and unloaded it for this job; it is gone from Ollama's list, and what holds the rest is not it.
    const gone = (top: GpuHolder) => refuse({ readGpu: async () => ({ freeBytes: 3.5 * gib, holders: "rest", tenants: [top] }) }, ["foreign-chat"]);
    it("this app's model unloaded and gone, another Ollama model holding the rest: not called this app's, waiting not offered", async () => {
      const { f, said } = await gone({ pid: 8, label: "ollama", role: "ollama", usedBytes: 7 * gib });
      expect(f.ollamaPosts, "app-chat was unloaded").toEqual([{ model: "app-chat", keep_alive: 0 }]);
      expect(said).toBe("The image needs 9.0 GiB and 3.5 GiB is free; a chat model this app did not load holds 7.0 GiB, stop it.");
    });
    it("this app's model unloaded and gone, another app holding the rest: names that app", async () => {
      const { said } = await gone({ pid: 9, label: "steam", role: "occupant", usedBytes: 7 * gib });
      expect(said).toBe("The image needs 9.0 GiB and 3.5 GiB is free; steam holds 7.0 GiB, close it.");
    });
    it("this app's model still listed but another app holding the most: names that app, not this app's model", async () => {
      const { said } = await refuse({ readGpu: async () => ({ freeBytes: 3.5 * gib, holders: "rest", tenants: [
        { pid: 8, label: "ollama", role: "ollama", usedBytes: 2 * gib }, { pid: 9, label: "steam", role: "occupant", usedBytes: 7 * gib }] }) });
      expect(said).toBe("The image needs 9.0 GiB and 3.5 GiB is free; steam holds 7.0 GiB, close it.");
    });
    it("Ollama's list unreadable: names Ollama and claims nothing about whose model it is", async () => {
      const { said } = await refuse({ readGpu: async () => ({ freeBytes: 3.5 * gib, holders: "ollama", tenants: [{ pid: 8, label: "ollama", role: "ollama", usedBytes: 7 * gib }] }) }, "down");
      expect(said).toBe("The image needs 9.0 GiB and 3.5 GiB is free; Ollama holds 7.0 GiB.");
    });
  });
  describe("a refusal offers a way out only when one exists, from the picker's own list", () => {
    const gib = 1024 ** 3;
    const refused = async (choice: ImageChoice, freeBytes: number) => {
      const f = await fixture({ requiredBytes: undefined, imageMayUnload: () => [],
        readGpu: async () => ({ freeBytes, holders: "steam", tenants: [{ pid: 9, label: "steam", role: "occupant", usedBytes: 5 * gib }] }) });
      f.files({ flux: true }); f.choose(choice);
      expect((await f.module.presets()).presets.map((p) => p.id), "the list the picker shows").toEqual([...PRESETS, ...cellsFor("16")].map((p) => p.id));
      const { jobId } = await f.module.generate({ prompt: "a tree" }); await f.module.wait(jobId);
      expect(f.events.at(-1)).toMatchObject({ state: "error", errorKind: "wont-fit" });
      return f.events.at(-1)?.message;
    };
    it("Klein refused where its compact setup fits: names it, once", async () => {
      expect(await refused({ preset: "flux2-klein-4b", width: 1024, height: 768 }, 7.5 * gib))
        .toBe("The image needs 8.0 GiB and 7.5 GiB is free; steam holds 5.0 GiB, close it; FLUX.2 Klein 4B compact 1024×1024 would fit.");
    });
    it("Klein refused where every smaller setup needs more than is free: offers nothing", async () => {
      expect(await refused({ preset: "flux2-klein-4b", width: 1024, height: 1024 }, 3 * gib))
        .toBe("The image needs 8.0 GiB and 3.0 GiB is free; steam holds 5.0 GiB, close it.");
    });
    it("Klein refused with free memory exactly the compact setup's need: offers it", async () => {
      expect(await refused({ preset: "flux2-klein-4b", width: 1024, height: 1024 }, 4 * gib))
        .toBe("The image needs 8.0 GiB and 4.0 GiB is free; steam holds 5.0 GiB, close it; FLUX.2 Klein 4B compact 1024×1024 would fit.");
    });
    it("the smallest setup refused: says what holds the memory and nothing about size", async () => {
      expect(await refused({ preset: "moss-image", width: 1024, height: 1024 }, 3 * gib))
        .toBe("The image needs 4.0 GiB and 3.0 GiB is free; steam holds 5.0 GiB, close it.");
    });
  });
  describe("an unset default settles before the first fit, on the files ComfyUI lists", () => {
    const gib = 1024 ** 3;
    it("list never read, Klein absent, Z-Image int8 fits beside the chat model: read first, fitted on its need, nothing unloaded", async () => {
      const f = await fixture({ requiredBytes: undefined, readGpu: async () => ({ freeBytes: 9.5 * gib, holders: "ollama", tenants: [chat(3 * gib)] }) });
      const thread = f.store.createThread();
      const { jobId } = await f.module.generate({ prompt: "a tree", threadId: thread.id, choice: DEFAULT_CHOICE });
      await f.module.wait(jobId);
      expect(f.events.at(-1)?.state).toBe("done");
      expect(f.ollamaPosts, "nothing unloaded").toEqual([]);
      expect(f.events.map((e) => e.phase), "no freeing step").not.toContain("freeing");
      expect(Object.values(f.graphs[0]!).map((n) => n.class_type)).toContain("ModelSamplingAuraFlow");
      // the card ran Z-Image and keeps the shape it was first drawn with
      expect(f.store.getThread(thread.id).messages[0]?.imageJob).toMatchObject({ state: "done", choice: { preset: "z-image-int8", width: 1024, height: 1024 }, sent: DEFAULT_CHOICE });
      expect(f.events[0]).toMatchObject({ state: "queued", choice: DEFAULT_CHOICE });
      expect(f.events[0]).not.toHaveProperty("sent");
    });
  });
  describe("the fit's edges, the same table the picker's mark is tested on (contracts imageFitEdges)", () => {
    it.each(imageFitEdges)("$name: $verdict", async ({ estimateBytes, freeBytes, creditedBytes, freeableBytes = 0, verdict }) => {
      let unloaded = false;
      const f = await fixture({ requiredBytes: estimateBytes, swapWaitMs: 30, swapPollMs: 1,
        imageMayUnload: () => freeableBytes > 0 ? ["app-chat"] : [], onModelUnloaded: () => { unloaded = true; },
        readGpu: async () => ({ freeBytes: freeBytes + (unloaded ? freeableBytes : 0), holders: "ollama", tenants: [] }) });
      f.configure({ resident: creditedBytes }); // ComfyUI's own memory, read from its stats
      const { jobId } = await f.module.generate({ prompt: "a tree" }); await f.module.wait(jobId);
      const answer = f.events.at(-1)?.errorKind === "wont-fit" ? "refuse" : f.ollamaPosts.length > 0 ? "frees" : "fits";
      expect(answer).toBe(verdict);
      if (verdict !== "refuse") expect(f.events.at(-1)?.state).toBe("done");
    });
  });
  describe("side by side when both fit, against the preset's own need (size.bytes)", () => {
    const gib = 1024 ** 3;
    const { size } = resolveChoice(DEFAULT_CHOICE);
    it("a small chat model stays loaded: free memory exactly the need makes the image beside it", async () => {
      const f = await fixture({ requiredBytes: undefined, readGpu: async () => ({ freeBytes: size.bytes, holders: "ollama", tenants: [chat(3 * gib)] }) });
      f.files({ flux: true }); // Klein's files listed: the default stays Klein, at Klein's need
      const { jobId } = await f.module.generate({ prompt: "a tree" }); await f.module.wait(jobId);
      expect(f.events.at(-1)?.state).toBe("done");
      expect(f.ollamaPosts, "nothing unloaded").toEqual([]);
      expect(f.events.map((e) => e.phase)).not.toContain("freeing");
    });
    it("a large chat model is unloaded first: a byte short of the need swaps, then the image is made", async () => {
      let unloaded = false;
      const f = await fixture({ requiredBytes: undefined, onModelUnloaded: () => { unloaded = true; },
        readGpu: async () => unloaded ? { freeBytes: size.bytes + 11 * gib, holders: "", tenants: [] } : { freeBytes: size.bytes - 1, holders: "ollama", tenants: [chat(11 * gib)] } });
      f.files({ flux: true });
      const { jobId } = await f.module.generate({ prompt: "a tree" }); await f.module.wait(jobId);
      expect(f.ollamaPosts).toEqual([{ model: "app-chat", keep_alive: 0 }]);
      expect(f.events.at(-1)?.state).toBe("done");
    });
    it("send, image, send again: the image unloads the chat model and the second send loads it and answers", async () => {
      const fake = await startFakeOllama({ scenario: "threads", options: { firstTokenDelayMs: 0, tokenDelayMs: 0 } });
      instances.push({ close: () => fake.close() });
      const MODEL = "qwen3.5:9b";
      const pushes: ModelLoad[] = [];
      const loader = createModelLoader({ baseUrl: () => fake.url, push: (load) => pushes.push(load), listLoaded: (url) => listLoaded(url),
        fit: async (_model, numCtx) => ({ verdict: "fits", numCtx }) as FitReport });
      const send = async (prompt: string) => {
        const turn = loader.reserve(MODEL);
        await turn.admit(16384);
        const response = await fetch(`${fake.url}/api/chat`, { method: "POST", body: JSON.stringify({ model: MODEL, options: { num_ctx: 16384 }, messages: [{ role: "user", content: prompt }], stream: true }) });
        const text = await response.text();
        turn.firstToken(); turn.end();
        return text.split("\n").filter(Boolean).map((line) => (JSON.parse(line) as { message?: { content?: string } }).message?.content ?? "").join("");
      };
      expect(await send("first")).not.toBe("");
      expect(loader.appLoadedModels()).toEqual([MODEL]);
      // The GPU as the fake Ollama holds it: with the chat model resident the image does not fit
      const resident = () => fake.state().loaded.length > 0;
      const f = await fixture({ requiredBytes: undefined, ollamaUrl: () => fake.url, imageMayUnload: () => loader.imageMayUnload(),
        onModelUnloaded: (model) => loader.unloaded(model),
        readGpu: async () => ({ freeBytes: resident() ? size.bytes - gib : size.bytes + 6 * gib, holders: "ollama", tenants: resident() ? [chat(7 * gib)] : [] }) }, fake.url);
      f.files({ flux: true });
      const { jobId } = await f.module.generate({ prompt: "a tree" }); await f.module.wait(jobId);
      expect(f.events.at(-1)?.state).toBe("done");
      expect(f.ollamaPosts).toEqual([{ model: MODEL, keep_alive: 0 }]);
      expect(fake.state().loaded).toEqual([]);
      expect(loader.appLoadedModels()).toEqual([]);
      const loadsBefore = fake.state().loads.length;
      const pushed = pushes.length;
      expect(await send("second")).not.toBe("");
      expect(fake.state().loads.length, "the second send loads the model again").toBe(loadsBefore + 1);
      expect(pushes.slice(pushed).map((p) => p.state)).toEqual(["loading", "ready"]);
      expect(loader.appLoadedModels()).toEqual([MODEL]);
    });
    /**
     * The owner's restart: the chat model stayed in Ollama, so the app's loader never loaded it.
     * `turns` chat turns of this app run on it, then an image needs its memory.
     */
    async function warmModel(turns: number) {
      const fake = await startFakeOllama({ scenario: "threads", options: { firstTokenDelayMs: 0, tokenDelayMs: 0 } });
      instances.push({ close: () => fake.close() });
      const MODEL = "qwen3.5:9b";
      // Resident before the app's first read: another load put it there.
      await (await fetch(`${fake.url}/api/generate`, { method: "POST", body: JSON.stringify({ model: MODEL, prompt: "", stream: false, options: { num_ctx: 16384 } }) })).text();
      expect(fake.state().loaded.map((l) => l.name)).toEqual([MODEL]);
      const loader = createModelLoader({ baseUrl: () => fake.url, push: () => {}, listLoaded: (url) => listLoaded(url),
        fit: async (_model, numCtx) => ({ verdict: "fits", numCtx }) as FitReport });
      for (let i = 0; i < turns; i++) {
        const turn = loader.reserve(MODEL);
        await turn.admit(16384);
        const response = await fetch(`${fake.url}/api/chat`, { method: "POST", body: JSON.stringify({ model: MODEL, options: { num_ctx: 16384 }, messages: [{ role: "user", content: "hi" }], stream: true }) });
        await response.text();
        turn.firstToken(); turn.end();
      }
      expect(loader.appLoadedModels(), "warm: the loader never loaded it").toEqual([]);
      const resident = () => fake.state().loaded.length > 0;
      const f = await fixture({ requiredBytes: undefined, ollamaUrl: () => fake.url, imageMayUnload: () => loader.imageMayUnload(),
        onModelUnloaded: (model) => loader.unloaded(model),
        readGpu: async () => ({ freeBytes: resident() ? size.bytes - gib : size.bytes + 6 * gib, holders: "ollama", tenants: resident() ? [chat(7 * gib)] : [] }) }, fake.url);
      f.files({ flux: true });
      const { jobId } = await f.module.generate({ prompt: "a tree" }); await f.module.wait(jobId);
      return { f, fake, loader, MODEL };
    }
    it("a model warm before the app started, one chat turn on it, then an image: the image unloads it and is made", async () => {
      const { f, fake, loader, MODEL } = await warmModel(1);
      expect(f.events.at(-1)?.state).toBe("done");
      expect(f.ollamaPosts).toEqual([{ model: MODEL, keep_alive: 0 }]);
      expect(fake.state().loaded).toEqual([]);
      expect(await loader.imageMayUnload(), "unloaded: no longer the app's to unload").toEqual([]);
    });
    it("the same warm model with no turn of this app is another program's: left loaded, and the refusal says so", async () => {
      const { f, fake, MODEL } = await warmModel(0);
      expect(f.events.at(-1)).toMatchObject({ state: "error", errorKind: "wont-fit" });
      expect(f.events.at(-1)?.message).toContain("a chat model this app did not load holds 7.0 GiB, stop it");
      expect(f.ollamaPosts, "nothing unloaded").toEqual([]);
      expect(fake.state().loaded.map((l) => l.name)).toEqual([MODEL]);
    });
  });
  it("with no reader injected, the fit runs the nvidia-smi it is given (the e2e stack's fake), not the real one", async () => {
    const asked: string[] = [];
    const runNvidiaSmi = async (args: readonly string[]) => {
      asked.push(args[0] ?? "");
      return args[0]?.startsWith("--query-gpu") ? "16303, 4000, 12303\n" : "2101, /usr/local/bin/whisper-server, 2150\n";
    };
    const f = await fixture({ readGpu: undefined, runNvidiaSmi });
    const { jobId } = await f.module.generate({ prompt: "a tree" }); await f.module.wait(jobId);
    expect(f.events.at(-1)?.state).toBe("done");
    expect(asked.some((a) => a.startsWith("--query-gpu"))).toBe(true);
  });
  it("a cancel ends the swap's wait at once", async () => {
    let unloaded = false;
    const f = await fixture({ swapWaitMs: 60_000, swapPollMs: 20, onModelUnloaded: () => { unloaded = true; },
      readGpu: async () => ({ freeBytes: 5000, holders: "ollama", tenants: [] }) });
    const { jobId } = await f.module.generate({ prompt: "a tree" });
    await vi.waitFor(() => expect(unloaded).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const at = Date.now();
    expect(f.module.cancel(jobId)).toEqual({ cancelled: true }); await f.module.wait(jobId);
    expect(Date.now() - at).toBeLessThan(1000);
    expect(f.events.at(-1)?.state).toBe("cancelled");
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
    expect(f.events.at(-1)).toMatchObject({ errorKind: "image-disconnected", message: expect.stringContaining("ComfyUI disconnected") });
    expect(f.module.current().detail).toMatch(/offline/);
    expect(f.module.current().detail).not.toMatch(/may still be running/); expect(f.module.current().owner).toBe("none");
    f.configure({ die: false, answering: true, missingModel: true }); const second = await f.module.generate({ prompt: "a tree" }); await f.module.wait(second.jobId);
    // no preset's files at all: the card names the first default's first file
    expect(f.events.at(-1)).toMatchObject({ errorKind: "image-model", message: "Install flux-2-klein-4b-fp8.safetensors in ComfyUI, then try again." });
    expect(f.module.current().detail).toMatch(/flux-2-klein-4b-fp8.*install/i);
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

  it.each(["unit-pid", "system-stats", "unknown-pid"])("credits a warm external Comfy on the second image without unloading chat (%s)", async (source) => {
    const gib = 1024 ** 3;
    let free = 10 * gib;
    // unknown-pid: the unit has no MainPID; a stray pid-0 row of 1 byte must not stand in for ComfyUI's /system_stats reservation.
    const f = await fixture({ requiredBytes: 9 * gib, ...(source === "unknown-pid" ? { readGpu: async () => ({ freeBytes: free, holders: "ComfyUI", tenants: [{ pid: 0, usedBytes: 1 }] }) } : {}) });
    f.configure({ freeBytes: 10 * gib });
    if (source === "system-stats") f.configure({ comfyUrl: "http://localhost:8188" });
    if (source === "unknown-pid") f.configure({ pid: 0 });
    const first = await f.module.generate({ prompt: "a tree" }); await f.module.wait(first.jobId);
    expect(f.events.at(-1)?.state).toBe("done");
    free = 2.5 * gib; f.configure({ freeBytes: 2.5 * gib, resident: 7.9 * gib });
    const second = await f.module.generate({ prompt: "a tree" }); await f.module.wait(second.jobId);
    expect(f.events.at(-1)?.state).toBe("done");
    expect(f.calls).not.toContain("/api/generate"); expect(f.ollamaPosts).toEqual([]);
  });

  it("uses the local unit MainPID resident bytes instead of system stats", async () => {
    const f = await fixture({ readGpu: async () => ({ freeBytes: 2500, holders: "ComfyUI; whisper", tenants: [{ pid: 42, usedBytes: 3900 }, { pid: 42, usedBytes: 4000 }, { pid: 99, usedBytes: 100_000 }] }) });
    f.configure({ resident: 0 });
    const { jobId } = await f.module.generate({ prompt: "a tree" }); await f.module.wait(jobId);
    expect(f.events.at(-1)?.state).toBe("done"); expect(f.calls).not.toContain("/api/generate");
  });

  it("never credits another GPU holder to Comfy's MainPID", async () => {
    const f = await fixture({ imageMayUnload: () => [], readGpu: async () => ({ freeBytes: 1000, holders: "ComfyUI; whisper", tenants: [{ pid: 42, usedBytes: 1000 }, { pid: 99, usedBytes: 100_000 }] }) });
    const { jobId } = await f.module.generate({ prompt: "a tree" }); await f.module.wait(jobId);
    expect(f.events.at(-1)?.state).toBe("error"); expect(f.calls).not.toContain("/prompt");
  });

  it("a cold healthy Comfy needs the full estimate and reports GiB with raw fit fields", async () => {
    const gib = 1024 ** 3;
    const f = await fixture({ requiredBytes: 9 * gib, imageMayUnload: () => [] });
    f.configure({ freeBytes: 2.4 * gib, resident: 0 });
    const { jobId } = await f.module.generate({ prompt: "a tree" }); await f.module.wait(jobId);
    expect(f.events.at(-1)).toMatchObject({ state: "error", errorKind: "wont-fit" });
    expect(f.module.current().detail).toContain("needs 9.0 GiB, 2.4 GiB free, 6.6 GiB short");
    expect(f.calls).not.toContain("/prompt");
    const error = imageFitError(9 * gib, gib, 2.4 * gib, "whisper; ComfyUI");
    expect(error).toMatchObject({ code: "wont-fit", estimatedBytes: 9 * gib, needBytes: 8 * gib, creditedBytes: gib, freeBytes: 2.4 * gib, shortfallBytes: 5.6 * gib, holders: "whisper; ComfyUI" });
    expect(error.message).toContain("credited ComfyUI resident 1.0 GiB");
  });

  it.each(["active", "activating", "deactivating", "reloading"])("generate waits for an external %s unit and never adopts it", async (activeState) => {
    const f = await fixture({ startupTimeoutMs: 0 });
    f.configure({ answering: false, activeOverride: activeState === "active", activeState });
    const discovered = await f.module.status();
    const { jobId } = await f.module.generate({ prompt: "a tree" }); await f.module.wait(jobId);
    expect(f.events.at(-1)).toMatchObject({ state: "error", errorKind: "image-missing" });
    expect(f.module.current().detail).toContain("startup timeout");
    expect(discovered).toMatchObject({ state: "starting", owner: "external" });
    await f.module.stopIdle(); expect(f.calls).not.toContain("start"); expect(f.calls).not.toContain("stop");
  });

  it("bounds cancellation at 30 seconds, releases the lease and warns about the running prompt", async () => {
    const f = await fixture(); f.configure({ hold: true, stuck: true }); vi.useFakeTimers();
    const { jobId } = await f.module.generate({ prompt: "a tree" });
    await vi.waitFor(() => expect(f.events.some((e) => e.progress === 0.5)).toBe(true));
    f.module.cancel(jobId);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(f.lease.status().holder).toBe("image");
    await vi.advanceTimersByTimeAsync(1);
    const holder = f.lease.status().holder, status = f.module.current();
    // Also let the unfixed implementation finish so a failed probe cannot hang cleanup.
    f.configure({ stuck: false }); await vi.advanceTimersByTimeAsync(200); await f.module.wait(jobId);
    expect(holder).toBeNull();
    expect(status).toMatchObject({ state: "error", detail: expect.stringMatching(/ComfyUI did not release the image job within 30 s.*may still be running/) });
    expect(f.events.at(-1)?.state).toBe("cancelled");
  });

  it("a test's address (GATES_LOCAL_COMFY_URL) with none in Settings: used, and comfyui.service is never inspected or started", async () => {
    const f = await fixture({ defaultUrl: "http://127.0.0.1:1" }); f.configure({ answering: false, activeState: "inactive" });
    expect((await f.module.status()).baseUrl).toBe("http://127.0.0.1:1");
    const { jobId } = await f.module.generate({ prompt: "a tree" }); await f.module.wait(jobId);
    expect(f.events.at(-1)?.state).not.toBe("done");
    expect(f.calls.filter((c) => c === "inspect" || c === "start" || c === "stop")).toEqual([]);
  });

  it("skips local GPU fit and service management for a remote Comfy", async () => {
    const f = await fixture(); f.configure({ comfyUrl: "http://remote-comfy:8188", gpuError: true });
    const { jobId } = await f.module.generate({ prompt: "a tree" }); await f.module.wait(jobId);
    expect(f.events.at(-1)?.state).toBe("done"); expect(f.measurements()).toBe(0);
    expect(f.calls).not.toContain("/api/generate"); expect(f.calls).not.toContain("inspect");
  });

  it.each(["127.0.0.1", "localhost", "[::1]"])("skips VRAM fit for a CPU-only loopback Comfy at %s", async (host) => {
    const f = await fixture(); f.configure({ comfyUrl: `http://${host}:8188`, cpu: true, gpuError: true });
    const { jobId } = await f.module.generate({ prompt: "a tree" }); await f.module.wait(jobId);
    expect(f.events.at(-1)?.state).toBe("done"); expect(f.measurements()).toBe(0);
    expect(f.calls).not.toContain("/api/generate"); expect(f.calls).not.toContain("inspect");
  });

  it("still refuses an unreadable loopback GPU without submitting or unloading", async () => {
    const f = await fixture(); f.configure({ gpuError: true });
    const { jobId } = await f.module.generate({ prompt: "a tree" }); await f.module.wait(jobId);
    expect(f.events.at(-1)).toMatchObject({ state: "error", errorKind: "image-fit" });
    expect(f.calls).not.toContain("/prompt"); expect(f.calls).not.toContain("/api/generate");
  });

  it("re-arms idle stop after a transient queue failure", async () => {
    const f = await fixture(); f.configure({ answering: false }); vi.useFakeTimers();
    const { jobId } = await f.module.generate({ prompt: "a tree" }); await f.module.wait(jobId);
    f.configure({ queueErrors: 1 });
    await vi.advanceTimersByTimeAsync(21); expect(f.module.current().detail).toMatch(/idle stop failed/);
    await vi.advanceTimersByTimeAsync(21); expect(f.calls).toContain("stop");
  });

  it("starts the job timeout after chat grants the lease", async () => {
    const f = await fixture({ jobTimeoutMs: 600_000 }); vi.useFakeTimers();
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      const timer = new AbortController(); setTimeout(() => timer.abort(new DOMException("Timed out", "TimeoutError")), ms); return timer.signal;
    });
    const release = await f.lease.acquire("chat");
    const { jobId } = await f.module.generate({ prompt: "a tree" });
    await vi.advanceTimersByTimeAsync(600_001);
    const waiting = f.lease.status().waiting;
    release(); await f.module.wait(jobId);
    expect(waiting).toEqual(["image"]); expect(f.events.at(-1)?.state).toBe("done");
  });

  it("times out a running image only after its full lease budget", async () => {
    const f = await fixture(); f.configure({ hold: true }); vi.useFakeTimers();
    const release = await f.lease.acquire("chat");
    const { jobId } = await f.module.generate({ prompt: "a tree" });
    await vi.advanceTimersByTimeAsync(600_001);
    const grantedAt = Date.now(); release();
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(f.events.some((e) => e.progress === 0.5)).toBe(true));
    await vi.advanceTimersByTimeAsync(grantedAt + 599_999 - Date.now());
    expect(f.lease.status().holder).toBe("image");
    await vi.advanceTimersByTimeAsync(101);
    const terminal = f.events.at(-1), holder = f.lease.status().holder;
    if (holder) { f.module.cancel(jobId); await vi.advanceTimersByTimeAsync(200); }
    await f.module.wait(jobId);
    expect(terminal).toMatchObject({ state: "error", errorKind: "timeout" });
    expect(holder).toBeNull();
  });

  it("falls back to ComfyUI's own torch reservation when its MainPID has no measured GPU row", async () => {
    const gib = 1024 ** 3;
    const f = await fixture({ requiredBytes: 9 * gib, readGpu: async () => ({ freeBytes: 2.5 * gib, holders: "ComfyUI ([N/A])", tenants: [{ pid: 42 }] }) });
    f.configure({ resident: 7.9 * gib });
    const { jobId } = await f.module.generate({ prompt: "a tree" }); await f.module.wait(jobId);
    expect(f.events.at(-1)?.state).toBe("done"); expect(f.ollamaPosts).toEqual([]);
  });

  it.each(["0.0.0.0", "127.0.0.2", "[::ffff:127.0.0.1]", "192.168.1.20", "mybox", "localhost.", "mybox.", "[::ffff:192.168.1.20]", "mybox.home.arpa", "no-such-name"])("runs the VRAM fit for a ComfyUI on this machine at %s", async (host) => {
    const f = await fixture();
    f.configure({ comfyUrl: `http://${host}:8188`, gpuError: true });
    const { jobId } = await f.module.generate({ prompt: "a tree" }); await f.module.wait(jobId);
    expect(f.events.at(-1)).toMatchObject({ state: "error", errorKind: "image-fit" });
    expect(f.measurements()).toBeGreaterThan(0); expect(f.calls).not.toContain("/prompt");
  });

  it("names local and remote hosts by address, resolving names", async () => {
    const own = ["192.168.1.20", "fe80::1"];
    const local = ["localhost", "a.localhost", "localhost.", "127.0.0.1", "127.9.9.9", "0.0.0.0", "[::]", "[::1]", "[::ffff:127.0.0.1]", "[::ffff:192.168.1.20]",
      "192.168.1.20", "[fe80::1]", "MyBox", "mybox.", "mybox.home.arpa", "split-name", "no-such-name"];
    const remote = ["192.168.1.21", "remote-comfy", "remote-comfy.", "10.0.0.5", "[::ffff:10.0.0.5]", "[2001:db8::1]", "128.0.0.1", "elsewhere"];
    for (const h of local) expect(await isLocalHost(configHostname(h), own, fakeLookup), h).toBe(true);
    for (const h of remote) expect(await isLocalHost(configHostname(h), own, fakeLookup), h).toBe(false);
  });

  it("resolves an absolute name with its trailing dot, as the HTTP request will", async () => {
    // ndots:5 with a search suffix: the absolute name is this machine, the relative one is a remote host.
    const asked: string[] = [];
    const resolver = async (name: string) => {
      asked.push(name);
      return name === "comfy.home.arpa." ? ["127.0.0.1"] : ["10.0.0.5"];
    };
    expect(await isLocalHost(configHostname("comfy.home.arpa."), ["192.168.1.20"], resolver)).toBe(true);
    expect(asked).toEqual(["comfy.home.arpa."]);
  });

  it.each(["cancel", "timeout"])("a DNS lookup that never answers ends on %s and frees the GPU lease", async (end) => {
    const f = await fixture({ lookupHost: () => new Promise<never>(() => {}), ...end === "timeout" ? { jobTimeoutMs: 10 } : {} });
    f.configure({ comfyUrl: "http://slow-dns:8188" });
    const { jobId } = await f.module.generate({ prompt: "a tree" });
    await vi.waitFor(() => expect(f.lease.status().holder).toBe("image"));
    if (end === "cancel") f.module.cancel(jobId);
    await f.module.wait(jobId);
    expect(f.events.at(-1)).toMatchObject(end === "cancel" ? { state: "cancelled" } : { state: "error", errorKind: "timeout" });
    expect(f.lease.status().holder).toBeNull();
    expect(f.measurements()).toBe(0);
  });

  it.each(["done", "error"])("leaves no job timer behind after a %s job on an external Comfy", async (end) => {
    const f = await fixture(); vi.useFakeTimers();
    if (end === "error") f.configure({ missingModel: true });
    const { jobId } = await f.module.generate({ prompt: "a tree" }); await f.module.wait(jobId);
    expect(f.events.at(-1)?.state).toBe(end); expect(vi.getTimerCount()).toBe(0);
  });

  it("remembers its own prompt stuck past the cancel deadline: refuses in its own words, and idle stop still stops the app's ComfyUI", async () => {
    const f = await fixture(); f.configure({ answering: false, hold: true, stuck: true }); vi.useFakeTimers();
    const { jobId } = await f.module.generate({ prompt: "a tree" });
    await vi.waitFor(() => expect(f.events.some((e) => e.progress === 0.5)).toBe(true));
    f.module.cancel(jobId);
    await vi.advanceTimersByTimeAsync(30_000); await f.module.wait(jobId);
    expect(f.module.current()).toMatchObject({ owner: "app", detail: expect.stringMatching(/may still be running/) });
    const next = await f.module.generate({ prompt: "a tree" }); await f.module.wait(next.jobId);
    expect(f.events.at(-1)).toMatchObject({ state: "error", errorKind: "image-busy" });
    expect(f.module.current().detail).toContain("earlier image from this app");
    await f.module.stopIdle();
    expect(f.calls).toContain("stop"); expect(f.module.current()).toMatchObject({ state: "stopped", owner: "none" });
  });

  it("keeps the app's own stuck prompt when another address's prompt also gets stuck, so idle stop still stops the app's ComfyUI", async () => {
    const f = await fixture(); f.configure({ answering: false, hold: true, stuck: true }); vi.useFakeTimers();
    const first = await f.module.generate({ prompt: "a tree" });
    await vi.waitFor(() => expect(f.events.some((e) => e.progress === 0.5)).toBe(true));
    f.module.cancel(first.jobId); await vi.advanceTimersByTimeAsync(30_000); await f.module.wait(first.jobId);
    expect(f.calls).toContain("start");
    f.configure({ comfyUrl: "http://remote-comfy:8188" });
    const second = await f.module.generate({ prompt: "a tree" });
    await vi.waitFor(() => expect(f.events.filter((e) => e.progress === 0.5)).toHaveLength(2));
    f.module.cancel(second.jobId); await vi.advanceTimersByTimeAsync(30_000); await f.module.wait(second.jobId);
    expect(f.module.current().detail).toMatch(/may still be running/);
    await f.module.stopIdle();
    expect(f.calls).toContain("stop");
  });

  it("a reclaim cancelled after its first inspection never starts the idle read and gives the image claim back at once (R5-05)", async () => {
    let up = false;
    let cancel: AbortController | undefined;
    const unit = () => ({ present: true, active: up, activeState: up ? "active" : "inactive", pid: 42 });
    let f!: Awaited<ReturnType<typeof fixture>>;
    f = await fixture({ service: {
      // When armed, the abort lands after this inspection has resolved and before stopIdle's next statement runs.
      inspect: () => {
        const read = Promise.resolve(unit());
        const c = cancel; cancel = undefined;
        if (c) queueMicrotask(() => void read.then(() => c.abort(new Error("reclaim cancelled"))));
        return read;
      },
      start: async () => { up = true; f.configure({ answering: true }); },
      stop: async () => { f.calls.push("stop"); up = false; f.configure({ answering: false }); },
    } });
    f.configure({ answering: false });
    const { jobId } = await f.module.generate({ prompt: "a tree" }); await f.module.wait(jobId);
    expect(f.module.current().owner).toBe("app");
    const before = f.calls.length;
    cancel = new AbortController();
    const signal = cancel.signal;
    await expect(f.module.stopIdle(signal)).rejects.toThrow("reclaim cancelled");
    expect(signal.aborted).toBe(true);
    expect(f.calls.slice(before)).toEqual([]);
    expect(f.lease.status()).toEqual({ holder: null, holders: 0, waiting: [] });
    expect(f.module.current().owner).toBe("app");
  });

  it("clears and unrefs the job timer once the image bytes are fetched, before the PNG is written", async () => {
    const f = await fixture({ jobTimeoutMs: 600_000 }); vi.useFakeTimers();
    const timers = vi.spyOn(globalThis, "setTimeout");
    const original = (await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")).writeFile;
    let duringWrite: { timers: number; jobTimerRef: boolean | undefined } | undefined;
    const writer = vi.spyOn(files, "writeFile").mockImplementation(async (...args) => {
      const job = timers.mock.results[timers.mock.calls.findIndex((call) => call[1] === 600_000)]?.value as NodeJS.Timeout | undefined;
      if (String(args[0]).endsWith(".pending")) duringWrite = { timers: vi.getTimerCount(), jobTimerRef: job?.hasRef() };
      await original(...args);
    });
    const { jobId } = await f.module.generate({ prompt: "a tree" }); await f.module.wait(jobId); writer.mockRestore();
    expect(f.events.at(-1)?.state).toBe("done"); expect(duringWrite).toEqual({ timers: 0, jobTimerRef: false });
  });

  it("finishes the PNG and thread attachment when cancel arrives after fetching the bytes", async () => {
    const f = await fixture(); const thread = f.store.createThread({});
    const original = (await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")).writeFile;
    let cancelResult: { cancelled: boolean } | undefined;
    const writer = vi.spyOn(files, "writeFile").mockImplementation(async (...args) => {
      await original(...args);
      if (String(args[0]).endsWith(".pending")) cancelResult = f.module.cancel(path.basename(String(args[0]), ".pending"));
    });
    const { jobId } = await f.module.generate({ prompt: "a tree", threadId: thread.id }); await f.module.wait(jobId); writer.mockRestore();
    expect(cancelResult).toEqual({ cancelled: false }); expect(f.events.at(-1)?.state).toBe("done");
    expect(await readFile(path.join(f.dataDir, "images", `${jobId}.png`))).toEqual(png);
    expect(await readdir(path.join(f.dataDir, "images"))).toEqual([`${jobId}.png`]);
    expect(f.store.getThread(thread.id).messages[0]?.images).toEqual([`images/${jobId}.png`]);
  });
});

const comfyFile = (name: string): unknown => JSON.parse(readFileSync(new URL(`../../test/comfy/${name}`, import.meta.url), "utf8"));
const presetIds = async (f: Awaited<ReturnType<typeof fixture>>) => (await f.module.presets()).presets.map((p) => p.id);
/** The Ollama runner's row as nvidia-smi lists it, holding a chat model. */
const chat = (usedBytes: number) => ({ pid: 8, label: "ollama", role: "ollama", usedBytes });

/** One unset send; the choice its card ran, and every word the job said. */
async function run(f: Awaited<ReturnType<typeof fixture>>) {
  const job = await f.module.generate({ prompt: "a tree" }); await f.module.wait(job.jobId);
  return { last: f.events.at(-1), said: f.events.map((e) => e.message ?? "").join(" ") };
}

describe("image presets (fake ComfyUI file lists)", () => {
  const ids = presetIds;
  // a 16 GB card's style cells: the MOSS-Image ones run on the fixture's MOSS files, the rest need Klein's
  const cells16 = cellsFor("16").map((c) => c.id);
  const moss16 = cellsFor("16").filter((c) => c.family === "moss").map((c) => c.id);
  const general16 = { preset: "general--r2-2a-klein-compact8", width: 896, height: 896 };

  it("each preset's button name starts with a letter no other preset's does, so no cut makes two alike", async () => {
    const f = await fixture();
    f.files({ flux: true });
    const shorts = (await f.module.presets()).presets.map((p) => p.short ?? "");
    expect(shorts).toEqual(["Klein 4B", "Compact", "Z-Image", "MOSS", "General", "Faces", "Heroes", "Retro pixel", "Sprites", "Backgrounds", "Icons", "Text", "Painterly"]);
    expect(new Set(shorts.map((s) => s.slice(0, 1).toLowerCase())).size).toBe(shorts.length);
  });

  it("lists only the presets whose every file ComfyUI reports, with estimated memory per size", async () => {
    const f = await fixture();
    const listed = await f.module.presets();
    expect(listed.presets.map((p) => p.id)).toEqual(["z-image-int8", "moss-image", ...moss16]);
    expect(moss16).toEqual(["portraits--moss-official25", "sprites--r2-1a-moss-official25", "backgrounds--r2-1b-moss-official25", "icons--r2-2a-moss-official25", "text-logos--moss-official25", "painterly--r2-2a-moss-official25"]);
    expect(listed.presets[1]).toMatchObject({ name: "MOSS-Image", family: "moss", measured: false });
    expect(listed.presets[1]!.sizes.map((s) => `${s.width}x${s.height}`)).toEqual(["1024x1024", "1024x768", "768x1024"]);
    expect(listed.presets[1]!.sizes[0]!.bytes).toBe(4 * 1024 ** 3);
    f.files({ noMoss: true });
    expect(await ids(f)).toEqual(["z-image-int8"]);
    f.configure({ missingModel: true });
    expect(await ids(f)).toEqual([]);
    f.configure({ missingModel: false }); f.files({ noMoss: false, flux: true });
    // the General group's tier setups, then the card level's style cells in the Defaults menu's order
    expect(await ids(f)).toEqual(["flux2-klein-4b", "flux2-klein-4b-compact", "z-image-int8", "moss-image", ...cells16]);
    expect(cells16.map((id) => id.split("--")[0])).toEqual(["general", "portraits", "characters", "pixel-art", "sprites", "backgrounds", "icons", "text-logos", "painterly"]);
    // Off is off: nothing is read from ComfyUI.
    f.configure({ enabled: false }); f.calls.length = 0;
    expect(await f.module.presets()).toMatchObject({ presets: [], current: { preset: { id: general16.preset } } });
    expect(f.calls).toEqual([]);
  });

  it("names what a send runs now: Settings' choice, else the default ComfyUI has, also before any file list", async () => {
    const f = await fixture();
    f.files({ noMoss: true });
    expect((await f.module.presets()).current).toMatchObject({ preset: { id: "z-image-int8", name: "Z-Image Turbo int8" }, width: 1024, height: 1024 });
    f.choose({ preset: "moss-image", width: 768, height: 1024 });
    // A choice ComfyUI cannot run today is still named: its card will say which file is missing.
    expect((await f.module.presets()).current).toMatchObject({ preset: { id: "moss-image" }, width: 768, height: 1024 });
    f.choose({ preset: "gone-in-a-later-build", width: 1, height: 1 });
    expect((await f.module.presets()).current).toMatchObject({ preset: { id: "z-image-int8" }, width: 1024, height: 1024 });
    // a choice saved by an older build that had SDXL Lightning names the default now
    f.choose({ preset: "sdxl-lightning", width: 768, height: 512 });
    expect((await f.module.presets()).current).toMatchObject({ preset: { id: "z-image-int8" }, width: 1024, height: 1024 });
    const fresh = await fixture();
    fresh.configure({ answering: false });
    expect(await fresh.module.presets()).toMatchObject({ presets: [], current: { preset: { id: general16.preset, name: "FLUX.2 Klein 4B compact general" }, width: 896, height: 896 } });
  });

  it("keeps ComfyUI's last file list while it is not running, also after a restart, and never starts it to read one", async () => {
    const f = await fixture();
    const first = await f.module.presets();
    expect(first.readAt).toEqual(expect.any(Number));
    f.configure({ answering: false }); f.calls.length = 0;
    expect(await f.module.presets()).toEqual(first);
    expect(f.calls).not.toContain("start");
    const restarted = await fixture({ dataDir: f.dataDir });
    restarted.configure({ answering: false });
    expect(await restarted.module.presets()).toEqual(first);
    const fresh = await fixture();
    fresh.configure({ answering: false });
    expect(await fresh.module.presets()).toMatchObject({ presets: [] });
    expect((await fresh.module.presets()).readAt).toBeUndefined();
  });

  it("Start ComfyUI starts the unit with no job, answers what it lists, and the idle stop still stops it", async () => {
    const f = await fixture();
    f.configure({ answering: false });
    expect((await f.module.presets()).readAt).toBeUndefined();
    const started = await f.handlers["image.start"]();
    expect(f.calls).toContain("start");
    expect(started.readAt).toEqual(expect.any(Number));
    expect(started.presets.map((p) => p.id)).toContain("moss-image");
    expect(f.module.current()).toMatchObject({ state: "ready", owner: "app" });
    await vi.waitFor(() => expect(f.calls).toContain("stop"));
    expect(f.module.current()).toMatchObject({ state: "stopped", owner: "none" });
  });

  it("Start ComfyUI says why when there is nothing to start", async () => {
    const f = await fixture();
    f.configure({ answering: false, present: false });
    await expect(f.module.start()).rejects.toThrow("ComfyUI did not answer. Install comfyui.service or set a running ComfyUI address in Settings.");
    f.configure({ enabled: false });
    await expect(f.module.start()).rejects.toThrow("Image generation is off. Turn it on in Settings first.");
    expect(f.calls).not.toContain("start");
  });

  describe("the workflows ComfyUI has", () => {
    const list = "/userdata?dir=workflows&recurse=true&split=false&full_info=false";
    // a saved copy of the app's own MOSS-Image graph, saving under another name
    const mine = structuredClone(PRESETS.find((p) => p.id === "moss-image")!.workflow) as Record<string, { inputs: Record<string, unknown> }>;
    mine["9"]!.inputs["filename_prefix"] = "mine";
    const routes = {
      "/templates/index.json": comfyFile("template-index.json"),
      "/templates/image_sdxl_simple.json": comfyFile("templates/image_sdxl_simple.json"),
      [list]: ["mine.json"],
      "/userdata/workflows%2Fmine.json": mine,
    };

    it("are listed after the app's own, kept while ComfyUI is stopped and after a restart", async () => {
      const f = await fixture();
      f.workflows(routes);
      const first = await f.module.presets();
      expect(first.presets.map((p) => p.id)).toEqual(["z-image-int8", "moss-image", ...moss16, "saved:mine.json"]);
      expect(first.presets.at(-1)).toMatchObject({ name: "mine", group: "Your workflows", family: "moss", sizes: [{ width: 1024, height: 1024 }] });
      expect(first.others?.at(-1)).toMatchObject({ id: "template:image_sdxl_simple", group: "ComfyUI templates", needs: { files: ["sd_xl_base_1.0.safetensors"] } });
      f.configure({ answering: false });
      expect(await f.module.presets()).toEqual(first);
      const restarted = await fixture({ dataDir: f.dataDir });
      restarted.configure({ answering: false });
      expect(await restarted.module.presets()).toEqual(first);
    });

    it("a list that cannot be read this time keeps the last one read; one that reads empty empties it", async () => {
      const f = await fixture();
      f.workflows(routes);
      await f.module.presets();
      f.workflows({});
      const kept = async () => { const listed = await f.module.presets(); return [...listed.presets, ...listed.others ?? []].map((p) => p.id).filter((id) => id.includes(":")); };
      expect(await kept()).toEqual(["saved:mine.json", "template:image_sdxl_simple"]);
      f.workflows({ ...routes, [list]: [] });
      expect(await kept()).toEqual(["template:image_sdxl_simple"]);
    });

    it("the files in its folders are listed in Your models, read from their headers, and kept like the rest", async () => {
      const folder = path.join(await mkdtemp(path.join(tmpdir(), "gates-image-loras-")), "loras");
      await mkdir(folder);
      // an SDXL LoRA's header (its second text encoder), and no weights
      const json = Buffer.from(JSON.stringify({ "lora_te2_text_model_encoder_layers_0_mlp_fc1.lora_down.weight": { dtype: "F16", shape: [16, 1280], data_offsets: [0, 0] } }));
      const length = Buffer.alloc(8); length.writeBigUInt64LE(BigInt(json.length));
      await writeFile(path.join(folder, "ink.safetensors"), Buffer.concat([length, json]));
      // a LoRA for a family Image mode has no setup for, named by its metadata
      const zi = Buffer.from(JSON.stringify({ __metadata__: { "modelspec.architecture": "z-image-turbo/lora" } }));
      const ziLength = Buffer.alloc(8); ziLength.writeBigUInt64LE(BigInt(zi.length));
      await writeFile(path.join(folder, "zi.safetensors"), Buffer.concat([ziLength, zi]));
      const f = await fixture();
      f.files({ loras: ["ink.safetensors", "zi.safetensors"] });
      f.workflows({ "/internal/folder_paths": { loras: [folder], checkpoints: [] } });
      const first = await f.module.presets();
      // no SDXL checkpoint in its folders: the SDXL LoRA has nothing to run on, and says so
      expect(first.others?.find((p) => p.id === "file:loras/ink.safetensors")).toMatchObject({ name: "ink style", group: "Your models", family: "sdxl", why: "A SDXL LoRA; it needs a SDXL model, and none is installed." });
      expect(first.others?.at(-1)).toMatchObject({ id: "file:loras/zi.safetensors", family: "zimage", why: expect.stringContaining("no Z-Image Turbo setup that takes a LoRA") });
      f.workflows({});
      expect(await f.module.presets()).toEqual({ ...first, readAt: expect.any(Number) });
      f.configure({ answering: false });
      const restarted = await fixture({ dataDir: f.dataDir });
      restarted.configure({ answering: false });
      const again = await restarted.module.presets();
      expect([again.presets.at(-1), again.others?.at(-1)]).toEqual([first.presets.at(-1), first.others?.at(-1)]);
      await rm(path.dirname(folder), { recursive: true, force: true });
    });

    describe("downloading the files a setup needs", () => {
      // a fake file server in this process: any address answers with a few bytes named after its file
      let version = 1;
      /** Set: a GET sends this many bytes, then waits until its request is aborted, as a real fetch's body does. */
      let holdAfter: number | undefined;
      const served: string[] = [];
      const fileServer: typeof fetch = async (input, init) => {
        const url = new URL(String(input)), name = path.basename(url.pathname);
        served.push(`${init?.method ?? "GET"} ${url.host}${url.pathname}`);
        const body = Buffer.from(`${name} v${version}`);
        const headers = { "content-length": String(body.length) };
        if (init?.method === "HEAD") return new Response(null, { headers });
        if (holdAfter === undefined) return new Response(body, { headers });
        const sent = body.subarray(0, holdAfter), signal = init?.signal;
        return new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(sent));
            signal?.addEventListener("abort", () => controller.error(signal.reason));
          },
        }), { headers });
      };
      // these fake bytes are not the files the app's records name, so most tests check pins alone
      const download = { fetch: fileServer, allow: () => true, freeBytes: async () => 10 ** 12, intervalMs: 0 };
      // a saved MOSS-Image copy with a model of the person's own: a file with no download address
      const own = structuredClone(mine);
      own["18:1"]!.inputs["unet_name"] = "my-own.safetensors";
      const withOwn = { ...routes, [list]: ["mine.json", "own.json"], "/userdata/workflows%2Fown.json": own };
      const setup = async (records: "checked" | "pins only" = "pins only", workflows: Record<string, unknown> = routes, deps: Partial<ImageDeps> = {}) => {
        const root = await mkdtemp(path.join(tmpdir(), "gates-image-models-"));
        const kinds = ["checkpoints", "loras", "diffusion_models", "text_encoders", "vae"];
        const f = await fixture({ ...deps, download: records === "checked" ? download : { ...download, records: false } });
        f.workflows({ ...workflows, "/internal/folder_paths": Object.fromEntries(kinds.map((k) => [k, [path.join(root, k), "/elsewhere/" + k]])) });
        served.length = 0; version = 1; holdAfter = undefined;
        return { f, root, done: (n: number) => vi.waitFor(() => expect(f.downloads.filter((p) => p.state !== "downloading" && p.state !== "verifying")).toHaveLength(n)) };
      };

      it("fetches each missing file into a gates-local folder inside ComfyUI's first folder of its kind", async () => {
        const { f, root, done } = await setup();
        // FLUX.2's VAE is there already (MOSS-Image loads it too): only Klein's other two are fetched
        expect(await f.module.download("flux2-klein-4b")).toEqual({ files: ["flux-2-klein-4b-fp8.safetensors", "qwen_3_4b.safetensors"] });
        await done(2);
        expect(await readFile(path.join(root, "diffusion_models", "gates-local", "flux-2-klein-4b-fp8.safetensors"), "utf8")).toBe("flux-2-klein-4b-fp8.safetensors v1");
        expect(await readFile(path.join(root, "text_encoders", "gates-local", "qwen_3_4b.safetensors"), "utf8")).toBe("qwen_3_4b.safetensors v1");
        const finished = f.downloads.filter((p) => p.state === "done");
        expect(finished.map((p) => p.name)).toEqual(["flux-2-klein-4b-fp8.safetensors", "qwen_3_4b.safetensors"]);
        for (const p of finished) expect(p.message).toBeUndefined();
        expect(served[0]).toBe("HEAD huggingface.co/black-forest-labs/FLUX.2-klein-4b-fp8/resolve/" + served[0]!.split("/resolve/")[1]);
      });

      it("a file that is not the one the app's record names is not put with ComfyUI's models, and the download stops there", async () => {
        const { f, root, done } = await setup("checked");
        await f.module.download("flux2-klein-4b");
        await done(1);
        expect(f.downloads.at(-1)).toMatchObject({ name: "flux-2-klein-4b-fp8.safetensors", state: "error", ended: true });
        expect(f.downloads.at(-1)?.message).toMatch(/^flux-2-klein-4b-fp8\.safetensors is not the file expected: its sha256 is [0-9a-f]{64}, not [0-9a-f]{64}\. It was not put with ComfyUI's models; the bytes stay in flux-2-klein-4b-fp8\.safetensors\.part\.$/);
        expect((await readdir(path.join(root, "diffusion_models", "gates-local"))).toSorted()).toEqual(["flux-2-klein-4b-fp8.safetensors.part"]);
        expect(served.filter((s) => s.includes("qwen_3_4b"))).toEqual([]);
      });

      it("pins a file's sha256 on its first download; a later one that differs is not put in place", async () => {
        const { f, root, done } = await setup();
        await f.module.download("template:image_sdxl_simple");
        await done(1);
        expect(f.downloads.at(-1)).toEqual({ preset: "template:image_sdxl_simple", file: 1, files: 1, name: "sd_xl_base_1.0.safetensors", state: "done", completedBytes: 29, totalBytes: 29, setupCompletedBytes: 29, setupTotalBytes: 29, ended: true });
        await rm(path.join(root, "checkpoints", "gates-local"), { recursive: true });
        version = 2;
        await f.module.download("template:image_sdxl_simple");
        await done(2);
        expect(f.downloads.at(-1)).toMatchObject({ state: "error", message: expect.stringMatching(/^sd_xl_base_1.0.safetensors is not the file expected: its sha256 is [0-9a-f]{64}, not [0-9a-f]{64}\./) });
        expect(await readdir(path.join(root, "checkpoints", "gates-local"))).not.toContain("sd_xl_base_1.0.safetensors");
      });

      it("refuses one ComfyUI on another computer, a file with no address, and a second download while one runs", async () => {
        const { f } = await setup("pins only", withOwn);
        f.configure({ missingModel: true });
        await expect(f.module.download("saved:own.json")).rejects.toThrow("own: my-own.safetensors has no download address. Install it in ComfyUI's model folders yourself.");
        const first = f.module.download("moss-image");
        await expect(f.module.download("flux2-klein-4b")).rejects.toThrow("A model download is already running; it finishes first.");
        await first;
        await vi.waitFor(() => expect(f.downloads.filter((p) => p.state === "done")).toHaveLength(1));
        f.configure({ comfyUrl: "http://192.0.2.5:8188" }); served.length = 0;
        await expect(f.module.download("flux2-klein-4b")).rejects.toThrow("Start ComfyUI on this computer first: downloads go into its model folders.");
        expect(served).toEqual([]);
      });

      it("says which setups it can fetch, and each push names the setup and the file's place; the last says it ended", async () => {
        const { f, done } = await setup("pins only", withOwn);
        f.files({ noMoss: true });
        const listed = await f.module.presets();
        const needs = (id: string) => listed.others?.find((p) => p.id === id)?.needs;
        expect(needs("flux2-klein-4b")).toMatchObject({ download: true });
        // a saved workflow's own file has no address: there is nothing to press
        expect(needs("saved:own.json")).toEqual({ files: ["my-own.safetensors", "qwen3.5_9b_w4a8_gptq.safetensors"] });
        await f.module.download("flux2-klein-4b");
        await done(2);
        expect(f.downloads.filter((p) => p.state === "done").map((p) => [p.preset, p.file, p.files, p.ended ?? false]))
          .toEqual([["flux2-klein-4b", 1, 2, false], ["flux2-klein-4b", 2, 2, true]]);
        await vi.waitFor(async () => expect((await f.module.presets()).download).toBeUndefined());
      });

      it("each push counts the whole setup's bytes: the files before this one, this one's so far, and every file's size", async () => {
        // the fake's files are their names and " v1"
        const [a, b] = ["flux-2-klein-4b-fp8.safetensors", "qwen_3_4b.safetensors"].map((n) => `${n} v1`.length) as [number, number];
        // with the app's records, a file not yet fetched counts at its recorded size (these fake bytes then fail its sha256)
        const checked = await setup("checked");
        await checked.f.module.download("flux2-klein-4b");
        await checked.done(1);
        expect(checked.f.downloads.find((p) => p.state === "downloading")).toMatchObject({ setupCompletedBytes: 0, setupTotalBytes: a + 8_044_982_048 });
        // with no records (the fake's own files) a size is known once its download says it: the setup's when every one is
        const { f, done } = await setup();
        await f.module.download("flux2-klein-4b");
        await done(2);
        const finished = f.downloads.filter((p) => p.state === "done");
        expect(finished.map((p) => p.setupCompletedBytes)).toEqual([undefined, a + b]);
        expect(finished.at(-1)!.setupTotalBytes).toBe(a + b);
      });

      it("a Stop pressed while the download is still being planned stops it before any file is fetched", async () => {
        const { f, done } = await setup();
        const started = f.module.download("template:image_sdxl_simple");
        expect(await f.handlers["image.stopDownload"]({ preset: "template:image_sdxl_simple" })).toEqual({ stopped: true });
        expect(await started).toEqual({ files: ["sd_xl_base_1.0.safetensors"] });
        await done(1);
        expect(f.downloads.at(-1)).toMatchObject({ state: "cancelled", ended: true, completedBytes: 0 });
        expect(served.filter((s) => s.includes("sd_xl_base"))).toEqual([]);
      });

      it("Stop ends that setup's download and keeps the part; while it runs the list carries its progress", async () => {
        const { f, root } = await setup();
        holdAfter = 5;
        await f.module.download("template:image_sdxl_simple");
        await vi.waitFor(() => expect(f.downloads.at(-1)).toMatchObject({ state: "downloading", completedBytes: 5 }));
        expect((await f.module.presets()).download).toMatchObject({ preset: "template:image_sdxl_simple", name: "sd_xl_base_1.0.safetensors", file: 1, files: 1, completedBytes: 5 });
        expect(await f.handlers["image.stopDownload"]({ preset: "flux2-klein-4b" })).toEqual({ stopped: false });
        expect(await f.handlers["image.stopDownload"]({ preset: "template:image_sdxl_simple" })).toEqual({ stopped: true });
        await vi.waitFor(() => expect(f.downloads.at(-1)).toMatchObject({ state: "cancelled", completedBytes: 5, ended: true }));
        expect(await readFile(path.join(root, "checkpoints", "gates-local", "sd_xl_base_1.0.safetensors.part"), "utf8")).toBe("sd_xl");
        await vi.waitFor(async () => expect((await f.module.presets()).download).toBeUndefined());
        holdAfter = undefined;
        expect(await f.module.download("template:image_sdxl_simple")).toEqual({ files: ["sd_xl_base_1.0.safetensors"] });
        await vi.waitFor(() => expect(f.downloads.at(-1)).toMatchObject({ state: "done", ended: true }));
      });

      it("a Download pressed as soon as Stop has ended one starts while the list is still read again, and that read leaves the new one's lock", async () => {
        // the read after a download reads the GPU too; held here, as a slow nvidia-smi holds it
        let gate: Promise<void> = Promise.resolve(), release: (() => void) | undefined;
        const { f } = await setup("pins only", routes, { gpuStatus: async () => { await gate; throw new Error("unread"); } });
        holdAfter = 5;
        await f.module.download("template:image_sdxl_simple");
        await vi.waitFor(() => expect(f.downloads.at(-1)).toMatchObject({ state: "downloading", completedBytes: 5 }));
        gate = new Promise((resolve) => { release = resolve; });
        expect(await f.handlers["image.stopDownload"]({ preset: "template:image_sdxl_simple" })).toEqual({ stopped: true });
        await vi.waitFor(() => expect(f.downloads.at(-1)).toMatchObject({ state: "cancelled", ended: true }));
        // the row says stopped and offers Download again: the press is taken, not refused as still running
        const again = f.module.download("template:image_sdxl_simple");
        release?.();
        expect(await again).toEqual({ files: ["sd_xl_base_1.0.safetensors"] });
        await vi.waitFor(() => expect(f.downloads.at(-1)).toMatchObject({ state: "downloading", completedBytes: 5 }));
        // the first download's read has ended by now; the second still holds the lock
        await expect(f.module.download("flux2-klein-4b")).rejects.toThrow("A model download is already running; it finishes first.");
        expect(await f.handlers["image.stopDownload"]({ preset: "template:image_sdxl_simple" })).toEqual({ stopped: true });
        await vi.waitFor(() => expect(f.downloads.at(-1)).toMatchObject({ state: "cancelled", ended: true }));
      });
    });

    it("a send that names one runs its graph", async () => {
      const f = await fixture();
      f.workflows(routes);
      await f.module.presets();
      const job = await f.module.generate({ prompt: "a tree", choice: { preset: "saved:mine.json", width: 1024, height: 1024 } }); await f.module.wait(job.jobId);
      expect(f.events.at(-1)).toMatchObject({ state: "done", choice: { preset: "saved:mine.json" } });
      expect(f.graphs[0]!["9"]!.inputs["filename_prefix"]).toBe("mine");
    });
  });

  it("runs the chosen preset and size: Settings' choice, or the one a call names", async () => {
    const f = await fixture();
    f.choose({ preset: "moss-image", width: 1024, height: 1024 });
    const plain = await f.module.generate({ prompt: "a tree" }); await f.module.wait(plain.jobId);
    expect(f.events.at(-1)).toMatchObject({ state: "done", choice: { preset: "moss-image", width: 1024, height: 1024 } });
    expect(Object.values(f.graphs[0]!).map((n) => n.class_type)).not.toContain("LoraLoader");
    expect(f.graphs[0]!["18:6"]!.inputs).toMatchObject({ width: 1024, height: 1024 });
    f.files({ flux: true });
    const named = await f.module.generate({ prompt: "a tree", choice: { preset: "flux2-klein-4b", width: 1024, height: 768 } }); await f.module.wait(named.jobId);
    expect(f.events.at(-1)).toMatchObject({ state: "done" });
    expect(f.graphs[1]!["1"]).toMatchObject({ class_type: "UNETLoader", inputs: { unet_name: "flux-2-klein-4b-fp8.safetensors" } });
    expect(f.graphs[1]!["9"]!.inputs).toMatchObject({ steps: 8, width: 1024, height: 768 });
    expect(f.graphs[1]!["4"]!.inputs).toMatchObject({ text: "a tree" });
  });

  it("each thread keeps the choice it sent with, a default once it has made a picture; one with none follows Settings; a retry changes nothing", async () => {
    const f = await fixture(); f.files({ flux: true });
    // pixel art is no default: a send that names it is a pick
    const pixel = { preset: "flux2-klein-4b-pixel", width: 768, height: 768 }, klein = general16;
    const a = f.store.createThread(), b = f.store.createThread(), c = f.store.createThread();
    const send = async (params: Params<"image.generate">) => { const job = await f.module.generate(params); await f.module.wait(job.jobId); return f.events.at(-1)!; };
    // A sends pixel art: A keeps it, and the thread list hears at once (not only when the image is done)
    const first = await f.module.generate({ prompt: "a", threadId: a.id, choice: pixel });
    expect(f.changed).toEqual([a.id]);
    await f.module.wait(first.jobId);
    expect(f.store.imageChoiceOf(a.id)).toEqual(pixel);
    // the last pick anywhere is Klein (Settings); A's send that names nothing (the image tool's) still runs pixel art
    f.choose(klein);
    expect(await send({ prompt: "a again", threadId: a.id })).toMatchObject({ state: "done", choice: pixel });
    expect(f.graphs.at(-1)!["15"]).toMatchObject({ class_type: "ImageQuantize" });
    // B has none of its own: it follows Settings, and keeps what it ran
    expect(await send({ prompt: "b", threadId: b.id })).toMatchObject({ state: "done", choice: klein });
    expect(f.store.imageChoiceOf(b.id)).toEqual(klein);
    // A retry runs its card's choice and leaves the thread's alone
    f.configure({ noImage: true });
    const failed = await send({ prompt: "a fails", threadId: a.id, choice: pixel });
    expect(failed).toMatchObject({ state: "error" });
    f.configure({ noImage: false });
    await send({ prompt: "a picks Klein", threadId: a.id, choice: klein });
    expect(f.store.imageChoiceOf(a.id)).toEqual(klein);
    expect(await send({ prompt: "", threadId: a.id, retryOf: failed.jobId })).toMatchObject({ state: "done", choice: pixel });
    expect(f.store.imageChoiceOf(a.id)).toEqual(klein);
    // nothing saved anywhere and a default sent: C keeps the default once it has made a picture
    f.choose(undefined);
    expect(await send({ prompt: "c", threadId: c.id, choice: klein })).toMatchObject({ state: "done", choice: klein });
    expect(f.store.imageChoiceOf(c.id)).toEqual(klein);
  });

  it("A sends the default without a pick, then B picks: A's next send runs what A ran", async () => {
    const f = await fixture(); f.files({ flux: true });
    const moss = { preset: "moss-image", width: 1024, height: 1024 }, klein = general16;
    const a = f.store.createThread(), b = f.store.createThread();
    const send = async (params: Params<"image.generate">) => { const job = await f.module.generate(params); await f.module.wait(job.jobId); return f.events.at(-1)!; };
    // the composer sends the default it shows, with nothing picked anywhere
    expect(await send({ prompt: "a", threadId: a.id, choice: klein })).toMatchObject({ state: "done", choice: klein });
    // B picks MOSS: the picker saves B's choice and the app's last pick
    f.store.setImageChoice(b.id, moss); f.choose(moss);
    expect(await send({ prompt: "b", threadId: b.id, choice: moss })).toMatchObject({ state: "done", choice: moss });
    // A's next send, from the image tool, names nothing: still Klein
    expect(await send({ prompt: "a again", threadId: a.id })).toMatchObject({ state: "done", choice: klein });
    expect(f.store.listThreads().find((t) => t.id === a.id)?.imageChoice).toEqual(klein);
    // a retry in A of an older MOSS card makes the last picture there MOSS; A still sends Klein
    f.store.saveImageJob({ jobId: "00000000-0000-4000-8000-0000000000b1", threadId: a.id, state: "error", choice: moss }, "older");
    expect(await send({ prompt: "", threadId: a.id, retryOf: "00000000-0000-4000-8000-0000000000b1" })).toMatchObject({ state: "done", choice: moss });
    expect(await send({ prompt: "a once more", threadId: a.id })).toMatchObject({ state: "done", choice: klein });
  });

  describe("a default is kept once it has made a picture, only if the thread took nothing since (IR3-60, 80)", () => {
    const moss = { preset: "moss-image", width: 1024, height: 1024 }, klein = { preset: "flux2-klein-4b", width: 1024, height: 1024 };
    const pixel = { preset: "flux2-klein-4b-pixel", width: 768, height: 768 };

    it("a pick in A while A's first default send waits survives that send's picture", async () => {
      const f = await fixture(); f.files({ flux: true });
      const a = f.store.createThread();
      const release = await f.lease.acquire("chat");
      const job = await f.module.generate({ prompt: "a", threadId: a.id, choice: general16 });
      // the user picks MOSS in A while the first picture waits: the picker saves A's choice and Settings
      f.store.setImageChoice(a.id, moss); f.choose(moss);
      release(); await f.module.wait(job.jobId);
      expect(f.events.at(-1)).toMatchObject({ state: "done", choice: general16 });
      expect(f.store.imageChoiceOf(a.id), "A's pick kept").toEqual(moss);
    });

    it("an explicit send in A while A's first default waits keeps its pin when the default settles to other files", async () => {
      const f = await fixture(); // Z-Image's and MOSS's files only: Klein, sent, settles to Z-Image int8
      const a = f.store.createThread();
      const release = await f.lease.acquire("chat");
      const first = await f.module.generate({ prompt: "a tree", threadId: a.id, choice: klein });
      // the explicit send pins at send; its own job is called off, so the fake renders one picture
      const second = await f.module.generate({ prompt: "a tree", threadId: a.id, choice: pixel });
      f.module.cancel(second.jobId); await f.module.wait(second.jobId);
      expect(f.store.imageChoiceOf(a.id)).toEqual(pixel);
      release(); await f.module.wait(first.jobId);
      expect(f.events.find((e) => e.jobId === first.jobId && e.state === "done")).toMatchObject({ choice: { preset: "z-image-int8", width: 1024, height: 1024 } });
      expect(f.store.imageChoiceOf(a.id), "the later explicit send's pin").toEqual(pixel);
    });

    // IR3-61 is on the roadmap: a failed first default keeps nothing, so A follows the app's last pick
    it("A's default send fails, B picks: A keeps nothing, so its next send settles again", async () => {
      const f = await fixture(); f.files({ flux: true });
      const a = f.store.createThread(), b = f.store.createThread();
      f.configure({ noImage: true });
      const j = await f.module.generate({ prompt: "a", threadId: a.id, choice: klein }); await f.module.wait(j.jobId);
      expect(f.events.at(-1)).toMatchObject({ state: "error" });
      f.configure({ noImage: false });
      f.store.setImageChoice(b.id, moss); f.choose(moss);
      expect(f.store.imageChoiceOf(a.id), "A after failed default").toBeUndefined();
    });

    it("a default is not kept at send; its picture keeps what it settled to and says threads.changed once", async () => {
      const f = await fixture(); // Z-Image's and MOSS's files only: Klein, sent, settles to Z-Image int8
      const a = f.store.createThread();
      const job = await f.module.generate({ prompt: "a tree", threadId: a.id, choice: klein });
      expect(f.store.imageChoiceOf(a.id), "nothing kept at send").toBeUndefined();
      const before = f.changed.length;
      await f.module.wait(job.jobId);
      const settled = { preset: "z-image-int8", width: 1024, height: 1024 };
      expect(f.events.at(-1)).toMatchObject({ state: "done", choice: settled });
      expect(f.store.imageChoiceOf(a.id), "kept as settled").toEqual(settled);
      expect(f.changed.slice(before), "one threads.changed when the default finishes").toEqual([a.id]);
    });

    it("a failed default retried to a picture: the thread's next plain send makes one (IR3-80)", async () => {
      const f = await fixture(); // Z-Image's and MOSS's files only: Klein, sent, settles to Z-Image int8
      const a = f.store.createThread();
      f.configure({ noImage: true });
      const j = await f.module.generate({ prompt: "a tree", threadId: a.id, choice: klein }); await f.module.wait(j.jobId);
      f.configure({ noImage: false });
      const r = await f.module.generate({ prompt: "x", threadId: a.id, retryOf: j.jobId }); await f.module.wait(r.jobId);
      expect(f.events.at(-1)).toMatchObject({ jobId: r.jobId, state: "done" });
      const n = await f.module.generate({ prompt: "a tree", threadId: a.id }); await f.module.wait(n.jobId);
      expect(f.events.at(-1), "next plain send").toMatchObject({ jobId: n.jobId, state: "done" });
    });

    it("two default sends in a fresh thread before the first settles: both make a picture (IR3-80)", async () => {
      const f = await fixture();
      const a = f.store.createThread();
      const release = await f.lease.acquire("chat");
      const j1 = await f.module.generate({ prompt: "a tree", threadId: a.id, choice: klein });
      const j2 = await f.module.generate({ prompt: "a tree", threadId: a.id, choice: klein });
      release(); await f.module.wait(j1.jobId); await f.module.wait(j2.jobId);
      expect(f.events.filter((e) => e.jobId === j2.jobId).at(-1), "second send").toMatchObject({ state: "done" });
      expect(f.store.imageChoiceOf(a.id), "the first settled picture's choice").toEqual({ preset: "z-image-int8", width: 1024, height: 1024 });
    });

    it("a retry of a failed Klein the thread picked is never settled to other files: its card names the file", async () => {
      const f = await fixture(); const thread = f.store.createThread();
      f.store.setImageChoice(thread.id, klein);
      const failed = await f.module.generate({ prompt: "a tree", threadId: thread.id }); await f.module.wait(failed.jobId);
      expect(f.events.at(-1)).toMatchObject({ state: "error", choice: klein });
      const retry = await f.module.generate({ prompt: "ignored", threadId: thread.id, retryOf: failed.jobId }); await f.module.wait(retry.jobId);
      expect(f.events.at(-1)).toMatchObject({ jobId: retry.jobId, state: "error", errorKind: "image-model", choice: klein });
    });
  });

  it("a thread from before this build (no saved choice) sends with its last image's model, not the app's last pick", async () => {
    const f = await fixture(); f.files({ flux: true });
    const moss = { preset: "moss-image", width: 1024, height: 1024 }, klein = { preset: "flux2-klein-4b", width: 768, height: 1024 };
    const old = f.store.createThread();
    // its last image ran Klein before threads kept a choice; an older one ran MOSS
    f.store.saveImageJob({ jobId: "00000000-0000-4000-8000-0000000000a1", threadId: old.id, state: "done", choice: moss }, "older");
    f.store.saveImageJob({ jobId: "00000000-0000-4000-8000-0000000000a2", threadId: old.id, state: "done", choice: klein }, "last");
    f.choose(moss);
    expect(f.store.imageChoiceOf(old.id)).toEqual(klein);
    expect(f.store.listThreads().find((t) => t.id === old.id)?.imageChoice).toEqual(klein);
    const job = await f.module.generate({ prompt: "again", threadId: old.id }); await f.module.wait(job.jobId);
    expect(f.events.at(-1)).toMatchObject({ state: "done", choice: klein });
  });

  describe("an unset choice runs the first default ComfyUI has every file for", () => {
    it("all files present: the card level's General cell, at 896x896 on 16 GB", async () => {
      const f = await fixture(); f.files({ flux: true });
      const { last } = await run(f);
      expect(last).toMatchObject({ state: "done", choice: general16 });
      expect(f.graphs[0]!["1"]).toMatchObject({ class_type: "UNETLoader" });
      expect(f.graphs[0]!["2"]).toMatchObject({ class_type: "CLIPLoader", inputs: { clip_name: "qwen_3_4b_fp4_flux2.safetensors" } });
    });

    it("Z-Image's files and no Klein: Z-Image int8 at 1024x1024, and nothing names Klein", async () => {
      const f = await fixture(); f.files({ noMoss: true });
      const { last, said } = await run(f);
      expect(last?.message).toBeUndefined();
      expect(last).toMatchObject({ state: "done", choice: { preset: "z-image-int8", width: 1024, height: 1024 } });
      expect(f.graphs[0]!["57:28"]).toMatchObject({ class_type: "UNETLoader" });
      expect(said).not.toMatch(/flux|klein/i);
    });

    it("the list holds the defaults whose files are there, and only those", async () => {
      const f = await fixture();
      f.configure({ missingModel: true }); // no diffusion model listed: neither Z-Image's nor MOSS's
      expect(await presetIds(f)).toEqual([]);
      f.configure({ missingModel: false });
      expect(await presetIds(f)).toEqual(["z-image-int8", "moss-image", ...moss16]);
      f.files({ noMoss: true });
      expect(await presetIds(f)).toEqual(["z-image-int8"]);
    });

    it("a saved pixel-art choice stays pixel art, with every default's files there too", async () => {
      const f = await fixture(); f.files({ flux: true });
      f.choose({ preset: "flux2-klein-4b-pixel", width: 768, height: 768 });
      const { last } = await run(f);
      expect(last).toMatchObject({ state: "done", choice: { preset: "flux2-klein-4b-pixel", width: 768, height: 768 } });
      expect(f.graphs[0]!["15"]).toMatchObject({ class_type: "ImageQuantize" });
      expect((await f.module.presets()).current).toMatchObject({ preset: { id: "flux2-klein-4b-pixel" } });
    });

    it("a default whose files went missing since the last read is passed over in the job, without a word", async () => {
      const f = await fixture(); f.files({ flux: true });
      expect((await f.module.presets()).current).toMatchObject({ preset: { id: general16.preset } });
      f.files({ flux: false });
      const { last, said } = await run(f);
      expect(last).toMatchObject({ state: "done", choice: { preset: "z-image-int8", width: 1024, height: 1024 } });
      expect(said).not.toMatch(/flux|klein/i);
    });

    it("the composer sends the default it shows: with nothing saved it settles the same way", async () => {
      const f = await fixture(); f.files({ flux: true });
      await f.module.presets();
      f.files({ flux: false });
      const job = await f.module.generate({ prompt: "a tree", choice: general16 }); await f.module.wait(job.jobId);
      expect(f.events.at(-1)).toMatchObject({ state: "done", choice: { preset: "z-image-int8", width: 1024, height: 1024 } });
      expect(f.events.map((e) => e.message ?? "").join(" ")).not.toMatch(/flux|klein/i);
    });

    it("a sent choice that is no default runs as sent, saved or not", async () => {
      const f = await fixture(); f.files({ flux: true });
      const job = await f.module.generate({ prompt: "a tree", choice: { preset: "flux2-klein-4b-pixel", width: 768, height: 768 } }); await f.module.wait(job.jobId);
      expect(f.events.at(-1)).toMatchObject({ state: "done", choice: { preset: "flux2-klein-4b-pixel", width: 768, height: 768 } });
    });

    it("a saved Klein whose files are gone is never swapped: its card names the file", async () => {
      const f = await fixture();
      f.choose({ preset: "flux2-klein-4b", width: 1024, height: 1024 });
      const job = await f.module.generate({ prompt: "a tree" }); await f.module.wait(job.jobId);
      expect(f.events.at(-1)).toMatchObject({ state: "error", errorKind: "image-model", choice: { preset: "flux2-klein-4b" } });
      expect(f.events.at(-1)?.message).toMatch(/flux-2-klein-4b-fp8/);
    });

    it("a retry of a failed default card settles again from the files ComfyUI has now", async () => {
      const f = await fixture(); const thread = f.store.createThread();
      f.configure({ missingModel: true });
      const failed = await f.module.generate({ prompt: "a tree", threadId: thread.id }); await f.module.wait(failed.jobId);
      expect(f.events.at(-1)).toMatchObject({ state: "error", choice: { preset: general16.preset } });
      f.configure({ missingModel: false });
      const retry = await f.module.generate({ prompt: "ignored", threadId: thread.id, retryOf: failed.jobId }); await f.module.wait(retry.jobId);
      expect(f.events.at(-1)).toMatchObject({ jobId: retry.jobId, state: "done", choice: { preset: "z-image-int8", width: 1024, height: 1024 } });
    });
  });

  it("refuses an unknown preset or a size it does not run at before any job, and names a missing file once", async () => {
    const f = await fixture();
    await expect(f.module.generate({ prompt: "a tree", choice: { preset: "nope", width: 768, height: 512 } })).rejects.toMatchObject({ code: "image-model" });
    await expect(f.module.generate({ prompt: "a tree", choice: { preset: "moss-image", width: 640, height: 480 } })).rejects.toMatchObject({ code: "image-model" });
    expect(f.events).toEqual([]);
    f.files({ noMoss: true });
    f.choose({ preset: "moss-image", width: 768, height: 1024 });
    const job = await f.module.generate({ prompt: "a tree" }); await f.module.wait(job.jobId);
    expect(f.events.at(-1)).toMatchObject({ state: "error", errorKind: "image-model", message: "Install qwen3.5_9b_w4a8_gptq.safetensors in ComfyUI, then try again." });
  });

  it("a retry runs its failed job's preset and size, whatever is chosen now", async () => {
    const f = await fixture(); const thread = f.store.createThread();
    f.choose({ preset: "moss-image", width: 768, height: 1024 });
    f.configure({ missingModel: true });
    const failed = await f.module.generate({ prompt: "a tree", threadId: thread.id }); await f.module.wait(failed.jobId);
    expect(f.events.at(-1)).toMatchObject({ state: "error" });
    f.configure({ missingModel: false });
    f.choose({ preset: "z-image-int8", width: 1024, height: 1024 });
    const retry = await f.module.generate({ prompt: "ignored", threadId: thread.id, retryOf: failed.jobId }); await f.module.wait(retry.jobId);
    expect(f.events.at(-1)).toMatchObject({ jobId: retry.jobId, state: "done", choice: { preset: "moss-image", width: 768, height: 1024 } });
    expect(f.graphs.at(-1)!["18:6"]!.inputs).toMatchObject({ width: 768, height: 1024 });
  });
});

it("serves only token-authorized PNGs inside images, refusing traversal and symlinks", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "gates-files-")); dirs.push(dir); await mkdir(path.join(dir, "images"));
  await writeFile(path.join(dir, "images", "job.png"), png); await writeFile(path.join(dir, "outside.png"), png);
  await symlink(path.join(dir, "outside.png"), path.join(dir, "images", "link.png"));
  const server = await startWsServer({ port: 0, token: "test-launch", allowedOrigins: [], handlers: {}, dataDir: dir }); instances.push(server);
  const base = `http://127.0.0.1:${server.port}`;
  expect((await fetch(`${base}/files/images/job.png?token=bad`)).status).toBe(401);
  const ok = await fetch(`${base}/files/images/job.png?token=test-launch`); expect(ok.status).toBe(200); expect(ok.headers.get("content-type")).toBe("image/png");
  expect(Buffer.from(await ok.arrayBuffer())).toEqual(png);
  for (const url of ["/files/images/%2e%2e%2foutside.png", "/files/images/link.png"]) expect((await fetch(`${base}${url}?token=test-launch`)).status).toBe(404);
});

const nvidia = (total: number, free = total, occupants: GpuStatus["occupants"] = []): GpuStatus => ({ vendor: "nvidia", totalBytes: total, freeBytes: free, occupants, systemMemoryAvailableBytes: 0, measuredAt: 0 });

describe("the card Image mode is judged by: each tier's row by its memory, no default under 4 GB, the CPU cell alone on the CPU", () => {
  const gib = 1024 ** 3, mib = 1024 ** 2;
  const none: GpuStatus = { vendor: "none", occupants: [], systemMemoryAvailableBytes: 0, measuredAt: 0 };

  it("is the card's memory to the nearest GB, whatever other programs hold now; 0 on the CPU; unknown when unread", () => {
    // owner ruling 2026-11-13: the measure is the card's memory, not what is free now
    const held = nvidia(16_303 * mib, 2 * gib, [
      { label: "app-chat", bytes: 2 * gib, kind: "chat-model", protected: false },
      { label: "another program", bytes: 11 * gib, kind: "other-app", protected: true },
    ]);
    expect(imageRoom(held, false)).toBe(16 * gib);
    expect(imageRoom(nvidia(8188 * mib, 0), false), "an 8 GB card reports 8188 MiB").toBe(8 * gib);
    expect(imageRoom(nvidia(12 * gib), true), "ComfyUI on the CPU").toBe(0);
    expect(imageRoom(none, undefined), "no GPU, ComfyUI not read").toBe(0);
    expect(imageRoom(none, false), "no NVIDIA GPU, but ComfyUI has another").toBeUndefined();
    expect(imageRoom({ ...none, vendor: "unreadable" }, undefined)).toBeUndefined();
    expect(imageRoom(undefined, undefined)).toBeUndefined();
  });

  it.each([
    [16, "general--r2-2a-klein-compact8", [["flux2-klein-4b", "Fast"], ["z-image-int8", "Balanced"], ["moss-image", "Best"]]],
    [8, "general--fit-8b-klein-compact8", [["flux2-klein-4b", "Fast"], ["z-image-int8", "Balanced"], ["moss-image", "Best"]]],
    [6, "general--fit-8b-klein-compact8", [["flux2-klein-4b-compact", "Fast"], ["z-image-int8", "Balanced"], ["moss-image", "Best"]]],
    [4, "general--fit-4a-klein-compact8", [["flux2-klein-4b-compact", "Fast and balanced"], ["moss-image", "Best"]]],
  ])("a %i GB card with 1 GiB free: the default is %s, and the tier rows are these", async (card, current, rows) => {
    // what is free now never moves the tier: the job's own fit check judges the moment it runs
    const f = await fixture({ gpuStatus: async () => nvidia(card * gib, gib) }); f.files({ flux: true });
    const listed = await f.module.presets();
    expect([...listed.presets, ...listed.others ?? []].filter((p) => p.tier !== undefined).map((p) => [p.id, p.tier])).toEqual(rows);
    expect(listed.current).toMatchObject({ preset: { id: current } });
    expect(listed.noGpu).toBeUndefined();
  });

  it("ComfyUI on the CPU: no tier row, the basic-PC cells, the list says it is slow, and a send with nothing picked runs the CPU General cell", async () => {
    const f = await fixture({ gpuStatus: async () => none }); f.files({ flux: true });
    f.configure({ cpu: true });
    const listed = await f.module.presets();
    expect(listed.noGpu).toBeUndefined();
    expect(listed.slow).toBe(SLOW);
    expect([...listed.presets, ...listed.others ?? []].filter((p) => p.tier !== undefined)).toEqual([]);
    expect(listed.presets.map((p) => p.id)).toEqual(["flux2-klein-4b", "flux2-klein-4b-compact", "z-image-int8", "moss-image", ...cellsFor("cpu").map((c) => c.id)]);
    const cpuGeneral = { preset: "general--cpu-klein-fp4-768-2", width: 768, height: 768 };
    expect(listed.current).toMatchObject({ preset: { id: cpuGeneral.preset }, width: 768, height: 768 });
    const { jobId } = await f.module.generate({ prompt: "a tree" }); await f.module.wait(jobId);
    expect(f.events.at(-1)).toMatchObject({ state: "done", choice: cpuGeneral });
    expect(f.graphs.at(-1)!["1"]).toMatchObject({ class_type: "UNETLoader", inputs: { weight_dtype: "fp8_e4m3fn" } });
  });

  it.each([
    ["a 3 GB card", nvidia(3 * gib), false],
  ])("%s: no tier row, the list says why, and a send with nothing picked is refused with that reason", async (_, gpu, cpu) => {
    const f = await fixture({ gpuStatus: async () => gpu }); f.files({ flux: true });
    f.configure({ cpu });
    const listed = await f.module.presets();
    // the card's size, not what is free: no "free" in it
    expect(listed.noGpu).toBe("Image mode needs a GPU with 4 GB.");
    expect([...listed.presets, ...listed.others ?? []].filter((p) => p.tier !== undefined)).toEqual([]);
    const { jobId } = await f.module.generate({ prompt: "a tree" }); await f.module.wait(jobId);
    expect(f.events.at(-1)).toMatchObject({ state: "error", errorKind: "wont-fit", message: NO_GPU });
    expect(f.calls).not.toContain("/prompt");
  });
});
