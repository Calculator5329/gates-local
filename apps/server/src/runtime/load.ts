// Models moving into memory, and which of them this app put there.
//
// models.load reads /api/ps first: a model already resident that the app
// did not load is someone else's (a terminal `ollama run`, another app), so
// it reports "ready" and is never preloaded or claimed. Otherwise it runs the
// fit check and, unless it refuses, preloads with an empty /api/generate.
// A chat turn reserves its model synchronously (so models.remove sees it at
// once), then admit() decides, before the chat request goes out, whether the
// turn is a cold load: "loading" is pushed then and "ready" at the first
// content or thinking token. Either way the model joins appLoadedModels(),
// the one list the image lane may unload from. The list is pruned against
// /api/ps whenever this module or the GPU poll reads it, so a model Ollama
// let go of leaves it ("unloaded" push).
//
// One load gate per loader: the residency read, the fit and the load run
// inside it, so a second load measures the memory the first one took. A
// preload holds it until /api/generate completes; a cold turn holds it until
// its first token or its end; a warm turn holds it only for its fit.
//
// A runtime switch bumps the generation (runtimeChanged): the owned list is
// cleared without pushes (models left in an external Ollama are not the
// app's any more) and every completion that started under the old runtime
// is dropped.
import type { FitReport, ModelLoad } from "@gates-local/contracts";
import type { GpuLease } from "../gpu/lease.ts";
import { canonicalTag } from "./recommended.ts";
import { GenerateResponse, decode, parseJson } from "./schemas.ts";
import type { LoadedModel } from "./types.ts";

/**
 * keep_alive for a preload: Ollama's own default, so a preloaded model stays
 * exactly as long as one a turn started (each turn's request resets it).
 */
export const PRELOAD_KEEP_ALIVE = "5m";
/** A cold load of a large model from disk can take minutes. */
const PRELOAD_TIMEOUT_MS = 10 * 60_000;

export type ModelErrorCode = "model-in-use" | "model-removing" | "runtime-not-ready" | "remove-failed";

/** A refused models.* action; the ws layer sends `code` to the client. */
export class ModelActionError extends Error {
  override readonly name = "ModelActionError";
  readonly code: ModelErrorCode;
  constructor(code: ModelErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** admit() gave up because the caller's signal aborted while it waited. */
export class AdmitCancelled extends Error {
  override readonly name = "AdmitCancelled";
}

/**
 * Runs `fn` with the load gate held; the gate is released when `fn` settles.
 * An in-process FIFO mutex: it orders residency reads, fits and loads among
 * the chat claims that share the GPU lease (gpu/lease.ts). A turn's admit
 * runs inside the turn's own lease claim; load() takes its own claim.
 */
export type LoadGate = <T>(fn: () => Promise<T>) => Promise<T>;

export function createFifoGate(): LoadGate {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(fn);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}

export interface TurnLoad {
  /** The turn's first content or thinking token: the model answered. */
  firstToken(): void;
  /** The turn is over, however it ended (also releases a reservation that never streamed). */
  end(): void;
}

export interface AdmitOptions {
  /** The fit check for this turn; default the loader's own `fit`. */
  readonly fit?: () => Promise<FitReport>;
  /** Abort stops waiting for the gate; admit rejects with AdmitCancelled. */
  readonly signal?: AbortSignal;
}

/** A chat turn's hold on its model, from chat.send's first line to the turn's end. */
export interface TurnReservation extends TurnLoad {
  /**
   * Inside the load gate: read /api/ps (is this a cold load?), then fit.
   * Resolves with the fit report once the residency decision is made, before
   * any chat request. A refused or failed admit releases the reservation.
   */
  admit(numCtx: number, options?: AdmitOptions): Promise<FitReport>;
}

export interface ModelLoader {
  load(model: string, numCtx: number): Promise<ModelLoad>;
  /**
   * Synchronous so the turn counts toward inUse() before chat.send's first
   * await. Throws ModelActionError("model-removing") while the model's DELETE runs.
   */
  reserve(model: string): TurnReservation;
  /** A turn holds this model (reserved, fitting or streaming). */
  inUse(model: string): boolean;
  /**
   * models.remove: refuses (model-in-use) while a reservation exists, else
   * marks the model as removing until the returned function is called.
   */
  beginRemove(model: string): () => void;
  /** The runtime switched: forget what the app owned, drop old completions. */
  runtimeChanged(): void;
  /** Models this app loaded that are still resident, by tag. */
  appLoadedModels(): readonly string[];
  /** Drops models no longer in /api/ps; the GPU poll feeds its own reading here. */
  prune(resident: readonly string[]): void;
}

export interface ModelLoaderDeps {
  readonly baseUrl: () => string | undefined;
  readonly push: (load: ModelLoad) => void;
  readonly listLoaded: (baseUrl: string) => Promise<readonly LoadedModel[]>;
  /** The fit check for models.load (and a turn's admit unless it brings its own). */
  readonly fit: (model: string, numCtx: number) => Promise<FitReport>;
  /** The load gate; default an in-process FIFO mutex (see LoadGate). */
  readonly gate?: LoadGate;
  /** models.load holds a shared chat claim, so it never loads beside an image job. */
  readonly lease?: Pick<GpuLease, "run">;
  /** After a load the app caused, so the GPU status refreshes (gpu watcher poke). */
  readonly onLoaded?: () => void;
  readonly log?: (line: string) => void;
}

const removingMessage = (model: string) => `${model} is being removed right now, so it cannot be used. Wait for the removal to finish or pick another model.`;
const runtimeChangedMessage = (model: string) => `The runtime changed while ${model} was loading, so it is not loaded in the new one. Load it again.`;

/** POST /api/generate with an empty prompt; throws with Ollama's words unless it says done. */
async function preload(baseUrl: string, model: string, numCtx: number): Promise<void> {
  const res = await fetch(new URL("/api/generate", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, prompt: "", stream: false, keep_alive: PRELOAD_KEEP_ALIVE, options: { num_ctx: numCtx } }),
    signal: AbortSignal.timeout(PRELOAD_TIMEOUT_MS),
  });
  const text = await res.text();
  const json = parseJson(text);
  const body = json.ok ? decode(GenerateResponse, json.value) : undefined;
  const error = body?.ok ? body.value.error : undefined;
  if (error !== undefined) throw new Error(error);
  if (!res.ok) throw new Error(text.trim() || `HTTP ${res.status}`);
  if (!body?.ok || body.value.done !== true) throw new Error("Ollama answered without saying the model finished loading.");
}

export function createModelLoader(deps: ModelLoaderDeps): ModelLoader {
  const log = deps.log ?? (() => undefined);
  const gate = deps.gate ?? createFifoGate();
  /** Tag -> the num_ctx it was loaded at. */
  const owned = new Map<string, number>();
  const turnsByModel = new Map<string, number>();
  const removing = new Set<string>();
  let generation = 0;

  const send = (load: ModelLoad) => {
    try {
      deps.push(load);
    } catch (e) {
      log(`models.load push failed: ${(e as Error).message}`);
    }
  };

  const loaded = (model: string, numCtx: number) => {
    owned.set(canonicalTag(model), numCtx);
    send({ model, numCtx, state: "ready" });
    deps.onLoaded?.();
  };

  const prune = (resident: readonly string[]) => {
    const here = new Set(resident.map(canonicalTag));
    for (const [tag, numCtx] of owned) {
      if (here.has(tag)) continue;
      owned.delete(tag);
      send({ model: tag, numCtx, state: "unloaded" });
    }
  };

  /** /api/ps names, pruning the owned list on the way; undefined when it cannot be read. */
  const resident = async (baseUrl: string, gen: number): Promise<Set<string> | undefined> => {
    try {
      const names = (await deps.listLoaded(baseUrl)).map((m) => m.name);
      // A reading of the old runtime says nothing about what the app owns now.
      if (gen === generation) prune(names);
      return new Set(names.map(canonicalTag));
    } catch (e) {
      log(`reading /api/ps failed: ${(e as Error).message}`);
      return undefined;
    }
  };

  const refuseRemoving = (model: string) => {
    if (removing.has(canonicalTag(model))) throw new ModelActionError("model-removing", removingMessage(model));
  };

  return {
    async load(model, numCtx) {
      refuseRemoving(model);
      const tag = canonicalTag(model);
      const baseUrl = deps.baseUrl();
      if (baseUrl === undefined) throw new ModelActionError("runtime-not-ready", "Ollama is not running, so no model can be loaded.");
      const gen = generation;
      const dropped = (): ModelLoad => {
        const d: ModelLoad = { model, numCtx, state: "error", message: runtimeChangedMessage(model) };
        send(d);
        return d;
      };
      const claim = <T>(fn: () => Promise<T>): Promise<T> => (deps.lease ? deps.lease.run("chat", undefined, fn) : fn());
      return claim(() => gate(async (): Promise<ModelLoad> => {
        if (gen !== generation) return dropped();
        const here = await resident(baseUrl, gen);
        if (here?.has(tag) && !owned.has(tag)) {
          // Someone else's: say it is ready, never preload it, never claim it.
          const ready: ModelLoad = { model, numCtx, state: "ready", message: `${model} is already in memory, loaded by another program; the app leaves it to that program.` };
          send(ready);
          return ready;
        }
        const report = await deps.fit(model, numCtx);
        if (report.verdict === "refuse") {
          const refused: ModelLoad = { model, numCtx, state: "error", message: report.message ?? `${model} at num_ctx ${numCtx} does not fit.` };
          send(refused);
          return refused;
        }
        send({ model, numCtx, state: "loading" });
        try {
          await preload(baseUrl, model, numCtx);
        } catch (e) {
          const failed: ModelLoad = { model, numCtx, state: "error", message: `Could not load ${model}: ${(e as Error).message}` };
          send(failed);
          return failed;
        }
        if (gen !== generation) return dropped();
        loaded(model, numCtx);
        return { model, numCtx, state: "ready" };
      }));
    },

    reserve(model) {
      refuseRemoving(model);
      const tag = canonicalTag(model);
      turnsByModel.set(tag, (turnsByModel.get(tag) ?? 0) + 1);
      const gen = generation;
      let baseUrl: string | undefined;
      let numCtx = 0;
      let admitting = false;
      let cold = false;
      let answered = false;
      let ended = false;
      let releaseGate: (() => void) | undefined;
      const letGo = () => {
        const r = releaseGate;
        releaseGate = undefined;
        r?.();
      };

      const reservation: TurnReservation = {
        admit(ctx, options = {}) {
          if (admitting) return Promise.reject(new Error("admit runs once per reservation"));
          admitting = true;
          numCtx = ctx;
          baseUrl = deps.baseUrl();
          const fit = options.fit ?? (() => deps.fit(model, ctx));
          const { signal } = options;
          let gone = false;
          const decision = new Promise<FitReport>((resolve, reject) => {
            const onAbort = () => {
              gone = true;
              reject(new AdmitCancelled(`stopped waiting to load ${model}`));
            };
            if (signal?.aborted) onAbort();
            signal?.addEventListener("abort", onAbort, { once: true });
            const done = () => signal?.removeEventListener("abort", onAbort);
            gate(async () => {
              if (gone || ended) return;
              try {
                const here = baseUrl === undefined ? undefined : await resident(baseUrl, gen);
                const report = await fit();
                if (gone || ended) return;
                // Unreadable /api/ps: say nothing rather than guess.
                if (report.verdict !== "refuse" && here !== undefined && !here.has(tag) && gen === generation) {
                  cold = true;
                  send({ model, numCtx: ctx, state: "loading" });
                  const held = new Promise<void>((r) => (releaseGate = r));
                  done();
                  resolve(report);
                  await held;
                  return;
                }
                done();
                resolve(report);
              } catch (e) {
                done();
                reject(e);
              }
            }).catch((e: unknown) => log(`load gate for ${model} failed: ${(e as Error).message}`));
          });
          return decision.then(
            (report) => {
              if (report.verdict === "refuse") reservation.end();
              return report;
            },
            (e: unknown) => {
              reservation.end();
              throw e;
            },
          );
        },
        firstToken() {
          if (answered || ended) return;
          answered = true;
          letGo();
          if (cold && gen === generation) loaded(model, numCtx);
        },
        end() {
          if (ended) return;
          ended = true;
          letGo();
          const left = (turnsByModel.get(tag) ?? 1) - 1;
          if (left > 0) turnsByModel.set(tag, left);
          else turnsByModel.delete(tag);
          if (answered || !cold || baseUrl === undefined) return;
          // Ended before a token (an error or a cancel mid-load): report what is true now.
          const url = baseUrl;
          void resident(url, gen).then((here) => {
            if (gen !== generation) return;
            if (here?.has(tag)) loaded(model, numCtx);
            else send({ model, numCtx, state: "unloaded" });
          });
        },
      };
      return reservation;
    },

    inUse: (model) => (turnsByModel.get(canonicalTag(model)) ?? 0) > 0,

    beginRemove(model) {
      const tag = canonicalTag(model);
      if ((turnsByModel.get(tag) ?? 0) > 0) {
        throw new ModelActionError("model-in-use", `${model} is answering in a chat right now. Stop that reply or wait for it to finish, then remove the model.`);
      }
      if (removing.has(tag)) throw new ModelActionError("model-removing", `${model} is already being removed.`);
      removing.add(tag);
      return () => void removing.delete(tag);
    },

    runtimeChanged() {
      generation++;
      owned.clear();
    },

    appLoadedModels: () => [...owned.keys()],
    prune,
  };
}
