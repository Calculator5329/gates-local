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
// What it never touches: whisper and every other program on the GPU (they are only measured),
// and a running reply's model. An Ollama or ComfyUI the app did not start is asked, never
// stopped, restarted or reconfigured (owner ruling 2026-11-13: an unload request is not a stop).
import type { MemoryState, MemoryThing } from "@gates-local/contracts";
import { setTimeout as delay } from "node:timers/promises";
import { forgetGpuReadings } from "../fit/gpu.ts";
import { createFifoGate, type LoadGate } from "../runtime/load.ts";
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
  readonly listLoaded: (baseUrl: string, signal: AbortSignal) => Promise<readonly LoadedModel[]>;
  /** Models a running reply of this app is using: never asked to leave. */
  readonly replying: () => readonly string[];
  /** The image engine, when image generation is on; bound late (the image module is made after). */
  readonly engine?: () => MemoryEngine | undefined;
  /** The GPU's free bytes now, for the settle after something left; absent: no settle. */
  readonly readFree?: (signal: AbortSignal) => Promise<number>;
  /** A chat model left (the loader forgets it was the app's). */
  readonly onUnloaded?: (model: string) => void;
  readonly onChanged?: (state: MemoryState) => void;
  readonly fetch?: typeof fetch;
  /** The bound on each wait (unload, settle); 20 s unless a test sets it. */
  readonly waitMs?: number;
  readonly pollMs?: number;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
}

export interface MemoryOwner {
  /** The load gate: a handoff, its reading, its fit and its load run inside it. */
  readonly gate: LoadGate;
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
  const gate = createFifoGate();
  let resident: MemoryThing | undefined;
  let handoff: MemoryState["handoff"];
  /** The setup the engine holds; "unknown" until it was asked to free once, or ran a job. */
  let engineHolds: string | "unknown" | "empty" = "unknown";
  let said = "";

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

  const chatLeaves = async (want: Want, signal: AbortSignal, onLeave?: (on: boolean) => void): Promise<{ left: string[]; stayed: string[] | undefined }> => {
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
    const replying = new Set(deps.replying().map(canonicalTag));
    // The model wanted stays, at any context: at another one Ollama replaces it itself, and the fit
    // counts the memory its copy holds (the context asked for may not be the one it runs at).
    const kept = (m: LoadedModel) => want.kind === "chat" && canonicalTag(m.name) === canonicalTag(want.model);
    const busy = listed.filter((m) => !kept(m) && replying.has(canonicalTag(m.name))).map((m) => m.name);
    const asked = listed.filter((m) => !kept(m) && !replying.has(canonicalTag(m.name))).map((m) => m.name);
    if (asked.length === 0) return { left: [], stayed: busy };
    onLeave?.(true);
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
      await delay(pollMs, undefined, { signal });
    }
    const left = asked.filter((m) => !still.has(canonicalTag(m)));
    for (const model of left) deps.onUnloaded?.(model);
    return { left, stayed: [...busy, ...asked.filter((m) => still.has(canonicalTag(m)))] };
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
   * runner's exit by a read.
   */
  const settle = async (signal: AbortSignal) => {
    if (deps.readFree === undefined) return;
    const deadline = now() + waitMs;
    forgetGpuReadings();
    let before = await deps.readFree(signal);
    let flat = 0;
    while (now() < deadline) {
      await delay(pollMs, undefined, { signal });
      forgetGpuReadings();
      const after = await deps.readFree(signal);
      flat = after - before < SETTLED_BYTES ? flat + 1 : 0;
      if (flat >= SETTLED_READS) return;
      before = after;
    }
  };

  return {
    gate,
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
        const chat = await chatLeaves(want, signal, tell);
        const engine = await engineLeaves(want, signal);
        // Told once the engine took the request: a busy or absent engine was asked nothing.
        if (engine === "freed") tell(true);
        if (chat.left.length > 0 || engine === "freed") {
          const was = resident;
          if (was?.kind === "image" && engine === "freed") resident = undefined;
          if (was?.kind === "chat" && chat.left.some((m) => canonicalTag(m) === was.model)) resident = undefined;
          try {
            await settle(signal);
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
