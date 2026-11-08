import { mkdtemp, readFile, readdir, symlink, writeFile, mkdir } from "node:fs/promises";
import * as files from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ImageEvent } from "@gates-local/contracts";
import { createGpuLease } from "../gpu/lease.ts";
import { openThreadStore } from "../threads/store.ts";
import { startWsServer } from "../ws/server.ts";
import { createImageModule, imageFitError, isLocalHost, type ImageDeps } from "./module.ts";
import { createImageHandlers } from "./handlers.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, writeFile: vi.fn(actual.writeFile) };
});

const png = Buffer.from("iVBORw0KGgo=", "base64");
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
afterEach(async () => { vi.restoreAllMocks(); vi.useRealTimers(); await Promise.all(instances.splice(0).map((i) => i.close())); });

async function fixture(options: Partial<ImageDeps> = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "gates-image-"));
  const lease = createGpuLease();
  const events: ImageEvent[] = [];
  const calls: string[] = [];
  let enabled = true, answering = true, present = true, pid = 42, freeBytes = 20_000;
  let hold = false, missingModel = false, die = false;
  const running = new Set<string>(); // hosts whose fake ComfyUI is running a prompt; each address has its own queue
  let swapPidOnQueue = false;
  let freeAfterStart: number | undefined;
  let activeOverride: boolean | undefined;
  let activeState: string | undefined;
  let resident = 0;
  let comfyUrl: string | undefined, cpu = false, gpuError = false, stuck = false, queueErrors = 0;
  let measurements = 0;
  const ollamaPosts: unknown[] = [];
  let fakeFetch!: typeof fetch;
  let socket: EventTarget | undefined;
  const store = openThreadStore(path.join(dataDir, "threads.sqlite"));
  instances.push({ close: async () => store.close() });
  const module = createImageModule({
    dataDir, lease, store, requiredBytes: 10_000, idleMs: 20,
    // No test reaches real DNS or this machine's real interfaces.
    localAddresses: () => ["192.168.1.20"], lookupHost: fakeLookup,
    settings: () => ({ imageGen: enabled, ...(comfyUrl ? { comfyUrl } : {}) }),
    appLoadedModels: () => ["app-chat"], ollamaUrl: () => "http://fake-ollama",
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
      if (url.host === "fake-ollama") {
        if (url.pathname === "/api/ps") return Response.json({ models: [{ name: "foreign-chat" }, { name: "app-chat" }] });
        const body: unknown = JSON.parse(String(init?.body)); ollamaPosts.push(body);
        expect(body).toEqual({ model: "app-chat", keep_alive: 0 });
        freeBytes += 6000; return Response.json({});
      }
      if (!answering) throw new Error("offline");
      if (url.pathname === "/system_stats") return Response.json({ system: { comfyui_version: "fake" }, devices: [{ type: cpu ? "cpu" : "cuda", torch_vram_total: resident }] });
      if (url.pathname === "/object_info") return Response.json({
        CheckpointLoaderSimple: { input: { required: { ckpt_name: [missingModel ? [] : ["sdxl_lightning_4step.safetensors"]] } } },
        LoraLoader: { input: { required: { lora_name: [["RW_pixelart_XL_v1.safetensors"]] } } },
      });
      if (url.pathname === "/queue") { if (queueErrors-- > 0) throw new Error("queue temporarily unavailable"); if (swapPidOnQueue) pid = 99; return Response.json({ queue_running: running.has(url.host) ? [[1, "p1"]] : [], queue_pending: [] }); }
      if (url.pathname === "/prompt") {
        running.add(url.host);
        const body = JSON.parse(String(init?.body));
        expect(body.prompt["3"].inputs.text).toBe("a tree");
        queueMicrotask(() => {
          socket?.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "progress", data: { prompt_id: "p1", value: 2, max: 4 } }) }));
          if (die) { running.delete(url.host); answering = false; socket?.dispatchEvent(new Event("close")); }
          else if (!hold) { running.delete(url.host); socket?.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "executing", data: { prompt_id: "p1", node: null } }) })); }
        });
        return Response.json({ prompt_id: "p1" });
      }
      if (url.pathname === "/history/p1") return Response.json(hold ? {} : { p1: { outputs: { "8": { images: [{ filename: "out.png", subfolder: "", type: "output" }] } } } });
      if (url.pathname === "/view") return new Response(png);
      if (url.pathname === "/interrupt") { if (!stuck) running.delete(url.host); return Response.json({}); }
      throw new Error(`unexpected ${url.pathname}`);
    },
    push: (channel, payload) => { if (channel === "image.event") events.push(payload as ImageEvent); },
    ...options,
  });
  instances.push(module);
  const handlers = createImageHandlers({ image: module });
  return { module, handlers, lease, store, events, calls, dataDir, ollamaPosts, ps: () => fakeFetch("http://fake-ollama/api/ps"), measurements: () => measurements,
    configure: (v: { enabled?: boolean; answering?: boolean; present?: boolean; pid?: number; freeBytes?: number; hold?: boolean; missingModel?: boolean; die?: boolean; swapPidOnQueue?: boolean; freeAfterStart?: number; activeOverride?: boolean; activeState?: string; resident?: number; comfyUrl?: string; cpu?: boolean; gpuError?: boolean; stuck?: boolean; queueErrors?: number }) => {
      enabled = v.enabled ?? enabled; answering = v.answering ?? answering; present = v.present ?? present;
      pid = v.pid ?? pid; freeBytes = v.freeBytes ?? freeBytes; hold = v.hold ?? hold;
      missingModel = v.missingModel ?? missingModel; die = v.die ?? die;
      swapPidOnQueue = v.swapPidOnQueue ?? swapPidOnQueue; freeAfterStart = v.freeAfterStart ?? freeAfterStart;
      activeOverride = v.activeOverride ?? activeOverride;
      activeState = v.activeState ?? activeState; resident = v.resident ?? resident;
      comfyUrl = v.comfyUrl ?? comfyUrl; cpu = v.cpu ?? cpu; gpuError = v.gpuError ?? gpuError; stuck = v.stuck ?? stuck; queueErrors = v.queueErrors ?? queueErrors;
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
    expect(f.events.at(-1)).toMatchObject({ state: "error", message: expect.stringMatching(/needs 0.0 GiB, 0.0 GiB free, 0.0 GiB short.*whisper.*other-app/) });
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
    expect(f.events.at(-1)?.message).toMatch(/ComfyUI disconnected while making the image/);
    expect(f.module.current().detail).toMatch(/offline/);
    expect(f.module.current().detail).not.toMatch(/may still be running/); expect(f.module.current().owner).toBe("none");
    f.configure({ die: false, answering: true, missingModel: true }); const second = await f.module.generate({ prompt: "a tree" }); await f.module.wait(second.jobId);
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
    const f = await fixture({ appLoadedModels: () => [], readGpu: async () => ({ freeBytes: 1000, holders: "ComfyUI; whisper", tenants: [{ pid: 42, usedBytes: 1000 }, { pid: 99, usedBytes: 100_000 }] }) });
    const { jobId } = await f.module.generate({ prompt: "a tree" }); await f.module.wait(jobId);
    expect(f.events.at(-1)?.state).toBe("error"); expect(f.calls).not.toContain("/prompt");
  });

  it("a cold healthy Comfy needs the full estimate and reports GiB with raw fit fields", async () => {
    const gib = 1024 ** 3;
    const f = await fixture({ requiredBytes: 9 * gib, appLoadedModels: () => [] });
    f.configure({ freeBytes: 2.4 * gib, resident: 0 });
    const { jobId } = await f.module.generate({ prompt: "a tree" }); await f.module.wait(jobId);
    expect(f.events.at(-1)).toMatchObject({ state: "error", message: expect.stringContaining("needs 9.0 GiB, 2.4 GiB free, 6.6 GiB short") });
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
    expect(f.events.at(-1)).toMatchObject({ state: "error", message: expect.stringContaining("startup timeout") });
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
    expect(f.events.at(-1)).toMatchObject({ state: "error", message: expect.stringContaining("nvidia-smi failed") });
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
    expect(terminal).toMatchObject({ state: "error", message: expect.stringContaining("run timeout") });
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
    expect(f.events.at(-1)).toMatchObject({ state: "error", message: expect.stringContaining("nvidia-smi failed") });
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
    const outcome = await Promise.race([f.module.wait(jobId).then(() => "ended"), new Promise((r) => setTimeout(r, 300, "stuck"))]);
    expect(outcome).toBe("ended");
    expect(f.events.at(-1)).toMatchObject(end === "cancel" ? { state: "cancelled" } : { state: "error", message: expect.stringContaining("run timeout") });
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
    expect(f.events.at(-1)).toMatchObject({ state: "error", message: expect.stringContaining("earlier image from this app") });
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
