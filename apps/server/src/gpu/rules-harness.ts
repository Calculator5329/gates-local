// The app's GPU rules, run on the real modules (rules.test.ts).
//
// One world per test: the real lease, load gate, memory owner, loaded record, loader, runtime
// switch (with the wait a switch gives running turns) and picture job, wired to each other the
// way runtime/services.ts and main.ts wire them. Only the edges are fakes: a card with a size and
// what is on it (whisper included), one Ollama per runtime, a ComfyUI with the service that
// starts and stops it, and the test's clock. A chat turn takes the steps app/admit.ts takes on
// the GPU, in its order: reserve, the plan before the claim when it asks first, the claim, the
// admission inside the gate, the chat request, the first token, the end.
//
// Each function is one step that a person, Ollama or ComfyUI takes. A test is a list of steps
// and what must be true after them. The world writes down every request that reaches an edge, so
// a test can say what was never asked: nothing ever asked of whisper, no stop of a process the
// app did not start, never two things loading at once (checked at every change of the card, not
// only between steps).
//
// Nothing here reaches a real card, Ollama or ComfyUI. Every request goes to a fake by its
// address; one to any other address is refused. While a world is open the global fetch is that
// router too, since the fit and the loader call it directly.
//
// `faultForTest` turns one guard of one module off (each module's own option of that name), so
// the test that guards it can be seen failing. Nothing but this file and tests may set it (lint `gates/test-switch-stays-in-tests`).
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FitReport, ImageChoice, ImageEvent, ModelLoad, RuntimeMode, RuntimeStatus } from "@gates-local/contracts";
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

// Taken before a test installs its fake clock: file and database work needs real turns of the loop.
const realImmediate = setImmediate;
const realTimeout = setTimeout;
const realNow = performance.now.bind(performance);

/** The card every world has, in MiB. */
export const CARD_MIB = 16_384;
export const WHISPER_MIB = 2_000;
/** What ComfyUI holds once a setup is loaded, and what a picture needs free unless a world says otherwise. */
export const PICTURE_MIB = 8_192;
/** Installed chat models and their files' sizes in MiB. Two 7b models do not fit beside each other; small:1b fits beside one; big:30b never fits. */
export const MODELS = { "m1:7b": 6_144, "m2:7b": 6_144, "small:1b": 1_024, "big:30b": 14_336 } as const;
export type Model = keyof typeof MODELS;
export const NUM_CTX = 16_384;
/** What a loaded model holds beyond its files: the runner's overhead and the context's cache, as the fit estimates them. */
const RUNNER_MIB = 1_088;
const heldMib = (model: string) => (MODELS[model as Model] ?? 1_024) + RUNNER_MIB;
const same = (a: string, b: string) => canonicalTag(a) === canonicalTag(b);
/** The owner's pause, on the test's clock (its default is a timer no fake clock moves). */
const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  const done = () => { signal.removeEventListener("abort", stop); resolve(); };
  const stop = () => { clearTimeout(timer); reject(signal.reason); };
  const timer = setTimeout(done, ms);
  signal.addEventListener("abort", stop, { once: true });
});
/** The two setups a picture can ask for: ComfyUI lists the files of both. */
const SETUPS: Record<"one" | "other", ImageChoice> = {
  one: { preset: "z-image-int8", width: 1024, height: 1024 },
  other: { preset: "moss-image", width: 1024, height: 1024 },
};

const OLLAMA_URL: Record<RuntimeMode, string> = { system: "http://ollama-system.test", app: "http://ollama-app.test" };
/** The address the app manages its ComfyUI at; here it only ever names the fake. */
const COMFY_URL = "http://127.0.0.1:8188";
const COMFY_PID = 4242;
const PNG = Buffer.from("iVBORw0KGgo=", "base64");
/** This computer has almost no system memory: a model that does not fit the card is refused, never run partly from system memory. */
const MEMINFO = `MemTotal: ${2 * 1024 * 1024} kB\nMemAvailable: ${1024 * 1024} kB\n`;

/** Every guard a test can turn off, by the module that holds it. */
export type Break =
  | NonNullable<GpuLeaseOptions["faultForTest"]>
  | NonNullable<MemoryOwnerDeps["faultForTest"]>
  | NonNullable<ModelLoaderDeps["faultForTest"]>
  | NonNullable<RuntimeSwitchOptions["faultForTest"]>
  | NonNullable<ImageDeps["faultForTest"]>
  /** No module has this guard as a line: the owner asks only models Ollama lists. Here the list is made to name everything on the card. */
  | "ask-everything-on-the-card";

const LEASE_BREAKS: readonly Break[] = ["shared-claims-jump-the-queue"];
const OWNER_BREAKS: readonly Break[] = ["ask-replying-models"];
const LOADER_BREAKS: readonly Break[] = ["gate-before-lease", "gate-let-go-at-send", "record-without-generation-check", "fit-from-the-first-reading", "refusal-names-nothing", "forget-on-refused-switch"];
const SWITCH_BREAKS: readonly Break[] = ["stop-any-runtime"];
const PICTURE_BREAKS: readonly Break[] = ["stuck-picture-gives-the-card-back", "stop-an-engine-the-app-did-not-start", "picture-without-lease"];
/** `name` as module `T`'s own option, when it is one of that module's. */
const pick = <T extends Break>(mine: readonly Break[], name: Break | undefined): { faultForTest?: T } =>
  name !== undefined && mine.includes(name) ? { faultForTest: name as T } : {};

export interface WorldOptions {
  /** Moves the test's fake clock (vi.advanceTimersByTimeAsync). */
  readonly advance: (ms: number) => Promise<void>;
  readonly faultForTest?: Break;
  /** The runtime the app starts on; "system" unless said. */
  readonly mode?: RuntimeMode;
  /** Whisper is on the card unless a world says not. */
  readonly whisper?: boolean;
  /** Another program on the card and what it holds, in MiB. */
  readonly otherProgramMib?: number;
  /** Chat models in the first runtime's Ollama that another program loaded. */
  readonly loadedByOthers?: readonly Model[];
  /**
   * ComfyUI at the start. "stopped": the app starts it for a picture. The rest run already, so
   * somebody else started them: "idle" holds nothing, "holding" holds a setup's models, "busy"
   * holds them and runs somebody else's job.
   */
  readonly comfy?: "stopped" | "idle" | "holding" | "busy";
  /** ComfyUI ignores a request to stop a picture until comfyLetsGo(). */
  readonly comfySticks?: boolean;
  /** An Ollama keeps loading a model after the request that asked for it was dropped. */
  readonly ollamaKeepsLoading?: boolean;
  /** Models an Ollama goes on listing after it was asked to unload them. */
  readonly slowToLeave?: readonly Model[];
  /** The app's own Ollama runs already, left by an earlier run of the app, and holds these. */
  readonly appOllamaRuns?: readonly Model[];
  /** What a picture needs free, in MiB. */
  readonly pictureNeedMib?: number;
}

/** One thing on the card, as a test reads it. */
export interface Holder {
  /** "whisper", "another program", "ComfyUI" or a chat model's tag. */
  readonly name: string;
  readonly mib: number;
  readonly state: "in" | "loading";
}

export interface ChatView {
  readonly state: "waiting" | "loading" | "replying" | "ended" | "stopped" | "refused" | "failed";
  /** A refusal's words. */
  readonly refusal?: string;
  /** Refused because it would stop these replies' models, and the person was not asked yet. */
  readonly wouldStop?: readonly string[];
  readonly error?: string;
  /** The fit the admission decided from. */
  readonly report?: FitReport;
}

interface Chat {
  model: Model;
  view: ChatView;
  /** Admitted: the next plan counts its model as busy. */
  started: boolean;
  over: boolean;
  /** The turn's own signal: the person's Stop, or its runtime going when it listens for that. */
  readonly turn: AbortController;
  /** The chat request in Ollama: open from the send to the turn's end. */
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
  /** Requests using it: a chat from its send to its end, a preload until it is answered. */
  requests: number;
  /** Asked to unload while in use or loading: it goes once nothing uses it. */
  leaving: boolean;
  readonly entry: CardEntry;
  readonly ready: Promise<void>;
  readonly loaded: () => void;
  readonly failed: (reason: unknown) => void;
}

export type World = Awaited<ReturnType<typeof createWorld>>;

export async function createWorld(options: WorldOptions) {
  const broken = options.faultForTest;
  let seq = 0;
  /** One counter orders the readings of the card and the requests to leave. */
  const tick = () => ++seq;
  const rec = {
    /** Every unload request an Ollama got. */
    asked: [] as { model: string; runtime: RuntimeMode; at: number }[],
    /** Every request to ComfyUI to free its models. */
    freed: [] as number[],
    /** Every process stopped and started: "ollama system", "ollama app", "comfyui". */
    stops: [] as string[],
    starts: [] as string[],
    /** Every time two things were loading on the card at once. */
    overlaps: [] as string[][],
    /** Every time more was put on the card than it has. */
    overfull: [] as string[],
    /** Anything that named whisper in a request, or changed what it holds. */
    whisper: [] as string[],
    /** When each reading of the card was taken. */
    readings: [] as number[],
    loads: [] as ModelLoad[],
    pictures: [] as ImageEvent[],
    /** Every request that reached a fake: its method and address. */
    requests: [] as string[],
  };

  // ---- the card -------------------------------------------------------------------------------
  const card: CardEntry[] = [];
  let nextPid = 100;
  const usedMib = () => card.reduce((sum, e) => sum + e.mib, 0);
  const freeMib = () => Math.max(0, CARD_MIB - usedMib());
  /** After every change: who is loading now, and whether the card is over its size. */
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

  // ---- an Ollama per runtime ------------------------------------------------------------------
  /** Called on a request to unload, before it is answered: a test's chance to change the card meanwhile. */
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
    /** Ollama's own scheduler: a load starts once there is room, after idle models were put out for it; it waits for busy ones. */
    const pump = () => {
      while (queue.length > 0) {
        const next = queue[0]!;
        // the same model at another context is reloaded: its old copy goes first, once nothing uses it
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
        // no room and something of its own still in use: the load waits for it
        if (!room && others.some((m) => !idle(m))) return;
        queue.shift();
        for (const m of out) forget(m);
        next.start();
      }
    };
    /** A request that needs `tag` at `numCtx` in memory: resolves once it is, and counts as using it until `signal` ends. */
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
        // dropped while it loads: Ollama gives the load up, unless this world's Ollama keeps going
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
        // a preload: answered once the model is in memory, and no longer using it then
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
        // answered at the first token; the reply uses the model until the request's signal ends
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
        // a Map may lose the entry it is on while it is walked
        for (const m of models.values()) { m.failed(new Error("Ollama stopped")); forget(m); }
        queue.length = 0;
      },
      /** A model another program loaded here, idle. */
      has(tag: string, numCtx = NUM_CTX) { begin(canonicalTag(tag), numCtx).entry.state = "in"; models.get(canonicalTag(tag))!.loaded(); },
      /** The load of `tag` finishes: whatever waited on it is answered. False when it is not loading here. */
      finish(tag: string) {
        const model = models.get(canonicalTag(tag));
        if (model === undefined || model.entry.state !== "loading") return false;
        model.entry.state = "in";
        model.loaded();
        cardChanged(`${model.tag} finished loading`);
        if (model.requests === 0 && model.leaving) forget(model);
        return true;
      },
      /** A model this Ollama went on listing after an unload request goes now, if nothing uses it. */
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

  // ---- ComfyUI and its service ----------------------------------------------------------------
  const startedByOthers = options.comfy !== undefined && options.comfy !== "stopped";
  const comfy = {
    up: startedByOthers,
    /** What it holds on the card. */
    entry: undefined as CardEntry | undefined,
    /** The prompt in its queue: the app's own, or somebody else's. */
    running: options.comfy === "busy" ? "foreign" : undefined as string | undefined,
    sticks: options.comfySticks === true,
    /** While set, /system_stats is not answered: a picture waits before its gate. */
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
      // a setup it does not hold yet is loaded for the prompt
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

  // ---- one router for every request -----------------------------------------------------------
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

  // ---- the real modules, wired as services.ts and main.ts wire them --------------------------
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
  /**
   * /api/ps as the app reads it. The app reads it over node:http, which no test can route, so
   * this is the one reader replaced: the same answer, from the fake. The one variant no module
   * holds a line for makes it name everything on the card.
   */
  const listed = async (url: string, signal?: AbortSignal): Promise<LoadedModel[]> => {
    const ps = await (await router(new URL("/api/ps", url), signal === undefined ? {} : { signal })).json() as { models: { name: string; size: number; size_vram: number; context_length: number }[] };
    const real = ps.models.map((m): LoadedModel => ({ name: m.name, sizeBytes: m.size, sizeVramBytes: m.size_vram, contextLength: m.context_length }));
    if (broken !== "ask-everything-on-the-card") return real;
    const others = card.filter((e) => e.who !== "ollama").map((e): LoadedModel => ({ name: e.who === "whisper" ? "whisper-server" : e.name, sizeBytes: e.mib * MIB, sizeVramBytes: e.mib * MIB }));
    return [...real, ...others];
  };
  const dataDir = await mkdtemp(path.join(tmpdir(), "gates-gpu-rules-"));
  const store = openThreadStore(path.join(dataDir, "threads.sqlite"));
  const owner = createMemoryOwner({
    ollamaUrl: () => runtime.baseUrl(),
    holdsOne,
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
  /** What every fit reads: the fake card, this computer's small memory, and the counter as its clock. */
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
    // the idle stop is not one of these rules: it never runs inside a test
    idleMs: 24 * 3_600_000,
    log: () => undefined,
    settings: () => ({ imageGen: true, imageChoice: SETUPS.one }),
    runNvidiaSmi: smi,
    localAddresses: () => ["192.168.1.20"],
    lookupHost: async () => ["192.168.1.20"],
    service: {
      inspect: async () => ({ present: true, active: comfy.up, activeState: comfy.up ? "active" : "inactive", pid: COMFY_PID }),
      start: async () => { rec.starts.push("comfyui"); comfy.up = true; },
      // a stopped engine's queue and memory go with its process
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
  for (const model of options.loadedByOthers ?? []) ollamas[runtime.mode()].has(model);
  for (const model of options.appOllamaRuns ?? []) ollamas.app.has(model);

  // ---- the clock ------------------------------------------------------------------------------
  /** `ms` of the test's clock, a quarter second at a time, with real turns of the loop between for file and database work. */
  const pass = async (ms = 1_000) => {
    for (let left = ms; left > 0; left -= 250) {
      await options.advance(Math.min(250, left));
      await new Promise<void>((resolve) => realImmediate(resolve));
    }
  };
  /**
   * Steps the clock until `met`; a world that never gets there fails by name. The only wait on
   * real time: a finished picture's file is really written, and that takes as long as the disk takes.
   */
  const until = async (met: () => boolean, what: string) => {
    for (const start = realNow(); !met() && realNow() - start < 10_000;) {
      await options.advance(25);
      await new Promise<void>((resolve) => realTimeout(resolve, 1));
    }
    if (!met()) throw new Error(`the world never got to: ${what}`);
  };

  // ---- steps ----------------------------------------------------------------------------------
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
    /** The memory owner's record of what is loaded and which of it is the app's. */
    record: owner.loaded,

    /**
     * A person sends a chat. `askFirst`: the client's first try, refused with the replies it would
     * stop. `endsWhenTold: false`: a turn that goes on after its runtime told it to end (a tool
     * round that does not return), until chatEnds.
     */
    async chatSends(id: string, sent: { model?: Model; numCtx?: number; askFirst?: boolean; endsWhenTold?: boolean } = {}) {
      const { model = "m1:7b", numCtx = NUM_CTX, askFirst = false, endsWhenTold = true } = sent;
      const turn = new AbortController();
      const request = new AbortController();
      let replyEnds!: () => void;
      const replied = new Promise<void>((resolve) => { replyEnds = resolve; });
      const me: Chat = { model, view: { state: "waiting" }, started: false, over: false, turn, request, replyEnds, done: Promise.resolve() };
      chats.set(id, me);
      me.done = (async () => {
        let reservation: TurnReservation | undefined;
        let release: (() => void) | undefined;
        try {
          reservation = loader.reserve(model);
          const baseUrl = reservation.baseUrl;
          if (baseUrl === undefined) throw new Error("no runtime is ready");
          // chat.send ties its runtime's end to the turn
          const gone = reservation.signal;
          gone.addEventListener("abort", () => { if (endsWhenTold) turn.abort(gone.reason); }, { once: true });
          const plan = async (signal: AbortSignal, context?: AdmitContext): Promise<FitReport> => {
            const running = [...chats.values()].filter((c) => c !== me && c.started && !c.over && !same(c.model, model));
            const planned = await planLoad({ ...fitDeps(baseUrl), baseUrl, model, numCtx, busy: running.map((c) => c.model), signal, ...context?.handoff !== undefined ? { measured: true } : {} });
            const stop = running.filter((c) => planned.stop.some((name) => same(name, c.model)));
            if (askFirst && stop.length > 0) throw new WouldStop(stop.map((c) => c.model));
            return planned.report;
          };
          if (askFirst && [...chats.values()].some((c) => c.started && !c.over)) {
            const ahead = await plan(turn.signal);
            if (ahead.verdict === "refuse" && image.current().state === "off") { me.view = { state: "refused", refusal: ahead.message ?? "", report: ahead }; return; }
          }
          release = await lease.acquire("chat", turn.signal);
          const report = await reservation.admit(numCtx, {
            fit: async (signal, context) => {
              const r = await plan(signal, context);
              if (r.verdict !== "refuse") me.started = true;
              return r;
            },
            signal: turn.signal,
          });
          if (report.verdict === "refuse") { me.view = { state: "refused", refusal: report.message ?? "", report }; return; }
          me.started = true;
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
    /** The Ollama that is loading `model` finishes: a chat waiting on it gets its first token, a preload its answer. */
    async ollamaFinishesLoading(model: Model = "m1:7b") {
      if (!ollamas.system.finish(model) && !ollamas.app.finish(model)) throw new Error(`no Ollama is loading ${model}`);
      await pass();
    },
    /** A reply runs to its end; a turn that is not replying yet ends where it is. */
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
    /** The first key typed in a chat: a hint to load its model (models.load). Its answer, or its refusal, is in preloaded(). */
    async preloads(model: Model = "m1:7b", numCtx = NUM_CTX) {
      preloads.push(loader.load(model, numCtx).catch((e: unknown) => (e instanceof Error ? e : new Error(String(e)))));
      await pass();
    },
    preloaded: async () => Promise.all(preloads),

    /** A person sends a picture. `setup: "other"`: not the setup the last picture ran. */
    async pictureSends(sent: { setup?: "one" | "other" } = {}) {
      const { jobId } = await image.generate({ prompt: "a tree", choice: SETUPS[sent.setup ?? "one"] });
      picture = jobId;
      pictureJobs.push(jobId);
      await pass();
      return jobId;
    },
    /** The last picture's last event (or that of `jobId`). */
    picture: (jobId?: string) => lastOf(jobId ?? picture),
    pictureJobs: () => [...pictureJobs],
    /** ComfyUI stops answering its status, so the next picture waits before its gate with its claim held; comfyAnswers() lets it on. */
    comfyHoldsItsAnswer() {
      comfy.held = new Promise<void>((resolve) => { comfy.release = resolve; });
    },
    async comfyAnswers() {
      comfy.release?.();
      comfy.held = undefined;
      await pass();
    },
    /** ComfyUI finishes loading the setup; the picture is still being made. */
    async comfyFinishesLoading() {
      if (comfy.entry?.state !== "loading") throw new Error("ComfyUI is not loading");
      comfyHolds("in");
      await pass();
    },
    /** The picture is made: ComfyUI holds its setup, and the job saves the file and ends. */
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
    /** The wait a Stop gives ComfyUI to let go of the picture runs out. */
    async pictureStopTimesOut() {
      await pass(CANCEL_WAIT_MS + 1_000);
    },
    /** The longest a stuck picture keeps the card runs out. */
    async stuckHoldRunsOut() {
      await pass(STUCK_HOLD_MS + 2_000);
    },
    /** ComfyUI lets go of the picture it would not stop: the prompt leaves its queue, and a load it was in the middle of is over. */
    async comfyLetsGo() {
      comfy.sticks = false;
      comfy.running = undefined;
      if (comfy.entry?.state === "loading") comfyHolds("in");
      await pass();
    },
    /** Somebody else's job in ComfyUI ends. */
    async othersJobEnds() {
      if (comfy.running === "foreign") comfy.running = undefined;
      await pass();
    },
    /** Somebody else starts a job in the ComfyUI that is running. */
    async othersJobStarts() {
      if (!comfy.up || comfy.running !== undefined) throw new Error("ComfyUI is not free for somebody else's job");
      comfy.running = "foreign";
      if (comfy.entry === undefined) comfyHolds("in");
      await pass();
    },
    /** An Ollama that went on listing `model` after it was asked to unload it lets it go. */
    async slowModelLeaves(model: Model, mode: RuntimeMode = runtime.mode()) {
      ollamas[mode].letGo(model);
      await pass();
    },

    /** A person picks the other runtime in Settings. Whether it went ahead is in switchIsRefused() / switchGoesAhead(). */
    async switchBegins(to: RuntimeMode = runtime.mode() === "system" ? "app" : "system") {
      switchError = undefined;
      switchOver = false;
      switching = runtime.setMode(to);
      switching.then(() => { switchOver = true; }, (e: unknown) => { switchError = e instanceof Error ? e : new Error(String(e)); switchOver = true; });
      await pass();
    },
    /** The wait for the old runtime's turns runs out: the switch is refused. Resolves with why. */
    async switchIsRefused(): Promise<Error> {
      await pass(TURN_DRAIN_MS + 1_000);
      if (switchError === undefined) throw new Error("the switch was not refused");
      return switchError;
    },
    /** The switch is over, on the new runtime. */
    async switchGoesAhead(): Promise<RuntimeStatus> {
      if (switching === undefined) throw new Error("no switch began");
      await until(() => switchOver, "the switch's end");
      if (switchError !== undefined) throw switchError;
      return switching;
    },
    /** The GPU status poll: /api/ps of the current runtime, through the loader. */
    async statusPolls() {
      await loader.residentModels();
      await pass(250);
    },

    /** Another program takes `mib` of the card (or changes what it holds). */
    otherProgramTakes,
    /** Run once, when an Ollama is next asked to unload a model, before it answers. */
    whenNextAskedToLeave(then: () => void) {
      whenAsked = () => { whenAsked = undefined; then(); };
    },
    pass,

    /** The card now: who is on it, what is loading, what is free. */
    card: () => ({
      holders: card.map((e): Holder => ({ name: e.name, mib: e.mib, state: e.state })),
      names: card.map((e) => e.name),
      loading: card.filter((e) => e.state === "loading").map((e) => e.name),
      freeMib: freeMib(),
    }),
    /** The chat models the current runtime's Ollama lists. */
    ollamaLists: (mode: RuntimeMode = runtime.mode()) => ollamas[mode].lists(),
    /** The models any Ollama was asked to unload. */
    askedToLeave: () => rec.asked.map((a) => a.model),
    comfyUp: () => comfy.up,

    /** Ends everything the world started and puts the global fetch back. */
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
