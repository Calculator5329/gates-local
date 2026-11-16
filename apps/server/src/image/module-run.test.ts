import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GpuStatus, ImageChoice, ImageDownload, ImageEvent, ImagePresets } from "@gates-local/contracts";
import { comfyInfo, KLEIN_COMPACT_FILES, KLEIN_FILES, MOSS_FILES, SDXL_FILES, ZIMAGE_FILES, type FakeFiles } from "../../test/comfy/info.ts";
import { readGpu } from "../fit/gpu.ts";
import type { NvidiaSmiRunner } from "../fit/types.ts";
import { createGpuLease } from "../gpu/lease.ts";
import { createMemoryOwner } from "../gpu/memory.ts";
import { openThreadStore, type ThreadStore } from "../threads/store.ts";
import { createImageModule, RUN_LIMIT_MS, STUCK_HOLD_MS, STUCK_HOLD_NOTE, type ImageDeps, type ImageModule } from "./module.ts";

const png = Buffer.from("iVBORw0KGgo=", "base64");
const GIB = 1024 ** 3;
const MOSS_WIDE: ImageChoice = { preset: "moss-image", width: 1024, height: 768 };
const frame = (type: string, data: object = {}) => ({ type, data: { prompt_id: "p1", ...data } });
const NAMES: Record<string, readonly string[]> = { "mybox": ["127.0.1.1"], "remote-comfy": ["10.0.0.5"] };
const fakeLookup = async (name: string) => {
  const found = NAMES[name];
  if (!found) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${name}`), { code: "ENOTFOUND" });
  return found;
};
const nvidia = (total: number): GpuStatus => ({ vendor: "nvidia", totalBytes: total, freeBytes: total, occupants: [], systemMemoryAvailableBytes: 0, measuredAt: 0 });
const instances: { close(): Promise<void> }[] = [];
const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks(); vi.useRealTimers();
  try {
    for (const instance of instances.splice(0).toReversed()) await instance.close();
  } finally {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  }
});

const tempDir = async (prefix: string) => {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};
const openStore = (dataDir: string) => {
  const store = openThreadStore(path.join(dataDir, "threads.sqlite"));
  instances.push({ close: async () => store.close() });
  return store;
};
const settle = () => new Promise<void>((resolve) => { setTimeout(resolve, 0); });
const pause = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

async function fixture(options: Partial<ImageDeps> = {}) {
  const dataDir = await tempDir("gates-image-run-");
  const lease = createGpuLease();
  const events: ImageEvent[] = [];
  const downloads: ImageDownload[] = [];
  const presets: ImagePresets[] = [];
  const presetsWaiting: Array<() => void> = [];
  const calls: string[] = [];
  let enabled = true, answering = true, present = true, pid = 42, freeBytes = 20_000;
  let hold = false, die = false, busy = false, noImage = false, stuck = false, cpu = false, flux = false;
  let activeOverride: boolean | undefined, activeState: string | undefined, comfyUrl: string | undefined;
  let choice: ImageChoice | undefined, imageFolder: string | undefined;
  let offline = 0, interruptFails = false, lists: readonly FakeFiles[] | undefined, dropped: readonly string[] = [];
  let frames: ((graph: Record<string, { class_type: string }>) => object[]) | undefined;
  let workflowRoutes: Record<string, unknown> = {};
  let measurements = 0;
  const running = new Set<string>();
  let fakeFetch!: typeof fetch;
  let socket: EventTarget | undefined;
  const store = openStore(dataDir);
  let module!: ImageModule;
  const memory = createMemoryOwner({
    ollamaUrl: () => "http://fake-ollama",
    listLoaded: async () => [],
    replying: () => [],
    engine: () => module,
    fetch: (input, init) => fakeFetch(input, init),
    readFree: async () => freeBytes,
    waitMs: 50, pollMs: 5,
  });
  const say = (data: object) => socket?.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(data) }));
  module = createImageModule({
    dataDir, lease, store, requiredBytes: 10_000, idleMs: 20,
    log: () => {},
    localAddresses: () => ["192.168.1.20"], lookupHost: fakeLookup,
    settings: () => ({ imageGen: enabled, ...(comfyUrl ? { comfyUrl } : {}), ...(choice ? { imageChoice: choice } : {}), ...(imageFolder ? { imageFolder } : {}) }),
    memory,
    readGpu: async () => {
      measurements++; calls.push("measure");
      return { freeBytes, holders: "whisper 2000 bytes", tenants: [{ pid, usedBytes: 0 }] };
    },
    service: {
      inspect: async () => { calls.push("inspect"); return { present, active: activeOverride ?? answering, activeState: activeState ?? ((activeOverride ?? answering) ? "active" : "inactive"), pid }; },
      start: async () => { calls.push("start"); answering = true; activeState = "active"; },
      stop: async () => { calls.push("stop"); answering = false; activeState = "inactive"; running.delete("127.0.0.1:8188"); },
    },
    socket: () => {
      socket = new EventTarget();
      Object.defineProperty(socket, "readyState", { value: 1 });
      Object.assign(socket, { close() {} });
      return socket as WebSocket;
    },
    fetch: fakeFetch = async (input, init) => {
      const url = new URL(String(input)); calls.push(url.pathname);
      if (url.host === "fake-ollama") return Response.json({ models: [] });
      if (offline > 0) { offline--; throw new Error("offline"); }
      if (!answering) throw new Error("offline");
      if (url.pathname.startsWith("/internal/")) {
        const route = `${url.pathname}${url.search}`;
        return route in workflowRoutes ? Response.json(workflowRoutes[route]) : new Response("not found", { status: 404 });
      }
      if (url.pathname.startsWith("/templates/") || url.pathname.startsWith("/userdata")) return new Response("not found", { status: 404 });
      if (url.pathname === "/system_stats") return Response.json({ system: { comfyui_version: "fake" }, devices: [{ type: cpu ? "cpu" : "cuda", torch_vram_total: 0 }] });
      if (url.pathname === "/object_info") {
        const info = comfyInfo(...lists ?? [ZIMAGE_FILES, MOSS_FILES, SDXL_FILES, ...flux ? [KLEIN_FILES, KLEIN_COMPACT_FILES] : []]);
        for (const name of dropped) Reflect.deleteProperty(info, name);
        return Response.json(info);
      }
      if (url.pathname === "/queue") return Response.json({ queue_running: busy ? [[1, "foreign"]] : running.has(url.host) ? [[1, "p1"]] : [], queue_pending: [] });
      if (url.pathname === "/prompt") {
        running.add(url.host);
        if (frames !== undefined) {
          const sent = frames((JSON.parse(String(init?.body)) as { prompt: Record<string, { class_type: string }> }).prompt);
          void (async () => {
            for (const one of sent) { await new Promise((r) => setTimeout(r, 2)); say(one); }
            running.delete(url.host);
          })();
          return Response.json({ prompt_id: "p1" });
        }
        queueMicrotask(() => {
          say({ type: "progress", data: { prompt_id: "p1", value: 2, max: 4 } });
          if (die) { running.delete(url.host); answering = false; socket?.dispatchEvent(new Event("close")); }
          else if (!hold) { running.delete(url.host); say({ type: "executing", data: { prompt_id: "p1", node: null } }); }
        });
        return Response.json({ prompt_id: "p1" });
      }
      if (url.pathname === "/history/p1") return Response.json(hold ? {} : { p1: { outputs: noImage ? {} : { "8": { images: [{ filename: "out.png", subfolder: "", type: "output" }] } } } });
      if (url.pathname === "/view") return new Response(png);
      if (url.pathname === "/interrupt") {
        if (interruptFails) throw new Error("interrupt refused");
        if (!stuck) running.delete(url.host);
        return Response.json({});
      }
      if (url.pathname === "/free") return Response.json({});
      throw new Error(`unexpected ${url.pathname}`);
    },
    push: (channel, payload) => {
      if (channel === "image.event") events.push(payload as ImageEvent);
      if (channel === "image.download") downloads.push(payload as ImageDownload);
      if (channel === "image.presets") { presets.push(payload as ImagePresets); for (const sent of presetsWaiting.splice(0)) sent(); }
    },
    ...options,
  });
  instances.push(module);
  return {
    module, lease, store, memory, events, downloads, presets, calls, dataDir,
    measurements: () => measurements,
    presetsSent: async (count: number) => { while (presets.length < count) await new Promise<void>((sent) => { presetsWaiting.push(sent); }); },
    of: (jobId: string) => events.filter((e) => e.jobId === jobId),
    choose: (next: ImageChoice | undefined) => { choice = next; },
    files: (v: { flux?: boolean; lists?: readonly FakeFiles[]; dropped?: readonly string[] }) => { flux = v.flux ?? flux; lists = v.lists ?? lists; dropped = v.dropped ?? dropped; },
    pickFolder: (folder: string | undefined) => { imageFolder = folder; },
    sendFrames: (make: typeof frames) => { frames = make; },
    workflows: (routes: Record<string, unknown>) => { workflowRoutes = routes; },
    goOffline: (requests: number) => { offline = requests; },
    finish: () => { running.clear(); },
    occupy: () => { running.add("127.0.0.1:8188"); },
    configure: (v: { enabled?: boolean; answering?: boolean; present?: boolean; pid?: number; freeBytes?: number; hold?: boolean; die?: boolean; activeOverride?: boolean; activeState?: string; comfyUrl?: string; cpu?: boolean; stuck?: boolean; busy?: boolean; noImage?: boolean; interruptFails?: boolean }) => {
      enabled = v.enabled ?? enabled; answering = v.answering ?? answering; present = v.present ?? present;
      pid = v.pid ?? pid; freeBytes = v.freeBytes ?? freeBytes; hold = v.hold ?? hold; die = v.die ?? die;
      activeOverride = v.activeOverride ?? activeOverride; activeState = v.activeState ?? activeState;
      comfyUrl = v.comfyUrl ?? comfyUrl; cpu = v.cpu ?? cpu; stuck = v.stuck ?? stuck;
      busy = v.busy ?? busy; noImage = v.noImage ?? noImage; interruptFails = v.interruptFails ?? interruptFails;
    },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

const sent = async (f: Fixture, choice?: ImageChoice) => {
  const { jobId } = await f.module.generate({ prompt: "a tree", ...choice ? { choice } : {} });
  await f.module.wait(jobId);
  return f.of(jobId).at(-1);
};
const halfway = (f: Fixture, jobId: string) => vi.waitFor(() => expect(f.of(jobId).some((e) => e.progress === 0.5)).toBe(true));
const klein = (presets: ImagePresets) => presets.others?.find((p) => p.id === "flux2-klein-4b")?.needs;

describe("a picture's run, from send to the engine's stop", () => {
  it("generate hands back the job before it runs, even with the card free: the first event a caller sees is queued", async () => {
    const f = await fixture();
    const { jobId } = await f.module.generate({ prompt: "a tree", choice: MOSS_WIDE });
    expect(f.of(jobId).map((e) => e.state)).toEqual(["queued"]);
    await f.module.wait(jobId);
    expect(f.of(jobId).at(-1)).toMatchObject({ state: "done" });
  });

  it("a send into a thread deleted as it is sent still makes its picture", async () => {
    const dataDir = await tempDir("gates-image-store-");
    const real = openStore(dataDir);
    const thread = real.createThread();
    const store = new Proxy(real, {
      get(target, key, receiver) {
        if (key !== "imageChoiceOf") return Reflect.get(target, key, receiver) as unknown;
        return (threadId: string) => { const kept = target.imageChoiceOf(threadId); target.deleteThread(threadId); return kept; };
      },
    }) satisfies ThreadStore;
    const f = await fixture({ store });
    const { jobId } = await f.module.generate({ prompt: "a tree", threadId: thread.id, choice: MOSS_WIDE });
    await f.module.wait(jobId);
    expect(f.of(jobId).at(-1)).toMatchObject({ state: "done" });
  });

  it("a retry whose saved setup this build no longer has is taken, and its own card fails in words", async () => {
    const f = await fixture(); const thread = f.store.createThread();
    f.store.saveImageJob({ jobId: "old", threadId: thread.id, state: "error", choice: { preset: "flux1-dev-retired", width: 1024, height: 1024 }, message: "It failed." }, "a tree");
    const { jobId } = await f.module.generate({ prompt: "", threadId: thread.id, retryOf: "old" });
    await f.module.wait(jobId);
    expect(f.of(jobId).at(-1)).toMatchObject({ state: "error", errorKind: "image-model", message: "Pick an image model ComfyUI has, then try again." });
    expect(f.store.getThread(thread.id).messages.find((m) => m.id === jobId)?.imageJob).toMatchObject({ state: "error", errorKind: "image-model" });
  });

  it("a card stored after its sampling began keeps saying so, for a window that opens the thread later", async () => {
    const f = await fixture(); const thread = f.store.createThread();
    f.sendFrames((graph) => {
      const node = (pattern: RegExp) => Object.entries(graph).find(([, n]) => pattern.test(n.class_type))?.[0];
      return [
        frame("execution_start"), frame("executing", { node: node(/^UNETLoader/) }), frame("executing", { node: node(/Sampler/) }),
        frame("progress", { value: 1, max: 2 }), frame("executing", { node: node(/^VAELoader/) }), frame("executing", { node: node(/^VAEDecode/) }),
        frame("executing", { node: null }),
      ];
    });
    const { jobId } = await f.module.generate({ prompt: "a tree", threadId: thread.id, choice: { preset: "z-image-int8", width: 1024, height: 1024 } });
    await f.module.wait(jobId);
    expect(f.store.getThread(thread.id).messages.find((m) => m.id === jobId)?.imageJob).toMatchObject({ state: "done", sampled: true });
  });

  it("with the engine stopped, the card is measured before the engine is started", async () => {
    const f = await fixture(); f.configure({ answering: false });
    expect(await sent(f, MOSS_WIDE)).toMatchObject({ state: "done" });
    const measured = f.calls.indexOf("measure"), started = f.calls.indexOf("start");
    expect(measured).toBeGreaterThanOrEqual(0);
    expect(started).toBeGreaterThan(measured);
  });

  it("a default that settles to another setup once the engine has listed its files is the setup handed the memory", async () => {
    const f = await fixture(); f.files({ flux: true });
    await f.module.presets();
    f.files({ flux: false });
    expect(await sent(f)).toMatchObject({ state: "done", choice: { preset: "z-image-int8", width: 1024, height: 1024 } });
    expect(f.memory.status().resident).toMatchObject({ kind: "image", setup: "z-image-int8 1024x1024" });
  });

  it("a picture that failed while its setup loaded leaves the engine's memory unknown: the next one of that setup asks it to free and measures", async () => {
    const f = await fixture();
    expect(await sent(f, MOSS_WIDE)).toMatchObject({ state: "done" });
    f.configure({ noImage: true });
    const warm = f.calls.length;
    expect(await sent(f, MOSS_WIDE)).toMatchObject({ state: "error" });
    expect(f.calls.slice(warm)).not.toContain("/free");
    expect(f.memory.status().handoff).toBeUndefined();
    f.configure({ noImage: false });
    const mark = f.calls.length, measured = f.measurements();
    expect(await sent(f, MOSS_WIDE)).toMatchObject({ state: "done" });
    expect(f.calls.slice(mark)).toContain("/free");
    expect(f.measurements()).toBe(measured + 1);
  });

  it("a stopped picture whose card claim ran out: the next picture of the same setup asks the engine to free and reads the card", async () => {
    const f = await fixture();
    expect(await sent(f, MOSS_WIDE)).toMatchObject({ state: "done" });
    f.configure({ hold: true, stuck: true }); vi.useFakeTimers();
    const { jobId } = await f.module.generate({ prompt: "a tree", choice: MOSS_WIDE });
    await halfway(f, jobId);
    f.module.cancel(jobId);
    await vi.advanceTimersByTimeAsync(30_000 + STUCK_HOLD_MS + 1_000); await f.module.wait(jobId);
    expect(f.lease.status().holder).toBeNull();
    expect(f.module.current().detail).toMatch(/may still be running/);
    vi.useRealTimers();
    f.finish(); f.configure({ hold: false, stuck: false });
    const mark = f.calls.length, measured = f.measurements();
    expect(await sent(f, MOSS_WIDE)).toMatchObject({ state: "done" });
    expect(f.calls.slice(mark)).toContain("/free");
    expect(f.measurements()).toBe(measured + 1);
  });

  it("one missed answer while a stopped picture keeps the card is not an engine that went away: the card stays claimed", async () => {
    const f = await fixture(); f.configure({ hold: true, stuck: true }); vi.useFakeTimers();
    const { jobId } = await f.module.generate({ prompt: "a tree", choice: MOSS_WIDE });
    await halfway(f, jobId);
    f.module.cancel(jobId);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(f.module.current()).toMatchObject({ state: "busy", detail: STUCK_HOLD_NOTE });
    f.goOffline(2);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(f.lease.status().holder).toBe("image");
    expect(f.module.current()).toMatchObject({ state: "busy", detail: STUCK_HOLD_NOTE });
    f.configure({ stuck: false }); await vi.advanceTimersByTimeAsync(12_000); await f.module.wait(jobId);
    expect(f.of(jobId).at(-1)).toMatchObject({ state: "cancelled" });
    expect(f.lease.status().holder).toBeNull();
  });

  it("at the hold limit an engine the app started that is now another process is not stopped", async () => {
    const f = await fixture(); f.configure({ answering: false, hold: true, stuck: true }); vi.useFakeTimers();
    const { jobId } = await f.module.generate({ prompt: "a tree", choice: MOSS_WIDE });
    await halfway(f, jobId);
    expect(f.calls).toContain("start");
    f.module.cancel(jobId);
    await vi.advanceTimersByTimeAsync(31_000);
    f.configure({ pid: 99 });
    await vi.advanceTimersByTimeAsync(STUCK_HOLD_MS + 1_000); await f.module.wait(jobId);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.lease.status().holder).toBeNull();
    expect(f.calls).not.toContain("stop");
    expect(f.module.current().detail).toMatch(/may still be running/);
  });

  it("closing the app during a stopped picture's hold keeps the warning that the engine may still be running it", async () => {
    const f = await fixture(); f.configure({ hold: true, stuck: true }); vi.useFakeTimers();
    const { jobId } = await f.module.generate({ prompt: "a tree", choice: MOSS_WIDE });
    await halfway(f, jobId);
    f.module.cancel(jobId);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(f.lease.status().holder).toBe("image");
    const closed = f.module.close();
    await vi.advanceTimersByTimeAsync(100); await closed;
    expect(f.module.current()).toMatchObject({ state: "error", detail: expect.stringMatching(/may still be running/) });
  });

  it("on the processor, the wait for an earlier stuck picture is not counted against the next picture's run limit", async () => {
    const f = await fixture({ gpuStatus: async () => nvidia(16 * GIB), idleMs: 3_600_000, jobTimeoutMs: 100_000 }); f.files({ flux: true });
    f.configure({ cpu: true, hold: true, stuck: true }); vi.useFakeTimers();
    const first = await f.module.generate({ prompt: "a tree" });
    await vi.advanceTimersByTimeAsync(0);
    await halfway(f, first.jobId);
    f.module.cancel(first.jobId);
    await vi.advanceTimersByTimeAsync(1_801_000); await f.module.wait(first.jobId);
    expect(f.module.current().detail).toMatch(/may still be running/);
    f.configure({ hold: false });
    f.sendFrames(() => [frame("execution_start"), frame("progress", { value: 1, max: 2 }), frame("executing", { node: null })]);
    const next = await f.module.generate({ prompt: "a tree" });
    await vi.advanceTimersByTimeAsync(150_000);
    expect(f.of(next.jobId).at(-1)?.state).toBe("running");
    f.configure({ stuck: false });
    await vi.advanceTimersByTimeAsync(12_000);
    await f.module.wait(next.jobId);
    expect(f.of(next.jobId).at(-1)).toMatchObject({ state: "done" });
  });

  it("a picked setup sent first on a computer with no card runs under the processor's limit, not the card's", async () => {
    const f = await fixture({ gpuStatus: async () => ({ vendor: "none", occupants: [], systemMemoryAvailableBytes: 0, measuredAt: 0 }) });
    f.configure({ cpu: true, hold: true }); vi.useFakeTimers();
    const { jobId } = await f.module.generate({ prompt: "a tree", choice: MOSS_WIDE });
    await halfway(f, jobId);
    await vi.advanceTimersByTimeAsync(RUN_LIMIT_MS.card + 1_000);
    expect(f.of(jobId).at(-1)).toMatchObject({ state: "running", progress: 0.5 });
    expect(f.of(jobId).at(-1)?.phase).toBeUndefined();
    f.module.cancel(jobId); await vi.advanceTimersByTimeAsync(1_000); await f.module.wait(jobId);
    expect(f.of(jobId).at(-1)).toMatchObject({ state: "cancelled" });
  });

  it("an engine the app could not get running says it did not start, not that none is set up", async () => {
    const f = await fixture(); f.configure({ answering: false, activeOverride: false });
    expect(await sent(f)).toMatchObject({ state: "error", errorKind: "image-missing", message: "ComfyUI did not start. Check its log, then try again." });
    expect(f.calls).toContain("start");
  });

  it("a stop whose interrupt failed is an error, but not an engine still busy with the picture", async () => {
    const f = await fixture(); f.configure({ hold: true, interruptFails: true });
    const { jobId } = await f.module.generate({ prompt: "a tree", choice: MOSS_WIDE });
    await halfway(f, jobId);
    f.module.cancel(jobId); await f.module.wait(jobId);
    expect(f.of(jobId).at(-1)).toMatchObject({ state: "cancelled" });
    expect(f.module.current()).toMatchObject({ state: "error", owner: "none", detail: expect.stringContaining("Stopping the prompt failed") });
  });

  it("a picture sent with no ComfyUI to draw with leaves the engine missing, not in error", async () => {
    const f = await fixture(); f.configure({ answering: false, present: false });
    expect(await sent(f)).toMatchObject({ state: "error", errorKind: "image-missing" });
    expect(f.module.current().state).toBe("missing");
  });

  it("start while a picture waits its turn leaves the engine to that picture", async () => {
    const f = await fixture(); f.configure({ answering: false });
    const release = await f.lease.acquire("chat");
    const { jobId } = await f.module.generate({ prompt: "a tree", choice: MOSS_WIDE });
    await f.module.start();
    expect(f.calls).not.toContain("start");
    expect(f.module.current().state).not.toBe("ready");
    release(); await f.module.wait(jobId);
    expect(f.of(jobId).at(-1)).toMatchObject({ state: "done" });
    expect(f.calls.filter((c) => c === "start")).toHaveLength(1);
  });
});

describe("the engine's idle stop", () => {
  it("a stop already under way when the reclaim is cancelled is finished, not cut short", async () => {
    let finishStop: (() => void) | undefined;
    let up = false;
    let f!: Fixture;
    f = await fixture({ idleMs: 3_600_000, service: {
      inspect: async () => ({ present: true, active: up, activeState: up ? "active" : "inactive", pid: 42 }),
      start: async () => { up = true; f.configure({ answering: true }); },
      stop: () => { f.calls.push("stop"); return new Promise<void>((resolve) => { finishStop = () => { up = false; f.configure({ answering: false }); resolve(); }; }); },
    } });
    f.configure({ answering: false });
    expect(await sent(f, MOSS_WIDE)).toMatchObject({ state: "done" });
    const cancel = new AbortController();
    let ended: string | undefined;
    const stopping = f.module.stopIdle(cancel.signal).then(() => { ended = "resolved"; }, () => { ended = "rejected"; });
    await vi.waitFor(() => expect(f.calls).toContain("stop"));
    cancel.abort(new Error("reclaim cancelled"));
    await settle();
    expect(ended).toBeUndefined();
    finishStop?.(); await stopping;
    expect(ended).toBe("resolved");
    expect(f.module.current()).toMatchObject({ state: "stopped", owner: "none" });
  });

  it("a stuck record from the engine's earlier process does not let the idle stop pass over a prompt the new process runs", async () => {
    const f = await fixture({ idleMs: 3_600_000 }); f.configure({ answering: false, hold: true, stuck: true, cpu: true }); vi.useFakeTimers();
    const { jobId } = await f.module.generate({ prompt: "a tree" });
    await halfway(f, jobId);
    f.module.cancel(jobId);
    await vi.advanceTimersByTimeAsync(30_000); await f.module.wait(jobId);
    expect(f.module.current().detail).toMatch(/may still be running/);
    vi.useRealTimers();
    f.configure({ answering: false, activeState: "inactive", pid: 77 });
    await f.module.start();
    expect(f.module.engine().pid).toBe(77);
    const mark = f.calls.length;
    await f.module.stopIdle();
    expect(f.calls.slice(mark)).not.toContain("stop");
    expect(f.module.engine().pid).toBe(77);
  });

  it("the idle stop clears a stuck record, so a later busy engine is not taken for the app's old picture", async () => {
    const f = await fixture({ idleMs: 3_600_000 }); f.configure({ answering: false, hold: true, stuck: true, cpu: true }); vi.useFakeTimers();
    const { jobId } = await f.module.generate({ prompt: "a tree" });
    await halfway(f, jobId);
    f.module.cancel(jobId);
    await vi.advanceTimersByTimeAsync(30_000); await f.module.wait(jobId);
    vi.useRealTimers();
    f.configure({ hold: false, stuck: false });
    await f.module.stopIdle();
    expect(f.calls).toContain("stop");
    await f.module.start();
    f.occupy();
    expect(await sent(f, MOSS_WIDE)).toMatchObject({ state: "error", errorKind: "image-busy" });
    expect(f.module.current().detail).toContain("busy with another job");
    expect(f.module.current().detail).not.toContain("earlier image from this app");
  });

  it("another client's work keeps the app's engine up, and the idle stop tries again later", async () => {
    const f = await fixture(); f.configure({ answering: false });
    const { jobId } = await f.module.generate({ prompt: "a tree", choice: MOSS_WIDE });
    await f.module.wait(jobId);
    f.configure({ busy: true });
    await pause(150);
    expect(f.calls).not.toContain("stop");
    f.configure({ busy: false });
    await vi.waitFor(() => expect(f.calls).toContain("stop"));
    expect(f.module.current()).toMatchObject({ state: "stopped" });
  });

  it("after the idle stop the next GPU reading is a new one, never one from before the stop", async () => {
    let reads = 0;
    const smi: NvidiaSmiRunner = async (args) => {
      if (!args[0]?.startsWith("--query-gpu")) return "";
      reads++;
      return "16303, 6458, 9845\n";
    };
    const f = await fixture({ idleMs: 3_600_000 }); f.configure({ answering: false });
    expect(await sent(f, MOSS_WIDE)).toMatchObject({ state: "done" });
    await readGpu(smi, Date.now, undefined, 60_000);
    await readGpu(smi, Date.now, undefined, 60_000);
    expect(reads).toBe(1);
    await f.module.stopIdle();
    expect(f.calls).toContain("stop");
    await readGpu(smi, Date.now, undefined, 60_000);
    expect(reads).toBe(2);
  });

  it("a reclaim cancelled after its first inspection leaves the engine to its idle timer, which stops it later", async () => {
    let up = false;
    let cancel: AbortController | undefined;
    const unit = () => ({ present: true, active: up, activeState: up ? "active" : "inactive", pid: 42 });
    let f!: Fixture;
    f = await fixture({ idleMs: 500, service: {
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
    await f.presetsSent(2);
    cancel = new AbortController();
    await expect(f.module.stopIdle(cancel.signal)).rejects.toThrow("reclaim cancelled");
    expect(f.calls).not.toContain("stop");
    await vi.waitFor(() => expect(f.calls).toContain("stop"), { timeout: 3_000 });
    expect(f.module.current()).toMatchObject({ state: "stopped" });
  });

  it("asked to free its memory, a ComfyUI on another computer, one turned off, or one not answering is absent", async () => {
    const signal = new AbortController().signal;
    const remote = await fixture(); remote.configure({ comfyUrl: "http://remote-comfy:8188" });
    expect(await remote.module.leave(signal)).toBe("absent");
    expect(remote.calls).not.toContain("/free");
    const off = await fixture(); off.configure({ enabled: false });
    expect(await off.module.leave(signal)).toBe("absent");
    const down = await fixture(); down.configure({ answering: false });
    expect(await down.module.leave(signal)).toBe("absent");
    const here = await fixture();
    expect(await here.module.leave(signal)).toBe("freed");
    expect(here.calls).toContain("/free");
  });
});

describe("what the picker reads", () => {
  it("runnable follows the room read with the status, with no presets read after it", async () => {
    let card = nvidia(16 * GIB);
    const f = await fixture({ gpuStatus: async () => card });
    await f.module.status();
    await f.presetsSent(1);
    expect(f.module.runnable()).toBe(true);
    card = nvidia(2 * GIB);
    const pushed = f.presets.length;
    await f.module.status();
    expect(f.presets).toHaveLength(pushed);
    expect(f.module.runnable()).toBe(false);
  });

  it("a pick of the Klein this card does not list shows as the Klein it lists", async () => {
    const f = await fixture({ gpuStatus: async () => nvidia(16 * GIB) }); f.files({ flux: true });
    const listed = await f.module.presets();
    const shown = listed.presets.find((p) => p.id === "flux2-klein-4b" || p.id === "flux2-klein-4b-compact")!.id;
    const other = shown === "flux2-klein-4b" ? "flux2-klein-4b-compact" : "flux2-klein-4b";
    expect(listed.presets.map((p) => p.id)).not.toContain(other);
    f.choose({ preset: other, width: 1024, height: 1024 });
    expect((await f.module.presets()).current).toMatchObject({ preset: { id: shown }, width: 1024, height: 1024 });
  });

  it("this computer's memory is weighed for a ComfyUI on it, and never for one on another computer", async () => {
    const f = await fixture({ gpuStatus: async () => nvidia(16 * GIB), memTotal: async () => 16 * GIB });
    f.files({ lists: [MOSS_FILES] });
    expect((await f.module.presets()).current.preset.id).not.toBe("moss-image");
    f.configure({ comfyUrl: "http://remote-comfy:8188" });
    expect((await f.module.presets()).current).toMatchObject({ preset: { id: "moss-image" }, width: 1024, height: 1024 });
  });

  it("the app's own engine with a picked folder: the picker offers no extra_model_paths line, as that engine is started reading the folder", async () => {
    const engine = await tempDir("gates-image-engine-");
    const picked = await tempDir("gates-image-picked-");
    const f = await fixture({ download: { freeBytes: async () => 10 ** 12 }, own: {
      installed: () => true, address: () => "http://127.0.0.1:41234", modelsDir: () => engine,
      inspect: async () => ({ present: true, active: false, activeState: "inactive", pid: 0 }),
      start: async () => {}, stop: async () => {}, onExit: () => {},
    } });
    f.configure({ answering: false });
    f.pickFolder(picked);
    expect((await f.module.presets()).disk).toEqual({ folder: picked, freeBytes: 10 ** 12, picked: true });
  });

  it("a setup this card does not list is judged on its own: one ComfyUI cannot run is refused with why", async () => {
    const f = await fixture(); f.files({ dropped: ["Flux2Scheduler"] });
    await expect(f.module.download("flux2-klein-4b-compact")).rejects.toMatchObject({ code: "image-model", message: expect.stringContaining("Flux2Scheduler") });
  });
});

describe("downloading a setup's files", () => {
  let holdAfter: number | undefined;
  let free = 10 ** 12;
  const served: string[] = [];
  const fileServer: typeof fetch = async (input, init) => {
    const url = new URL(String(input)), name = path.basename(url.pathname);
    served.push(`${init?.method ?? "GET"} ${name}`);
    const body = Buffer.from(`${name} v1`);
    const headers = { "content-length": String(body.length) };
    if (init?.method === "HEAD") return new Response(null, { headers });
    if (holdAfter === undefined) return new Response(body, { headers });
    const part = body.subarray(0, holdAfter), signal = init?.signal;
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(part));
        signal?.addEventListener("abort", () => controller.error(signal.reason));
      },
    }), { headers });
  };
  const [a, b] = ["flux-2-klein-4b-fp8.safetensors", "qwen_3_4b.safetensors"].map((n) => `${n} v1`.length) as [number, number];
  const setup = async (freeBytes: (f: Fixture) => number = () => free) => {
    const root = await tempDir("gates-image-models-");
    const kinds = ["checkpoints", "loras", "diffusion_models", "text_encoders", "vae"];
    let f!: Fixture;
    f = await fixture({ download: { fetch: fileServer, allow: () => true, freeBytes: async () => freeBytes(f), intervalMs: 0, records: false } });
    f.workflows({ "/internal/folder_paths": Object.fromEntries(kinds.map((k) => [k, [path.join(root, k)]])) });
    served.length = 0; holdAfter = undefined; free = 10 ** 12;
    return f;
  };
  const stopAfterFiveBytes = async (f: Fixture) => {
    holdAfter = 5;
    await f.module.download("flux2-klein-4b");
    await vi.waitFor(() => expect(f.downloads.at(-1)).toMatchObject({ state: "downloading", completedBytes: 5 }));
    expect(f.module.stopDownload("flux2-klein-4b")).toEqual({ stopped: true });
    await vi.waitFor(() => expect(f.downloads.at(-1)).toMatchObject({ state: "cancelled", ended: true }));
    await vi.waitFor(async () => expect((await f.module.presets()).download).toBeUndefined());
    holdAfter = undefined;
  };

  it("with no sizes on record, the picker does not say how much is left to fetch until every file's size is known", async () => {
    const f = await setup();
    const needs = klein(await f.module.presets());
    expect(needs).toMatchObject({ download: true, files: ["flux-2-klein-4b-fp8.safetensors", "qwen_3_4b.safetensors"] });
    expect(needs).not.toHaveProperty("leftBytes");
  });

  it("the sizes a stopped download learned from where the files are served give the picker what is left to fetch", async () => {
    const f = await setup();
    await stopAfterFiveBytes(f);
    expect(served.filter((s) => s.startsWith("GET qwen"))).toEqual([]);
    expect(klein(await f.module.presets())?.leftBytes).toEqual(expect.any(Number));
  });

  it("a part kept from a stopped download is not counted again: the picker and the room check both count only what is left", async () => {
    const f = await setup();
    await stopAfterFiveBytes(f);
    expect(klein(await f.module.presets())?.leftBytes).toBe(a - 5 + b);
    free = a - 5 + b - 1;
    await expect(f.module.download("flux2-klein-4b")).rejects.toMatchObject({ code: "image-disk" });
    free = a - 5 + b;
    expect(await f.module.download("flux2-klein-4b")).toEqual({ files: ["flux-2-klein-4b-fp8.safetensors", "qwen_3_4b.safetensors"] });
    await vi.waitFor(() => expect(f.downloads.at(-1)).toMatchObject({ state: "done", ended: true }));
  });

  it("a file already whole where the download puts it counts nothing toward what is left to fetch", async () => {
    const f = await setup();
    await f.module.download("flux2-klein-4b");
    await vi.waitFor(() => expect(f.downloads.at(-1)).toMatchObject({ state: "done", ended: true }));
    await vi.waitFor(async () => expect((await f.module.presets()).download).toBeUndefined());
    expect(klein(await f.module.presets())?.leftBytes).toBe(0);
  });

  it("the room is checked again before each later file: a disk that filled after the first file stops the download before the next", async () => {
    const f = await setup((fixed) => fixed.downloads.some((p) => p.state === "done") ? 1 : free);
    await f.module.download("flux2-klein-4b");
    await vi.waitFor(() => expect(f.downloads.at(-1)).toMatchObject({ ended: true }));
    expect(f.downloads.at(-1)).toMatchObject({ name: "qwen_3_4b.safetensors", state: "error", message: expect.stringMatching(/is left to fetch and .* is free/) });
    expect(served.filter((s) => s === "GET qwen_3_4b.safetensors")).toEqual([]);
  });

  it("a stopped download's last word keeps the setup's bytes so far and says nothing: the control offers to go on", async () => {
    const f = await setup();
    await stopAfterFiveBytes(f);
    const last = f.downloads.findLast((p) => p.state === "cancelled");
    expect(last).toMatchObject({ completedBytes: 5, setupCompletedBytes: 5, setupTotalBytes: a + b });
    expect(last?.message).toBeUndefined();
  });
});
