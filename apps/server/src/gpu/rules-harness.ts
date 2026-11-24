import { copyFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FitReport, ImageChoice, ImageEvent, ModelLoad, OtherHolder, RuntimeMode, RuntimeStatus } from "@gates-local/contracts";
import { comfyInfo, MOSS_FILES, ZIMAGE_FILES } from "../../test/comfy/info.ts";
import { MIB } from "../fit/constants.ts";
import { planLoad } from "../fit/fit.ts";
import { readGpu } from "../fit/gpu.ts";
import type { NvidiaSmiRunner } from "../fit/types.ts";
import { CANCEL_WAIT_MS } from "../image/client.ts";
import { createImageModule, STUCK_HOLD_MS, type ImageDeps } from "../image/module.ts";
import { createModelLoader, type AdmitContext, type ModelLoaderDeps, type TurnReservation } from "../runtime/load.ts";
import { canonicalTag } from "../runtime/recommended.ts";
import type { OllamaRuntime } from "../runtime/runtime.ts";
import { endTurnsForSwitch, TURN_DRAIN_MS } from "../runtime/services.ts";
import { createRuntimeSwitch, type RuntimeSwitchOptions } from "../runtime/switch.ts";
import type { LoadedModel } from "../runtime/types.ts";
import { openThreadStore } from "../threads/store.ts";
import { createGpuLease, type GpuLeaseOptions } from "./lease.ts";
import { createMemoryOwner, type MemoryOwnerDeps } from "./memory.ts";

// why: file and database work needs real turns of the loop once a test fakes the clock
const realImmediate = setImmediate;
const realTimeout = setTimeout;
const realNow = performance.now.bind(performance);

export const CARD_MIB = 16_384;
export const WHISPER_MIB = 2_000;
export const PICTURE_MIB = 8_192;
// why: two 7b models never fit together, small:1b fits beside one, big:30b fits nowhere
export const MODELS = { "m1:7b": 6_144, "m2:7b": 6_144, "small:1b": 1_024, "big:30b": 14_336 } as const;
export type Model = keyof typeof MODELS;
export const NUM_CTX = 16_384;
const RUNNER_AND_CACHE_MIB = 1_088;
const heldMib = (model: string) => (MODELS[model as Model] ?? 1_024) + RUNNER_AND_CACHE_MIB;
const same = (a: string, b: string) => canonicalTag(a) === canonicalTag(b);
// why: the owner's own pause is a timer no fake clock moves
const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  const done = () => { signal.removeEventListener("abort", stop); resolve(); };
  const stop = () => { clearTimeout(timer); reject(signal.reason); };
  const timer = setTimeout(done, ms);
  signal.addEventListener("abort", stop, { once: true });
});
const SETUPS: Record<"one" | "other", ImageChoice> = {
  one: { preset: "z-image-int8", width: 1024, height: 1024 },
  other: { preset: "moss-image", width: 1024, height: 1024 },
};

const OLLAMA_URL: Record<RuntimeMode, string> = { system: "http://ollama-system.test", app: "http://ollama-app.test" };
const COMFY_URL = "http://127.0.0.1:8188";
const COMFY_PID = 4242;
const PNG = Buffer.from("iVBORw0KGgo=", "base64");
// why: almost no system memory, so a model too big for the card is refused, never split
const MEMINFO = `MemTotal: ${2 * 1024 * 1024} kB\nMemAvailable: ${1024 * 1024} kB\n`;

export type Break =
  | NonNullable<GpuLeaseOptions["faultForTest"]>
  | NonNullable<MemoryOwnerDeps["faultForTest"]>
  | NonNullable<ModelLoaderDeps["faultForTest"]>
  | NonNullable<RuntimeSwitchOptions["faultForTest"]>
  | NonNullable<ImageDeps["faultForTest"]>
  // why: no module has this guard; the fake /api/ps names everything on the card instead
  | "ask-everything-on-the-card";

const LEASE_BREAKS: readonly Break[] = ["shared-claims-jump-the-queue"];
const OWNER_BREAKS: readonly Break[] = ["ask-replying-models"];
const LOADER_BREAKS: readonly Break[] = ["gate-before-lease", "gate-let-go-at-send", "record-without-generation-check", "fit-from-the-first-reading", "refusal-names-nothing", "forget-on-refused-switch"];
const SWITCH_BREAKS: readonly Break[] = ["stop-any-runtime"];
const PICTURE_BREAKS: readonly Break[] = ["stuck-picture-gives-the-card-back", "stop-an-engine-the-app-did-not-start", "picture-without-lease"];
const pick = <T extends Break>(mine: readonly Break[], name: Break | undefined): { faultForTest?: T } =>
  name !== undefined && mine.includes(name) ? { faultForTest: name as T } : {};

export interface WorldOptions {
  readonly advance: (ms: number) => Promise<void>;
  readonly faultForTest?: Break;
  readonly mode?: RuntimeMode;
  readonly whisper?: boolean;
  readonly otherProgramMib?: number;
  readonly loadedByOthers?: readonly Model[];
  // why: idle in the runtime's Ollama and in the app's record, as a load of an earlier run leaves it
  readonly appLoadedBefore?: readonly Model[];
  readonly freeOthers?: boolean;
  readonly comfy?: "stopped" | "idle" | "holding" | "busy";
  readonly comfySticks?: boolean;
  readonly ollamaKeepsLoading?: boolean;
  readonly slowToLeave?: readonly Model[];
  readonly appOllamaRuns?: readonly Model[];
  readonly pictureNeedMib?: number;
}

export interface Holder {
  readonly name: string;
  readonly mib: number;
  readonly state: "in" | "loading";
}

export interface ChatView {
  readonly state: "waiting" | "loading" | "replying" | "ended" | "stopped" | "refused" | "failed";
  readonly refusal?: string;
  readonly wouldStop?: readonly string[];
  readonly error?: string;
  readonly report?: FitReport;
  readonly held?: readonly OtherHolder[];
}

interface Chat {
  model: Model;
  view: ChatView;
  admitted: boolean;
  over: boolean;
  readonly turn: AbortController;
  readonly request: AbortController;
  readonly replyEnds: () => void;
  done: Promise<void>;
}

class WouldStop extends Error {
  readonly models: readonly string[];
  constructor(models: readonly string[]) {
    super("needs the GPU memory of a running reply");
    this.models = models;
  }
}

interface CardEntry { who: "whisper" | "other" | "ollama" | "comfy"; name: string; pid: number; process: string; mib: number; state: "in" | "loading" }

interface OllamaModel {
  readonly tag: string;
  numCtx: number;
  requests: number;
  leaving: boolean;
  readonly entry: CardEntry;
  readonly ready: Promise<void>;
  readonly loaded: () => void;
  readonly failed: (reason: unknown) => void;
}

// why: a new store migrates one fsync at a time; 48 of them passed 30 s on a busy machine
let migrated: Promise<string> | undefined;
async function freshStore(dataDir: string) {
  migrated ??= mkdtemp(path.join(tmpdir(), "gates-gpu-rules-store-")).then((dir) => {
    const file = path.join(dir, "threads.sqlite");
    openThreadStore(file).close();
    return file;
  });
  const file = path.join(dataDir, "threads.sqlite");
  copyFileSync(await migrated, file);
  return openThreadStore(file);
}

export type World = Awaited<ReturnType<typeof createWorld>>;

export async function createWorld(options: WorldOptions) {
  const broken = options.faultForTest;
  let seq = 0;
  const tick = () => ++seq;
  const rec = {
    asked: [] as { model: string; runtime: RuntimeMode; at: number }[],
    freed: [] as number[],
    stops: [] as string[],
    starts: [] as string[],
    overlaps: [] as string[][],
    overfull: [] as string[],
    whisper: [] as string[],
    readings: [] as number[],
    loads: [] as ModelLoad[],
    pictures: [] as ImageEvent[],
    requests: [] as string[],
  };

  const card: CardEntry[] = [];
  let nextPid = 100;
  const usedMib = () => card.reduce((sum, e) => sum + e.mib, 0);
  const freeMib = () => Math.max(0, CARD_MIB - usedMib());
  const cardChanged = (what: string) => {
    const loading = card.filter((e) => e.state === "loading").map((e) => e.name);
    if (loading.length > 1) rec.overlaps.push(loading);
    if (usedMib() > CARD_MIB) rec.overfull.push(what);
    pumpAll();
  };
  const put = (entry: CardEntry) => { card.push(entry); cardChanged(`${entry.name} put on the card`); return entry; };
  const drop = (entry: CardEntry) => {
    const at = card.indexOf(entry);
    if (at < 0) return;
    if (entry.who === "whisper") rec.whisper.push("whisper was taken off the card");
    card.splice(at, 1);
    cardChanged(`${entry.name} left the card`);
  };
  if (options.whisper !== false) card.push({ who: "whisper", name: "whisper", pid: 77, process: "/usr/local/bin/whisper-server", mib: WHISPER_MIB, state: "in" });
  let other: CardEntry | undefined;
  const otherProgramTakes = (mib: number) => {
    if (other !== undefined) { other.mib = mib; cardChanged("another program took more"); return; }
    other = put({ who: "other", name: "another program", pid: 88, process: "/opt/render/render-farm", mib, state: "in" });
  };
  if (options.otherProgramMib !== undefined) other = (card.push({ who: "other", name: "another program", pid: 88, process: "/opt/render/render-farm", mib: options.otherProgramMib, state: "in" }), card.at(-1));

  const smi: NvidiaSmiRunner = async (args) => {
    if (args[0]?.startsWith("--query-gpu")) {
      rec.readings.push(tick());
      return `${CARD_MIB}, ${Math.min(CARD_MIB, usedMib())}, ${freeMib()}\n`;
    }
    return card.map((e) => `${e.pid}, ${e.process}, ${e.mib}\n`).join("");
  };

  let whenAsked: (() => void) | undefined;
  const makeOllama = (mode: RuntimeMode) => {
    const models = new Map<string, OllamaModel>();
    const queue: { tag: string; numCtx: number; start: () => void }[] = [];
    const holdsOne = mode === "app";
    const slow = new Set((options.slowToLeave ?? []).map(canonicalTag));
    let up = mode === "system" || options.appOllamaRuns !== undefined;
    const forget = (m: OllamaModel) => { models.delete(m.tag); drop(m.entry); };
    const idle = (m: OllamaModel) => m.requests === 0 && m.entry.state === "in";
    const begin = (tag: string, numCtx: number): OllamaModel => {
      let loaded!: () => void, failed!: (reason: unknown) => void;
      const ready = new Promise<void>((resolve, reject) => { loaded = resolve; failed = reject; });
      void ready.catch(() => undefined);
      const entry: CardEntry = { who: "ollama", name: tag, pid: nextPid++, process: "/usr/local/lib/ollama/llama-server", mib: heldMib(tag), state: "loading" };
      const model: OllamaModel = { tag, numCtx, requests: 0, leaving: false, entry, ready, loaded, failed };
      models.set(tag, model);
      put(entry);
      return model;
    };
    // external: Ollama starts a load once idle models were put out for room, and waits for busy ones.
    const pump = () => {
      while (queue.length > 0) {
        const next = queue[0]!;
        // external: Ollama reloads a model asked at another context once its old copy is idle.
        const stale = models.get(next.tag);
        if (stale !== undefined && !idle(stale)) return;
        const others = [...models.values()].filter((m) => m !== stale);
        if (holdsOne && others.some((m) => !idle(m))) return;
        const out = [...stale === undefined ? [] : [stale], ...holdsOne ? others : []];
        while (freeMib() + out.reduce((sum, m) => sum + m.entry.mib, 0) < heldMib(next.tag)) {
          const more = others.find((m) => idle(m) && !out.includes(m));
          if (more === undefined) break;
          out.push(more);
        }
        const room = freeMib() + out.reduce((sum, m) => sum + m.entry.mib, 0) >= heldMib(next.tag);
        if (!room && others.some((m) => !idle(m))) return;
        queue.shift();
        for (const m of out) forget(m);
        next.start();
      }
    };
    const use = (tag: string, numCtx: number, signal: AbortSignal): Promise<void> => new Promise<void>((resolve, reject) => {
      if (signal.aborted) { reject(signal.reason); return; }
      let model: OllamaModel | undefined;
      let queued: (typeof queue)[number] | undefined;
      const attach = (m: OllamaModel) => {
        model = m;
        m.requests += 1;
        m.ready.then(resolve, reject);
      };
      const ended = () => {
        if (queued !== undefined && queue.includes(queued)) { queue.splice(queue.indexOf(queued), 1); reject(signal.reason); return; }
        if (model === undefined) return;
        model.requests -= 1;
        reject(signal.reason);
        if (model.requests > 0) return;
        // external: Ollama gives up a load whose request was dropped.
        if (model.entry.state === "loading" && !options.ollamaKeepsLoading) { model.failed(signal.reason); forget(model); return; }
        if (model.entry.state === "in" && model.leaving) forget(model);
        pumpAll();
      };
      signal.addEventListener("abort", ended, { once: true });
      const now = models.get(tag);
      if (now !== undefined && now.numCtx === numCtx) { attach(now); return; }
      queued = { tag, numCtx, start: () => {
        queued = undefined;
        attach(begin(tag, numCtx));
      } };
      queue.push(queued);
      pump();
    });
    const answer = async (url: URL, init: RequestInit | undefined): Promise<Response> => {
      if (!up) throw new Error(`fetch failed: no Ollama is running at ${url.origin}`);
      const signal = init?.signal ?? new AbortController().signal;
      const body = init?.body === undefined || init.body === null ? {} : JSON.parse(String(init.body)) as { model?: string; keep_alive?: unknown; options?: { num_ctx?: number } };
      if (url.pathname === "/api/tags") return Response.json({ models: Object.entries(MODELS).map(([name, mib]) => ({ name, size: mib * MIB, digest: name, modified_at: "2026-01-01T00:00:00Z" })) });
      if (url.pathname === "/api/ps") return Response.json({ models: [...models.values()].map((m) => ({ name: m.tag, size: m.entry.mib * MIB, size_vram: m.entry.mib * MIB, context_length: m.numCtx })) });
      if (url.pathname === "/api/show") {
        return Response.json({
          model_info: { "general.architecture": "tiny", "tiny.block_count": 4, "tiny.attention.head_count": 4, "tiny.attention.head_count_kv": 4, "tiny.attention.key_length": 64, "tiny.attention.value_length": 64, "tiny.context_length": 32_768 },
          capabilities: ["completion"],
        });
      }
      const tag = canonicalTag(body.model ?? "");
      if (url.pathname === "/api/generate" && body.keep_alive === 0) {
        rec.asked.push({ model: body.model ?? "", runtime: mode, at: tick() });
        if (/whisper/i.test(body.model ?? "")) rec.whisper.push(`an unload request named ${body.model}`);
        whenAsked?.();
        const model = models.get(tag);
        if (model !== undefined && !slow.has(tag)) {
          if (idle(model)) forget(model);
          else model.leaving = true;
        }
        return Response.json({});
      }
      if (url.pathname === "/api/generate") {
        const over = new AbortController();
        const givenUp = () => over.abort(signal.reason);
        signal.addEventListener("abort", givenUp, { once: true });
        try {
          await use(tag, body.options?.num_ctx ?? NUM_CTX, over.signal);
          return Response.json({ model: body.model, response: "", done: true });
        } finally {
          signal.removeEventListener("abort", givenUp);
          over.abort(new Error("answered"));
        }
      }
      if (url.pathname === "/api/chat") {
        await use(tag, body.options?.num_ctx ?? NUM_CTX, signal);
        return Response.json({ model: body.model, message: { role: "assistant", content: "" } });
      }
      throw new Error(`the fake Ollama has no ${url.pathname}`);
    };
    return {
      mode, url: OLLAMA_URL[mode], answer, pump,
      up: () => up,
      start() { up = true; rec.starts.push(`ollama ${mode}`); },
      stop() {
        up = false;
        rec.stops.push(`ollama ${mode}`);
        for (const m of models.values()) { m.failed(new Error("Ollama stopped")); forget(m); }
        queue.length = 0;
      },
      holdsIdle(tag: string, numCtx = NUM_CTX) { begin(canonicalTag(tag), numCtx).entry.state = "in"; models.get(canonicalTag(tag))!.loaded(); },
      finish(tag: string) {
        const model = models.get(canonicalTag(tag));
        if (model === undefined || model.entry.state !== "loading") return false;
        model.entry.state = "in";
        model.loaded();
        cardChanged(`${model.tag} finished loading`);
        if (model.requests === 0 && model.leaving) forget(model);
        return true;
      },
      letGo(tag: string) {
        slow.delete(canonicalTag(tag));
        const model = models.get(canonicalTag(tag));
        if (model === undefined) return;
        if (idle(model)) forget(model);
        else model.leaving = true;
      },
      lists: () => [...models.keys()],
    };
  };
  const ollamas: Record<RuntimeMode, ReturnType<typeof makeOllama>> = { system: makeOllama("system"), app: makeOllama("app") };
  function pumpAll() { ollamas.system.pump(); ollamas.app.pump(); }

  const startedByOthers = options.comfy !== undefined && options.comfy !== "stopped";
  const comfy = {
    up: startedByOthers,
    entry: undefined as CardEntry | undefined,
    running: options.comfy === "busy" ? "foreign" : undefined as string | undefined,
    sticks: options.comfySticks === true,
    held: undefined as Promise<void> | undefined,
    release: undefined as (() => void) | undefined,
    socket: undefined as EventTarget | undefined,
    prompts: 0,
  };
  const comfyHolds = (state: "in" | "loading") => {
    if (comfy.entry !== undefined) { comfy.entry.state = state; cardChanged(`ComfyUI is ${state === "in" ? "loaded" : "loading"}`); return; }
    comfy.entry = put({ who: "comfy", name: "ComfyUI", pid: COMFY_PID, process: "/opt/comfy/venv/bin/python", mib: PICTURE_MIB, state });
  };
  const comfyDrops = () => { const e = comfy.entry; comfy.entry = undefined; if (e !== undefined) drop(e); };
  if (options.comfy === "holding" || options.comfy === "busy") comfy.entry = (card.push({ who: "comfy", name: "ComfyUI", pid: COMFY_PID, process: "/opt/comfy/venv/bin/python", mib: PICTURE_MIB, state: "in" }), card.at(-1));
  const frame = (type: string, data: object) => comfy.socket?.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type, data }) }));
  const comfyAnswers = async (url: URL, init: RequestInit | undefined): Promise<Response> => {
    if (!comfy.up) throw new Error("fetch failed: no ComfyUI is running");
    const route = url.pathname;
    if (route === "/system_stats") {
      if (comfy.held !== undefined) await comfy.held;
      return Response.json({ system: { comfyui_version: "fake" }, devices: [{ type: "cuda", torch_vram_total: (comfy.entry?.mib ?? 0) * MIB }] });
    }
    if (route === "/object_info") return Response.json(comfyInfo(ZIMAGE_FILES, MOSS_FILES));
    if (route === "/queue" && init?.method !== "POST") return Response.json({ queue_running: comfy.running === undefined ? [] : [[1, comfy.running]], queue_pending: [] });
    if (route === "/queue") return Response.json({});
    if (route === "/free") {
      rec.freed.push(tick());
      comfyDrops();
      return Response.json({});
    }
    if (route === "/prompt") {
      const id = `p${++comfy.prompts}`;
      comfy.running = id;
      if (comfy.entry === undefined) comfyHolds("loading");
      queueMicrotask(() => frame("progress", { prompt_id: id, value: 1, max: 4 }));
      return Response.json({ prompt_id: id });
    }
    if (route === "/interrupt") {
      if (!comfy.sticks) { comfy.running = undefined; if (comfy.entry?.state === "loading") comfyHolds("in"); }
      return Response.json({});
    }
    if (route.startsWith("/history/")) {
      const id = decodeURIComponent(route.slice("/history/".length));
      return Response.json(comfy.running === id ? {} : { [id]: { outputs: { "8": { images: [{ filename: "out.png", subfolder: "", type: "output" }] } } } });
    }
    if (route === "/view") return new Response(PNG);
    if (route.startsWith("/templates/") || route.startsWith("/userdata") || route.startsWith("/internal/")) return new Response("not found", { status: 404 });
    throw new Error(`the fake ComfyUI has no ${route}`);
  };

  const router: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    rec.requests.push(`${init?.method ?? "GET"} ${url.origin}${url.pathname}`);
    init?.signal?.throwIfAborted();
    if (url.origin === OLLAMA_URL.system) return ollamas.system.answer(url, init);
    if (url.origin === OLLAMA_URL.app) return ollamas.app.answer(url, init);
    if (url.origin === COMFY_URL) return comfyAnswers(url, init);
    throw new Error(`a GPU rules world reaches no real address: ${url.origin} was refused`);
  };
  const fetchBefore = globalThis.fetch;
  globalThis.fetch = router;

  const lease = createGpuLease(pick<NonNullable<GpuLeaseOptions["faultForTest"]>>(LEASE_BREAKS, broken));
  const makeRuntime = (mode: RuntimeMode): OllamaRuntime => {
    const ollama = ollamas[mode];
    let startedHere = false;
    const status = (): RuntimeStatus => ({ state: ollama.up() ? "ready" : "stopped", owner: mode === "system" ? "external" : ollama.up() ? "app" : "none", baseUrl: ollama.url, ...mode === "app" && ollama.up() ? { holdsOne: true } : {} });
    return {
      mode, status,
      baseUrl: () => (ollama.up() ? ollama.url : undefined),
      discover: async () => status(),
      async ensure() {
        if (!ollama.up()) { ollama.start(); startedHere = true; }
        return status();
      },
      async stop() { ollama.stop(); startedHere = false; return { stopped: true } as Awaited<ReturnType<OllamaRuntime["stop"]>>; },
      startedByThisProcess: () => startedHere,
      killNow: () => undefined,
      onChange: () => () => undefined,
      onInstallProgress: () => () => undefined,
    };
  };
  const runtime = createRuntimeSwitch({
    initialMode: options.mode ?? "system",
    make: makeRuntime,
    beforeSwitch: () => endTurnsForSwitch(loader, TURN_DRAIN_MS),
    afterSwitch: () => loader.runtimeSettled(),
    ...pick<NonNullable<RuntimeSwitchOptions["faultForTest"]>>(SWITCH_BREAKS, broken),
  });
  const holdsOne = () => runtime.baseUrl() !== undefined && runtime.status().holdsOne === true;
  // external: the app reads /api/ps with Node's http client, which a fetch router cannot reach.
  const listed = async (url: string, signal?: AbortSignal): Promise<LoadedModel[]> => {
    const ps = await (await router(new URL("/api/ps", url), signal === undefined ? {} : { signal })).json() as { models: { name: string; size: number; size_vram: number; context_length: number }[] };
    const real = ps.models.map((m): LoadedModel => ({ name: m.name, sizeBytes: m.size, sizeVramBytes: m.size_vram, contextLength: m.context_length }));
    if (broken !== "ask-everything-on-the-card") return real;
    const others = card.filter((e) => e.who !== "ollama").map((e): LoadedModel => ({ name: e.who === "whisper" ? "whisper-server" : e.name, sizeBytes: e.mib * MIB, sizeVramBytes: e.mib * MIB }));
    return [...real, ...others];
  };
  const dataDir = await mkdtemp(path.join(tmpdir(), "gates-gpu-rules-"));
  const store = await freshStore(dataDir);
  const owner = createMemoryOwner({
    ollamaUrl: () => runtime.baseUrl(),
    holdsOne,
    freeOthers: () => options.freeOthers === true,
    listLoaded: listed,
    replying: () => loader.replying(),
    engine: () => image,
    fetch: router,
    readFree: async (signal) => {
      const reading = await readGpu(smi, tick, signal);
      return reading.gpuCount === 0 ? undefined : reading.freeBytes;
    },
    onUnloaded: (model) => loader.unloaded(model),
    sleep,
    ...pick<NonNullable<MemoryOwnerDeps["faultForTest"]>>(OWNER_BREAKS, broken),
  });
  const fitDeps = (baseUrl: string) => ({ runNvidiaSmi: smi, readMeminfo: async () => MEMINFO, now: tick, holdsOne: baseUrl === OLLAMA_URL.app });
  const loader = createModelLoader({
    baseUrl: () => runtime.baseUrl(),
    push: (load) => { rec.loads.push(load); },
    listLoaded: listed,
    fit: async (model, numCtx, baseUrl, signal) => (await planLoad({ ...fitDeps(baseUrl), baseUrl, model, numCtx, signal, busy: loader.busyModels(), measured: true })).report,
    memory: owner,
    lease,
    ...pick<NonNullable<ModelLoaderDeps["faultForTest"]>>(LOADER_BREAKS, broken),
  });
  const image = createImageModule({
    dataDir, lease, store, memory: owner,
    requiredBytes: (options.pictureNeedMib ?? PICTURE_MIB) * MIB,
    // why: the idle stop is not one of these rules
    idleMs: 24 * 3_600_000,
    log: () => undefined,
    settings: () => ({ imageGen: true, imageChoice: SETUPS.one }),
    runNvidiaSmi: smi,
    localAddresses: () => ["192.168.1.20"],
    lookupHost: async () => ["192.168.1.20"],
    service: {
      inspect: async () => ({ present: true, active: comfy.up, activeState: comfy.up ? "active" : "inactive", pid: COMFY_PID }),
      start: async () => { rec.starts.push("comfyui"); comfy.up = true; },
      stop: async () => { rec.stops.push("comfyui"); comfy.up = false; comfy.running = undefined; comfyDrops(); },
    },
    socket: () => {
      const socket = new EventTarget();
      Object.defineProperty(socket, "readyState", { value: 1 });
      Object.assign(socket, { close() {} });
      comfy.socket = socket;
      return socket as WebSocket;
    },
    fetch: router,
    push: (channel, payload) => { if (channel === "image.event") rec.pictures.push(payload as ImageEvent); },
    ...pick<NonNullable<ImageDeps["faultForTest"]>>(PICTURE_BREAKS, broken),
  });
  await runtime.ensure();
  for (const model of options.loadedByOthers ?? []) ollamas[runtime.mode()].holdsIdle(model);
  for (const model of options.appOllamaRuns ?? []) ollamas.app.holdsIdle(model);
  for (const model of options.appLoadedBefore ?? []) {
    ollamas[runtime.mode()].holdsIdle(model);
    owner.loaded.loaded(model, NUM_CTX);
  }

  const pass = async (ms = 1_000) => {
    for (let left = ms; left > 0; left -= 250) {
      await options.advance(Math.min(250, left));
      await new Promise<void>((resolve) => realImmediate(resolve));
    }
  };
  // why: a finished picture's file is really written, which takes as long as the disk takes
  const until = async (met: () => boolean, what: string) => {
    for (const start = realNow(); !met() && realNow() - start < 10_000;) {
      await options.advance(25);
      await new Promise<void>((resolve) => realTimeout(resolve, 1));
    }
    if (!met()) throw new Error(`the world never got to: ${what}`);
  };

  const chats = new Map<string, Chat>();
  const chat = (id: string): Chat => {
    const found = chats.get(id);
    if (found === undefined) throw new Error(`no chat ${id} was sent`);
    return found;
  };
  let picture: string | undefined;
  const pictureJobs: string[] = [];
  const lastOf = (jobId: string | undefined) => rec.pictures.findLast((e) => e.jobId === jobId);
  let switching: Promise<RuntimeStatus> | undefined;
  let switchError: Error | undefined;
  let switchOver = true;
  let preloads: Promise<ModelLoad | Error>[] = [];

  const world = {
    lease, owner, loader, runtime, image, rec,
    record: owner.loaded,

    // why: the steps, in their order, are the ones app/admit.ts takes on the GPU
    async chatSends(id: string, sent: { model?: Model; numCtx?: number; askFirst?: boolean; endsWhenTold?: boolean } = {}) {
      const { model = "m1:7b", numCtx = NUM_CTX, askFirst = false, endsWhenTold = true } = sent;
      const turn = new AbortController();
      const request = new AbortController();
      let replyEnds!: () => void;
      const replied = new Promise<void>((resolve) => { replyEnds = resolve; });
      const me: Chat = { model, view: { state: "waiting" }, admitted: false, over: false, turn, request, replyEnds, done: Promise.resolve() };
      chats.set(id, me);
      me.done = (async () => {
        let reservation: TurnReservation | undefined;
        let release: (() => void) | undefined;
        try {
          reservation = loader.reserve(model);
          const baseUrl = reservation.baseUrl;
          if (baseUrl === undefined) throw new Error("no runtime is ready");
          const gone = reservation.signal;
          gone.addEventListener("abort", () => { if (endsWhenTold) turn.abort(gone.reason); }, { once: true });
          const plan = async (signal: AbortSignal, context?: AdmitContext): Promise<FitReport> => {
            const running = [...chats.values()].filter((c) => c !== me && c.admitted && !c.over && !same(c.model, model));
            const planned = await planLoad({ ...fitDeps(baseUrl), baseUrl, model, numCtx, busy: running.map((c) => c.model), signal, ...context?.handoff !== undefined ? { measured: true } : {} });
            const stop = running.filter((c) => planned.stop.some((name) => same(name, c.model)));
            if (askFirst && stop.length > 0) throw new WouldStop(stop.map((c) => c.model));
            return planned.report;
          };
          if (askFirst && [...chats.values()].some((c) => c.admitted && !c.over)) {
            const ahead = await plan(turn.signal);
            if (ahead.verdict === "refuse" && image.current().state === "off") { me.view = { state: "refused", refusal: ahead.message ?? "", report: ahead }; return; }
          }
          release = await lease.acquire("chat", turn.signal);
          let held: readonly OtherHolder[] | undefined;
          const report = await reservation.admit(numCtx, {
            fit: async (signal, context) => {
              const r = await plan(signal, context);
              held = context?.handoff?.held;
              if (r.verdict !== "refuse") me.admitted = true;
              return r;
            },
            signal: turn.signal,
          });
          if (report.verdict === "refuse") { me.view = { state: "refused", refusal: report.message ?? "", report, ...held === undefined ? {} : { held } }; return; }
          me.admitted = true;
          me.view = { state: "loading", report };
          turn.signal.addEventListener("abort", () => request.abort(turn.signal.reason), { once: true });
          if (turn.signal.aborted) throw turn.signal.reason;
          const res = await fetch(new URL("/api/chat", baseUrl), { method: "POST", body: JSON.stringify({ model, options: { num_ctx: report.numCtx } }), signal: request.signal });
          await res.arrayBuffer();
          reservation.firstToken();
          me.view = { state: "replying", report };
          await new Promise<void>((resolve) => {
            void replied.then(resolve);
            turn.signal.addEventListener("abort", () => resolve(), { once: true });
            if (turn.signal.aborted) resolve();
          });
          me.view = { state: turn.signal.aborted ? "stopped" : "ended", report };
        } catch (e) {
          if (e instanceof WouldStop) me.view = { state: "refused", refusal: e.message, wouldStop: e.models };
          else if (turn.signal.aborted) me.view = { state: "stopped" };
          else me.view = { state: "failed", error: e instanceof Error ? e.message : String(e) };
        } finally {
          me.over = true;
          request.abort(new Error("the turn ended"));
          reservation?.end();
          release?.();
        }
      })();
      await pass();
    },
    chat: (id: string): ChatView => chat(id).view,
    async ollamaFinishesLoading(model: Model = "m1:7b") {
      if (!ollamas.system.finish(model) && !ollamas.app.finish(model)) throw new Error(`no Ollama is loading ${model}`);
      await pass();
    },
    async chatEnds(id: string) {
      const c = chat(id);
      if (c.view.state === "replying") c.replyEnds();
      else c.turn.abort(new Error("the turn ended"));
      await pass();
    },
    async personStopsChat(id: string) {
      chat(id).turn.abort(new Error("stopped"));
      await pass();
    },
    async preloads(model: Model = "m1:7b", numCtx = NUM_CTX) {
      preloads.push(loader.load(model, numCtx).catch((e: unknown) => (e instanceof Error ? e : new Error(String(e)))));
      await pass();
    },
    preloaded: async () => Promise.all(preloads),
    // why: the steps of memory.free in services.ts: the owner frees inside the load gate
    async personFrees(holders: readonly OtherHolder[]) {
      const freeing = owner.gate(() => owner.free(holders, new AbortController().signal));
      await pass(5_000);
      return freeing;
    },

    async pictureSends(sent: { setup?: "one" | "other" } = {}) {
      const { jobId } = await image.generate({ prompt: "a tree", choice: SETUPS[sent.setup ?? "one"] });
      picture = jobId;
      pictureJobs.push(jobId);
      await pass();
      return jobId;
    },
    picture: (jobId?: string) => lastOf(jobId ?? picture),
    pictureJobs: () => [...pictureJobs],
    comfyHoldsItsAnswer() {
      comfy.held = new Promise<void>((resolve) => { comfy.release = resolve; });
    },
    async comfyAnswers() {
      comfy.release?.();
      comfy.held = undefined;
      await pass();
    },
    async comfyFinishesLoading() {
      if (comfy.entry?.state !== "loading") throw new Error("ComfyUI is not loading");
      comfyHolds("in");
      await pass();
    },
    async pictureFinishes(jobId = picture) {
      const id = comfy.running;
      if (id === undefined || id === "foreign") throw new Error("ComfyUI is not making a picture of the app's");
      if (comfy.entry?.state === "loading") comfyHolds("in");
      comfy.running = undefined;
      frame("executing", { prompt_id: id, node: null });
      await until(() => ["done", "error", "cancelled"].includes(lastOf(jobId)?.state ?? ""), "the picture's end");
      await pass();
    },
    async personStopsPicture(jobId = picture) {
      if (jobId !== undefined) image.cancel(jobId);
      await pass();
    },
    async pictureStopTimesOut() {
      await pass(CANCEL_WAIT_MS + 1_000);
    },
    async stuckHoldRunsOut() {
      await pass(STUCK_HOLD_MS + 2_000);
    },
    async comfyLetsGo() {
      comfy.sticks = false;
      comfy.running = undefined;
      if (comfy.entry?.state === "loading") comfyHolds("in");
      await pass();
    },
    async othersJobEnds() {
      if (comfy.running === "foreign") comfy.running = undefined;
      await pass();
    },
    async othersJobStarts() {
      if (!comfy.up || comfy.running !== undefined) throw new Error("ComfyUI is not free for somebody else's job");
      comfy.running = "foreign";
      if (comfy.entry === undefined) comfyHolds("in");
      await pass();
    },
    async slowModelLeaves(model: Model, mode: RuntimeMode = runtime.mode()) {
      ollamas[mode].letGo(model);
      await pass();
    },

    async switchBegins(to: RuntimeMode = runtime.mode() === "system" ? "app" : "system") {
      switchError = undefined;
      switchOver = false;
      switching = runtime.setMode(to);
      switching.then(() => { switchOver = true; }, (e: unknown) => { switchError = e instanceof Error ? e : new Error(String(e)); switchOver = true; });
      await pass();
    },
    async switchIsRefused(): Promise<Error> {
      await pass(TURN_DRAIN_MS + 1_000);
      if (switchError === undefined) throw new Error("the switch was not refused");
      return switchError;
    },
    async switchGoesAhead(): Promise<RuntimeStatus> {
      if (switching === undefined) throw new Error("no switch began");
      await until(() => switchOver, "the switch's end");
      if (switchError !== undefined) throw switchError;
      return switching;
    },
    async statusPolls() {
      await loader.residentModels();
      await pass(250);
    },

    otherProgramTakes,
    whenNextAskedToLeave(then: () => void) {
      whenAsked = () => { whenAsked = undefined; then(); };
    },
    pass,

    card: () => ({
      holders: card.map((e): Holder => ({ name: e.name, mib: e.mib, state: e.state })),
      names: card.map((e) => e.name),
      loading: card.filter((e) => e.state === "loading").map((e) => e.name),
      freeMib: freeMib(),
    }),
    ollamaLists: (mode: RuntimeMode = runtime.mode()) => ollamas[mode].lists(),
    askedToLeave: () => rec.asked.map((a) => a.model),
    comfyUp: () => comfy.up,

    async close() {
      try {
        for (const c of chats.values()) c.turn.abort(new Error("the test ended"));
        comfy.release?.();
        comfy.sticks = false;
        comfy.running = undefined;
        const ending = Promise.allSettled([image.close(), loader.close(), ...[...chats.values()].map((c) => c.done), ...preloads]);
        let ended = false;
        void ending.then(() => { ended = true; });
        await until(() => ended, "the end of every job");
        store.close();
      } finally {
        globalThis.fetch = fetchBefore;
      }
    },
  };
  return world;
}
