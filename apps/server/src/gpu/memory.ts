// The one owner of what is in memory: one thing at a time.
//
// A thing is a chat model at a context, or the image engine's loaded setup. Every request for a
// thing (a send, models.load, the first key typed, an image job) runs `handoff` inside the load
// gate before it measures:
//
//   leaving    every chat model the Ollama the app talks to lists, other than the one wanted
//              (at any context), gets an unload request (keep_alive 0), whoever loaded it, unless a
//              running reply of this app uses it. The image engine is asked to free its models
//              (POST /free) unless it holds the very setup wanted; it is asked only while its
//              queue is empty, so a job someone else runs is never freed from under them.
//   (wait)     until /api/ps no longer lists what was asked to leave, and the GPU's free memory
//              stops rising, both bounded: what has not left by then is measured as it is.
//   measuring  the caller takes a new reading and decides the fit from it alone.
//   loading    the caller loads the thing; `settled` records it as the one in memory.
//
// It holds the one record of what is loaded (LoadedRecord): the chat models the app's Ollama lists
// and which of them this app loaded. The loader writes it; the GPU status reads it.
//
// What it never touches: whisper and every other program on the GPU (they are only measured),
// and a running reply's model. No runner gets a second model beside a running reply: the plan
// (fit.ts planWith) names that reply in the way, and a send asks before it stops it. An Ollama or ComfyUI the app did not start is asked, never
// stopped, restarted or reconfigured (an unload request is not a stop).
//
// An Ollama that holds one model (the app's own, started with OLLAMA_MAX_LOADED_MODELS=1,
// `holdsOne`) would replace the old model itself when the next one loads, but the plan counts the
// old model's memory as free before it has gone, and a driver that frees slowly then places the new
// one partly in system memory. So a chat handoff asks the old one to leave too, and waits until
// /api/ps no longer lists it and the GPU's free reading has come back to what the plan counted,
// within the fit's VRAM margin (both bounded). The load clears the other models from the record.
// An image asks every chat model to leave as well, since Ollama frees nothing for ComfyUI.
import type { MemoryState, MemoryThing } from "@gates-local/contracts";
import { setTimeout as delay } from "node:timers/promises";
import { VRAM_SAFETY_MARGIN_BYTES } from "../fit/constants.ts";
import { forgetGpuReadings } from "../fit/gpu.ts";
import { sendSpan } from "../chat/send-times.ts";
import { createFifoGate, type LoadGate } from "./gate.ts";
import { canonicalTag } from "../runtime/recommended.ts";
import type { LoadedModel } from "../runtime/types.ts";

/** A thing a request wants in memory. `setup` names the image preset and size (setupKey). */
export type Want = { readonly kind: "chat"; readonly model: string; readonly numCtx: number } | { readonly kind: "image"; readonly setup: string };

/** What the image engine did when asked to leave. */
export type EngineLeave = "freed" | "busy" | "absent";

export interface MemoryEngine {
  /**
   * Let go of every model: POST /free when the queue is empty ("freed"); "busy" when something is
   * queued or running (nothing sent); "absent" when no ComfyUI on this computer answers.
   */
  leave(signal: AbortSignal): Promise<EngineLeave>;
}

export interface Handoff {
  /** Chat models asked to leave that /api/ps no longer lists. */
  readonly left: readonly string[];
  /** Chat models still listed when the wait ended: asked and slow, or a running reply's. Undefined: /api/ps could not be read. */
  readonly stayed: readonly string[] | undefined;
  /** The image engine: freed, busy (nothing sent), absent, kept (it holds the setup wanted) or idle (it holds nothing). */
  readonly engine: EngineLeave | "kept" | "idle";
}

export interface MemoryOwnerDeps {
  /** The Ollama the app talks to now; undefined when none is ready. */
  readonly ollamaUrl: () => string | undefined;
  /** That Ollama holds one model at a time and replaces it itself (RuntimeStatus.holdsOne); absent: false. */
  readonly holdsOne?: () => boolean;
  readonly listLoaded: (baseUrl: string, signal: AbortSignal) => Promise<readonly LoadedModel[]>;
  /** Models a running reply of this app is using: never asked to leave. */
  readonly replying: () => readonly string[];
  /** The image engine, when image generation is on; bound late (the image module is made after). */
  readonly engine?: () => MemoryEngine | undefined;
  /** The GPU's free bytes now, for the settle after something left; absent, or undefined (no card to read): no settle. */
  readonly readFree?: (signal: AbortSignal) => Promise<number | undefined>;
  /** A chat model left (the loader forgets it was the app's). */
  readonly onUnloaded?: (model: string) => void;
  readonly onChanged?: (state: MemoryState) => void;
  readonly fetch?: typeof fetch;
  /** The bound on each wait (unload, settle); 20 s unless a test sets it. */
  readonly waitMs?: number;
  readonly pollMs?: number;
  /** The fit's VRAM margin: free memory within this of what the plan counted has come back. */
  readonly marginBytes?: number;
  readonly now?: () => number;
  /** The pause between reads; a test passes one that moves its fake clock. */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly log?: (line: string) => void;
  /** Tests only (gpu/rules.test.ts): turns one guard off, so the test that needs it is seen failing. */
  readonly faultForTest?: "ask-replying-models";
}

/**
 * The one record of the chat models in memory: what the app's Ollama last listed, and which of
 * them this app loaded, at the num_ctx it loaded them at. The memory owner holds it; the loader
 * writes it from its /api/ps readings and loads, and the GPU status reads it.
 */
export interface LoadedRecord {
  /** The chat models the last /api/ps of the current runtime listed, by tag. */
  listed(): readonly string[];
  /** The listed models this app loaded, by tag. */
  ours(): readonly string[];
  /** The num_ctx this app loaded `model` at; undefined when the app did not load it. */
  oursAt(model: string): number | undefined;
  /**
   * This app loaded `model` at `numCtx`: it is listed and the app's. In an Ollama that holds one
   * model, nothing else is listed any more; returns the app's models that left so, with their num_ctx.
   */
  loaded(model: string, numCtx: number): readonly (readonly [string, number])[];
  /** `model` left (an unload): it is no longer listed; returns the num_ctx when it was the app's. */
  left(model: string): number | undefined;
  /** A new /api/ps of the current runtime; returns the app's models it no longer lists, with their num_ctx. */
  observe(listed: readonly Pick<LoadedModel, "name">[]): readonly (readonly [string, number])[];
  /**
   * A runtime switch began: nothing is known about what the new runtime holds. Returns what the
   * record held, for a switch that is then refused (restore).
   */
  clear(): LoadedSnapshot;
  /** The switch was refused and the old runtime stays: what `clear` took is the record again. */
  restore(kept: LoadedSnapshot): void;
}

/** What a LoadedRecord held when a switch cleared it: the listed tags, and the app's with their num_ctx. */
export interface LoadedSnapshot {
  readonly listed: readonly string[];
  readonly ours: readonly (readonly [string, number])[];
}

/** `kept` without `model`: it left while the switch was deciding. */
export function snapshotWithout(kept: LoadedSnapshot, model: string): LoadedSnapshot {
  const tag = canonicalTag(model);
  return { listed: kept.listed.filter((t) => t !== tag), ours: kept.ours.filter(([t]) => t !== tag) };
}

/** `holdsOne`: the Ollama it records holds one model at a time, so a load replaces whatever was listed. */
export function createLoadedRecord(holdsOne: () => boolean = () => false): LoadedRecord {
  let listed = new Set<string>();
  /** Tag -> the num_ctx the app loaded it at. */
  const ours = new Map<string, number>();
  return {
    listed: () => [...listed],
    ours: () => [...ours.keys()],
    oursAt: (model) => ours.get(canonicalTag(model)),
    loaded(model, numCtx) {
      const tag = canonicalTag(model);
      const one = holdsOne();
      const gone = one ? [...ours].filter(([t]) => t !== tag) : [];
      if (one) {
        listed = new Set();
        ours.clear();
      }
      listed.add(tag);
      ours.set(tag, numCtx);
      return gone;
    },
    left(model) {
      const tag = canonicalTag(model);
      listed.delete(tag);
      const numCtx = ours.get(tag);
      ours.delete(tag);
      return numCtx;
    },
    observe(models) {
      listed = new Set(models.map((m) => canonicalTag(m.name)));
      const gone = [...ours].filter(([tag]) => !listed.has(tag));
      for (const [tag] of gone) ours.delete(tag);
      return gone;
    },
    clear() {
      const kept: LoadedSnapshot = { listed: [...listed], ours: [...ours] };
      listed = new Set();
      ours.clear();
      return kept;
    },
    restore(kept) {
      listed = new Set(kept.listed);
      ours.clear();
      for (const [tag, numCtx] of kept.ours) ours.set(tag, numCtx);
    },
  };
}

export interface MemoryOwner {
  /** The load gate: a handoff, its reading, its fit and its load run inside it. */
  readonly gate: LoadGate;
  /** The one record of the chat models in memory and which of them are the app's. */
  readonly loaded: LoadedRecord;
  /**
   * Inside the gate: everything but `want` is asked to leave, and the wait for it ends.
   * `onLeave(true)` is told when something was asked to leave, `onLeave(false)` once the wait ended.
   */
  handoff(want: Want, signal: AbortSignal, options?: { onLeave?: (on: boolean) => void }): Promise<Handoff>;
  /** The handoff moved on: the caller is measuring, or loading. */
  stage(want: Want, stage: "measuring" | "loading"): void;
  /** `want` is in memory now (a load ended, or it was resident already). */
  settled(want: Want): void;
  /** The handoff ended without a load (refused, cancelled, failed). */
  ended(): void;
  /** An /api/ps reading of the current runtime: a chat model that left is no longer resident. */
  observe(listed: readonly LoadedModel[]): void;
  /** The image engine stopped (the idle stop, an exit): it holds nothing. */
  engineGone(): void;
  status(): MemoryState;
}

/** A refusal while ComfyUI ran a job: it was not asked to free its memory, and the sentence says so. */
export const ENGINE_BUSY_NOTE = "ComfyUI is running another job, so the app did not ask it to free its memory; try again when it finishes.";

/** The setup key a handoff names an image by: the preset and its size. */
export const imageSetup = (choice: { readonly preset: string; readonly width: number; readonly height: number }): string => `${choice.preset} ${choice.width}x${choice.height}`;

/** How long each wait (the unload, the settle) lasts at most. */
export const LEAVE_WAIT_MS = 20_000;
export const LEAVE_POLL_MS = 250;
/** Free memory that rose by less than this between two reads has settled. */
const SETTLED_BYTES = 64 * 1024 ** 2;
/** Flat reads in a row that end the settle. */
const SETTLED_READS = 2;

const thing = (want: Want, since?: number): MemoryThing =>
  want.kind === "chat" ? { kind: "chat", model: canonicalTag(want.model), numCtx: want.numCtx, ...since === undefined ? {} : { since } } : { kind: "image", setup: want.setup, ...since === undefined ? {} : { since } };

export function createMemoryOwner(deps: MemoryOwnerDeps): MemoryOwner {
  const log = deps.log ?? (() => undefined);
  const now = deps.now ?? Date.now;
  const waitMs = deps.waitMs ?? LEAVE_WAIT_MS;
  const pollMs = deps.pollMs ?? LEAVE_POLL_MS;
  const marginBytes = deps.marginBytes ?? VRAM_SAFETY_MARGIN_BYTES;
  const sleep = deps.sleep ?? ((ms: number, signal: AbortSignal) => delay(ms, undefined, { signal }));
  const gate = createFifoGate();
  let resident: MemoryThing | undefined;
  let handoff: MemoryState["handoff"];
  /** The setup the engine holds; "unknown" until it was asked to free once, or ran a job. */
  let engineHolds: string | "unknown" | "empty" = "unknown";
  let said = "";
  /** A chat model wanted from an Ollama that holds one model: the settle waits for what the plan counted as free. */
  const oneChat = (want: Want) => want.kind === "chat" && deps.holdsOne?.() === true;

  const state = (): MemoryState => ({ ...resident === undefined ? {} : { resident }, ...handoff === undefined ? {} : { handoff } });
  const changed = () => {
    const next = state();
    const key = JSON.stringify(next);
    if (key === said) return;
    said = key;
    try {
      deps.onChanged?.(next);
    } catch (e) {
      log(`memory.changed push failed: ${(e as Error).message}`);
    }
  };

  /** keep_alive 0: Ollama unloads the model once no request uses it. */
  const unload = async (baseUrl: string, model: string, signal: AbortSignal): Promise<boolean> => {
    try {
      const res = await (deps.fetch ?? fetch)(new URL("/api/generate", baseUrl), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, keep_alive: 0 }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      });
      await res.arrayBuffer();
      if (!res.ok) log(`unloading ${model}: Ollama HTTP ${res.status}`);
      return res.ok;
    } catch (e) {
      signal.throwIfAborted();
      log(`unloading ${model} failed: ${(e as Error).message}`);
      return false;
    }
  };

  /** The GPU's free bytes now, from a fresh reading; undefined with no card to read. */
  const freeNow = async (signal: AbortSignal) => {
    forgetGpuReadings();
    return await deps.readFree?.(signal);
  };

  const chatLeaves = async (want: Want, signal: AbortSignal, onLeave?: (on: boolean) => void): Promise<{ left: string[]; stayed: string[] | undefined; target?: number }> => {
    const baseUrl = deps.ollamaUrl();
    if (baseUrl === undefined) return { left: [], stayed: [] };
    let listed: readonly LoadedModel[];
    try {
      listed = await deps.listLoaded(baseUrl, signal);
    } catch (e) {
      signal.throwIfAborted();
      log(`reading /api/ps before a handoff failed: ${(e as Error).message}`);
      return { left: [], stayed: undefined };
    }
    const replying = new Set(deps.faultForTest === "ask-replying-models" ? [] : deps.replying().map(canonicalTag));
    // The model wanted stays, at any context: at another one Ollama replaces it itself, and the fit
    // counts the memory its copy holds (the context asked for may not be the one it runs at).
    const kept = (m: LoadedModel) => want.kind === "chat" && canonicalTag(m.name) === canonicalTag(want.model);
    const busy = listed.filter((m) => !kept(m) && replying.has(canonicalTag(m.name))).map((m) => m.name);
    const asked = listed.filter((m) => !kept(m) && !replying.has(canonicalTag(m.name))).map((m) => m.name);
    if (asked.length === 0) return { left: [], stayed: busy };
    onLeave?.(true);
    // An Ollama that holds one model: the fit counts what the old ones hold as free (fit.ts
    // planWith), so the settle waits for the card to give that much back, within the margin.
    const before = oneChat(want) ? await freeNow(signal) : undefined;
    const held = listed.filter((m) => asked.includes(m.name)).reduce((sum, m) => sum + m.sizeVramBytes, 0);
    const target = before === undefined ? {} : { target: before + held };
    for (const model of asked) await unload(baseUrl, model, signal);
    // Ollama answers the unload before its runner has gone: read until /api/ps no longer lists them.
    const deadline = now() + waitMs;
    let still = new Set(asked.map(canonicalTag));
    for (;;) {
      try {
        const after = await deps.listLoaded(baseUrl, signal);
        const here = new Set(after.map((m) => canonicalTag(m.name)));
        still = new Set([...still].filter((tag) => here.has(tag)));
      } catch (e) {
        signal.throwIfAborted();
        log(`reading /api/ps after an unload failed: ${(e as Error).message}`);
      }
      if (still.size === 0 || now() >= deadline) break;
      await sleep(pollMs, signal);
    }
    const left = asked.filter((m) => !still.has(canonicalTag(m)));
    // The wait above can outlast a switch of runtime: what left the old one says nothing about
    // the one in use now, which may list a model of the same name. No address (a switch is still
    // deciding): the record is told, so a refused switch does not put the model back.
    const url = deps.ollamaUrl();
    if (url === undefined || url === baseUrl) for (const model of left) deps.onUnloaded?.(model);
    return { left, stayed: [...busy, ...asked.filter((m) => still.has(canonicalTag(m)))], ...target };
  };

  const engineLeaves = async (want: Want, signal: AbortSignal): Promise<Handoff["engine"]> => {
    if (want.kind === "image" && engineHolds === want.setup) return "kept";
    if (engineHolds === "empty") return "idle";
    const engine = deps.engine?.();
    if (engine === undefined) return "absent";
    let answer: EngineLeave;
    try {
      answer = await engine.leave(signal);
    } catch (e) {
      signal.throwIfAborted();
      log(`asking the image engine to free its memory failed: ${(e as Error).message}`);
      return "busy";
    }
    if (answer !== "busy") engineHolds = "empty";
    return answer;
  };

  /**
   * After something left: read the GPU until its free memory stopped rising for SETTLED_READS reads
   * in a row, or the bound passes. One flat read is not enough: the driver's number can lag the
   * runner's exit by a read. With a `target` (what the plan counts as free), until the reading is
   * within the margin of it instead: a driver that frees slowly can hold still on the way.
   */
  const settle = async (signal: AbortSignal, target?: number) => {
    if (deps.readFree === undefined) return;
    const deadline = now() + waitMs;
    let before = await freeNow(signal);
    // a computer with no card has no GPU memory to wait for: the models run from system memory
    if (before === undefined) return;
    if (target !== undefined) {
      while (before < target - marginBytes && now() < deadline) {
        await sleep(pollMs, signal);
        const after = await freeNow(signal);
        if (after === undefined) return;
        before = after;
      }
      return;
    }
    let flat = 0;
    while (now() < deadline) {
      await sleep(pollMs, signal);
      const after = await freeNow(signal);
      if (after === undefined) return;
      flat = after - before < SETTLED_BYTES ? flat + 1 : 0;
      if (flat >= SETTLED_READS) return;
      before = after;
    }
  };

  return {
    gate,
    loaded: createLoadedRecord(() => deps.holdsOne?.() === true),
    async handoff(want, signal, options = {}) {
      handoff = { to: thing(want), stage: "leaving" };
      changed();
      let told = false;
      const tell = (on: boolean) => {
        if (on === told) return;
        told = on;
        options.onLeave?.(on);
      };
      try {
        const chat = await sendSpan("chat-leave", () => chatLeaves(want, signal, tell));
        const engine = await sendSpan("engine-leave", () => engineLeaves(want, signal));
        // Told once the engine took the request: a busy or absent engine was asked nothing.
        if (engine === "freed") tell(true);
        if (chat.left.length > 0 || engine === "freed") {
          const was = resident;
          if (was?.kind === "image" && engine === "freed") resident = undefined;
          if (was?.kind === "chat" && chat.left.some((m) => canonicalTag(m) === was.model)) resident = undefined;
          try {
            await sendSpan("settle", () => settle(signal, chat.target));
          } catch (e) {
            signal.throwIfAborted();
            log(`reading the GPU after a handoff failed: ${(e as Error).message}`);
          }
          forgetGpuReadings();
        }
        tell(false);
        handoff = { to: thing(want), stage: "measuring" };
        changed();
        return { left: chat.left, stayed: chat.stayed, engine };
      } catch (e) {
        tell(false);
        handoff = undefined;
        changed();
        throw e;
      }
    },
    stage(want, stage) {
      handoff = { to: thing(want), stage };
      changed();
    },
    settled(want) {
      const was = resident;
      const same = was?.kind === "chat" ? want.kind === "chat" && was.model === canonicalTag(want.model) && was.numCtx === want.numCtx : was?.kind === "image" && want.kind === "image" && was.setup === want.setup;
      if (!same) resident = thing(want, now());
      if (want.kind === "image") engineHolds = want.setup;
      handoff = undefined;
      changed();
    },
    ended() {
      // An image that failed while loading may have left weights in the engine: what it holds is unknown again.
      if (handoff?.to.kind === "image" && handoff.stage === "loading") engineHolds = "unknown";
      handoff = undefined;
      changed();
    },
    observe(listed) {
      if (resident?.kind === "chat") {
        const model = canonicalTag(resident.model);
        if (listed.some((m) => canonicalTag(m.name) === model)) return;
        resident = undefined;
      }
      // A chat model in memory that the app did not ask for (another program's, or one loaded
      // before the app started) is what is in memory all the same.
      if (resident === undefined && listed.length > 0) {
        const first = listed[0]!;
        resident = { kind: "chat", model: canonicalTag(first.name), ...first.contextLength === undefined ? {} : { numCtx: first.contextLength }, since: now() };
      }
      changed();
    },
    engineGone() {
      engineHolds = "empty";
      if (resident?.kind === "image") resident = undefined;
      changed();
    },
    status: state,
  };
}
