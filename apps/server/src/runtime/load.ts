// Models moving into memory, and which of them this app put there.
//
// models.load reads /api/ps first: a model already resident that the app
// did not load is someone else's (a terminal `ollama run`, another app), so
// it reports "ready" and is never preloaded or claimed. An /api/ps that
// cannot be read is not "nothing loaded": the load refuses rather than claim
// a model that may be someone else's. Otherwise it runs the fit check and,
// unless it refuses or is already resident at that context, preloads with an empty /api/generate.
// A chat turn reserves its model synchronously (so models.remove sees it at
// once), then admit() decides, before the chat request goes out, whether the
// turn is a cold load: "loading" is pushed then and "ready" at the first
// content or thinking token. A cold load joins appLoadedModels(); any turn's
// first token puts its model in `used`, so a model that was warm before the
// app started still counts as the app's when an image needs its memory
// (imageMayUnload(), the one list the image lane may unload from; in an
// Ollama the app started, everything /api/ps lists). loadedOrAnswered() is the
// two together, and the GPU status marks exactly those (or, in the app's own
// Ollama, every resident model) unprotected, so the picker says what an image
// will free. A tag joining `used` pokes the GPU status. Both are pruned against
// /api/ps whenever this module reads it (the GPU poll reads it here too, via
// residentModels()), so a model Ollama let go of leaves both (an owned one
// with an "unloaded" push).
// A reading of a runtime switched away from prunes nothing. A preload takes
// the same per-model reservation as a turn, so models.remove refuses while
// either runs.
//
// One load gate per loader: the residency read, the fit and the load run
// inside it, so a second load measures the memory the first one took. A
// preload holds it until /api/generate completes; a cold turn holds it until
// its first token or its end. A models.load for a model already loading at
// the same context joins that load and gets its one answer, so two chats
// asking for one model never queue a second residency read, fit or
// /api/generate behind the first. A turn releases it after its fit only when
// /api/ps proves the model resident at the turn's num_ctx; anything less
// (unreadable, absent, another context: Ollama may reload) holds it too.
//
// Every load and reservation captures the runtime once: its generation and
// base URL. Its fit, residency read and generate all go to that URL, and
// after every await a changed generation stops it (no request, nothing
// owned). A runtime switch (runtimeChanged .. runtimeSettled) refuses new
// work, clears the owned and used lists without pushes (models left in an external
// Ollama are not the app's any more), aborts the old runtime's preloads and
// waiting admissions, and ends every open "loading" notice with an error.
// close() refuses new work and aborts and drains every preload, so a
// shutdown never waits on a cold load holding its GPU claim.
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

export type ModelErrorCode = "model-in-use" | "model-removing" | "runtime-not-ready" | "runtime-switching" | "shutting-down" | "remove-failed";

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
  /**
   * The fit check for this turn; default the loader's own `fit` against
   * `baseUrl`. `signal` aborts when the turn stops waiting, the runtime
   * switches or the loader closes.
   */
  readonly fit?: (signal: AbortSignal) => Promise<FitReport>;
  /** Abort stops waiting for the gate; admit rejects with AdmitCancelled. */
  readonly signal?: AbortSignal;
}

/** A chat turn's hold on its model, from chat.send's first line to the turn's end. */
export interface TurnReservation extends TurnLoad {
  /** The runtime captured at reserve(): the turn's fit and chat go here (undefined: none ready). */
  readonly baseUrl: string | undefined;
  /**
   * Aborts once that runtime is gone (a switch began, or the loader closed)
   * and stays aborted until end(): at admission, the capability lookup,
   * streaming and tool rounds alike. chat.send ties it to the turn.
   */
  readonly signal: AbortSignal;
  /**
   * After admit: /api/ps proved the model absent, so this turn loads it and it is ready at the
   * turn's first token (models.load says "loading" until then). False when it was resident, or
   * when residency could not be read.
   */
  readonly cold: boolean;
  /**
   * Inside the load gate: read /api/ps (is this a cold load?), then fit.
   * Resolves with the fit report once the residency decision is made, before
   * any chat request. A refused or failed admit releases the reservation.
   * Rejects with ModelActionError("runtime-switching") once the runtime
   * captured at reserve() is gone, including while it waits for the gate.
   */
  admit(numCtx: number, options?: AdmitOptions): Promise<FitReport>;
}

export interface ModelLoader {
  /** Throws ModelActionError while the model is removed, the runtime switches or the loader closed. */
  load(model: string, numCtx: number): Promise<ModelLoad>;
  /**
   * Synchronous so the turn counts toward inUse() before chat.send's first
   * await. Throws ModelActionError("model-removing") while the model's DELETE
   * runs, "runtime-switching" during a switch, "shutting-down" after close().
   */
  reserve(model: string): TurnReservation;
  /** A turn or a preload holds this model (reserved, queued, fitting, loading or streaming). */
  inUse(model: string): boolean;
  /** Every model inUse() is true for, by tag: the busy ones a preload's fit plan never reclaims. */
  busyModels(): string[];
  /**
   * models.remove: refuses (model-in-use) while a reservation exists, else
   * marks the model as removing until the returned function is called.
   */
  beginRemove(model: string): () => void;
  /**
   * A switch began (before the old runtime stops): forget what the app
   * owned, drop the old runtime's work, refuse new work until runtimeSettled().
   */
  runtimeChanged(): void;
  /**
   * Resolves once every turn whose runtime is gone (aborted by
   * runtimeChanged() or close()) has called end(). A switch waits on this
   * before it stops the old runtime.
   */
  turnsEnded(): Promise<void>;
  /** The new runtime's ensure settled: loads and turns may start again. */
  runtimeSettled(): void;
  /** Shutdown: refuse new work, abort every preload, resolve once all have settled. */
  close(): Promise<void>;
  /** Models this app loaded that are still resident, by tag. */
  appLoadedModels(): readonly string[];
  /** The models this app loaded and the ones a turn of it answered on, by tag, without reading /api/ps. */
  loadedOrAnswered(): readonly string[];
  /**
   * What an image job may unload to make room, by tag: the models this app loaded, the ones a
   * chat turn of this app answered on since the start (warm before it, too), and, in an Ollama
   * the app started, every model /api/ps lists. A model no turn of this app touched in an Ollama
   * the app did not start is never in it.
   */
  imageMayUnload(): Promise<readonly string[]>;
  /** The image job unloaded `model` (keep_alive 0): it is neither loaded nor used by the app any more. */
  unloaded(model: string): void;
  /**
   * The GPU poll's /api/ps of the current runtime, pruning the owned list on the way. Empty
   * when no runtime is ready, the read fails, or the runtime changed while it was in flight:
   * a reading of the old runtime says nothing about the GPU or what the app owns now.
   */
  residentModels(): Promise<readonly LoadedModel[]>;
  /** Drops models not in `resident`; the image module's unloads land here (not /api/ps readings). */
  prune(resident: readonly string[]): void;
}

export interface ModelLoaderDeps {
  readonly baseUrl: () => string | undefined;
  readonly push: (load: ModelLoad) => void;
  /** /api/ps; `signal` ends the read (shutdown, a runtime switch). */
  readonly listLoaded: (baseUrl: string, signal: AbortSignal) => Promise<readonly LoadedModel[]>;
  /**
   * The fit check for models.load (and a turn's admit unless it brings its
   * own), against the captured runtime; `signal` ends every request and
   * child process it runs.
   */
  readonly fit: (model: string, numCtx: number, baseUrl: string, signal: AbortSignal) => Promise<FitReport>;
  /** The load gate; default an in-process FIFO mutex (see LoadGate). */
  readonly gate?: LoadGate;
  /** models.load holds a shared chat claim, so it never loads beside an image job. */
  readonly lease?: Pick<GpuLease, "run">;
  /** After a load the app caused or a model joining `used`, so the GPU status refreshes (gpu watcher poke). */
  readonly onLoaded?: () => void;
  /** The current Ollama is one this app started (runtime owner "app"): every model in it is the app's. */
  readonly ownsRuntime?: () => boolean;
  readonly log?: (line: string) => void;
}

const removingMessage = (model: string) => `${model} is being removed right now, so it cannot be used. Wait for the removal to finish or pick another model.`;
export const RUNTIME_SWITCHING_MESSAGE = "The runtime is changing. Try again in a moment.";
export const RUNTIME_CHANGED_MESSAGE = "The runtime changed while this model was loading.";
export const PS_UNREADABLE_MESSAGE = "Could not read which models Ollama has loaded, so the app did not load this one. Try again.";
const SHUTTING_DOWN_MESSAGE = "The app is shutting down, so no model can be loaded.";
const SHUTDOWN_STOPPED_MESSAGE = "The app is shutting down, so this model's load was stopped.";
const switched = () => new ModelActionError("runtime-switching", RUNTIME_SWITCHING_MESSAGE);

/** POST /api/generate with an empty prompt; throws with Ollama's words unless it says done. */
async function preload(baseUrl: string, model: string, numCtx: number, signal: AbortSignal): Promise<void> {
  const res = await fetch(new URL("/api/generate", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, prompt: "", stream: false, keep_alive: PRELOAD_KEEP_ALIVE, options: { num_ctx: numCtx } }),
    signal: AbortSignal.any([AbortSignal.timeout(PRELOAD_TIMEOUT_MS), signal]),
  });
  const text = await res.text();
  const json = parseJson(text);
  const body = json.ok ? decode(GenerateResponse, json.value) : undefined;
  const error = body?.ok ? body.value.error : undefined;
  if (error !== undefined) throw new Error(error);
  if (!res.ok) throw new Error(text.trim() || `HTTP ${res.status}`);
  if (!body?.ok || body.value.done !== true) throw new Error("Ollama answered without saying the model finished loading.");
}

type Residency = { readonly ok: true; readonly models: ReadonlyMap<string, LoadedModel> } | { readonly ok: false };

/** A pushed "loading" waiting for its one terminal state. */
interface Notice {
  readonly model: string;
  readonly numCtx: number;
  end?: ModelLoad;
}

export function createModelLoader(deps: ModelLoaderDeps): ModelLoader {
  const log = deps.log ?? (() => undefined);
  const gate = deps.gate ?? createFifoGate();
  /** Tag -> the num_ctx it was loaded at. */
  const owned = new Map<string, number>();
  /**
   * Tags a chat turn of this app got a first token from since the start: warm models it did not
   * load count too. Pruned against /api/ps with `owned`, cleared on a runtime switch.
   */
  const used = new Set<string>();
  const loadedOrAnswered = (): readonly string[] => [...new Set([...owned.keys(), ...used])];
  /** Tag -> reservations (turns and preloads) on it. */
  const reservations = new Map<string, number>();
  const removing = new Set<string>();
  const notices = new Set<Notice>();
  const pendingLoads = new Set<Promise<ModelLoad>>();
  /** Tag -> the load running for it: a request at the same context and runtime joins it and gets its answer. */
  const running = new Map<string, { readonly numCtx: number; readonly gen: number; readonly run: Promise<ModelLoad> }>();
  let generation = 0;
  let switching = false;
  let closed = false;
  /** Aborted when the current generation ends (switch) or the loader closes. */
  let current = new AbortController();
  /** Turns from reserve() to end(): `gone` aborts with their runtime; `ended` settles at end(). */
  const turns = new Set<{ readonly gone: AbortController; readonly ended: Promise<void> }>();

  const send = (load: ModelLoad) => {
    try {
      deps.push(load);
    } catch (e) {
      log(`models.load push failed: ${(e as Error).message}`);
    }
  };

  const openNotice = (model: string, numCtx: number): Notice => {
    const notice: Notice = { model, numCtx };
    notices.add(notice);
    send({ model, numCtx, state: "loading" });
    return notice;
  };
  /** Ends `notice` with `end` unless it already ended; returns the state it ended with. */
  const closeNotice = (notice: Notice, end: ModelLoad): ModelLoad => {
    if (notice.end !== undefined) return notice.end;
    notice.end = end;
    notices.delete(notice);
    send(end);
    return end;
  };

  const hold = (tag: string) => reservations.set(tag, (reservations.get(tag) ?? 0) + 1);
  const letGoOf = (tag: string) => {
    const left = (reservations.get(tag) ?? 1) - 1;
    if (left > 0) reservations.set(tag, left);
    else reservations.delete(tag);
  };

  const prune = (resident: readonly string[]) => {
    const here = new Set(resident.map(canonicalTag));
    for (const tag of used) if (!here.has(tag)) used.delete(tag);
    for (const [tag, numCtx] of owned) {
      if (here.has(tag)) continue;
      owned.delete(tag);
      send({ model: tag, numCtx, state: "unloaded" });
    }
  };

  /** The GPU poll's last logged /api/ps failure; cleared when a read succeeds. */
  let pollFailure: string | undefined;

  /**
   * /api/ps by tag, pruning the owned list on the way when `gen` is still current. A `poll` read
   * (every 3 s) logs nothing when cancelled and a failure only when it is not the one last logged.
   */
  const residency = async (baseUrl: string, gen: number, signal: AbortSignal, poll = false): Promise<Residency> => {
    try {
      const loaded = await deps.listLoaded(baseUrl, signal);
      pollFailure = undefined;
      // A reading of the old runtime says nothing about what the app owns now.
      if (gen === generation) prune(loaded.map((m) => m.name));
      return { ok: true, models: new Map(loaded.map((m) => [canonicalTag(m.name), m])) };
    } catch (e) {
      const message = (e as Error).message;
      if (poll && (signal.aborted || message === pollFailure)) return { ok: false };
      if (poll) pollFailure = message;
      log(`reading /api/ps failed: ${message}`);
      return { ok: false };
    }
  };

  /** New work is refused while closed, switching or removing this model. */
  const refuseNew = (model: string) => {
    if (closed) throw new ModelActionError("shutting-down", SHUTTING_DOWN_MESSAGE);
    if (switching) throw new ModelActionError("runtime-switching", RUNTIME_SWITCHING_MESSAGE);
    if (removing.has(canonicalTag(model))) throw new ModelActionError("model-removing", removingMessage(model));
  };

  const loadModel = async (model: string, requested: number, baseUrl: string, gen: number, signal: AbortSignal): Promise<ModelLoad> => {
    const tag = canonicalTag(model);
    let notice: Notice | undefined;
    // The size the model takes, once the fit has said so; what was asked for until then.
    let numCtx = requested;
    const finish = (end: ModelLoad): ModelLoad => {
      if (notice !== undefined) return closeNotice(notice, end);
      send(end);
      return end;
    };
    /** Why this load must stop now, if it must: the runtime it captured is gone, or the loader closed. */
    const stopped = (): ModelLoad | undefined => {
      if (gen !== generation) return { model, numCtx, state: "error", message: RUNTIME_CHANGED_MESSAGE };
      if (signal.aborted) return { model, numCtx, state: "error", message: SHUTDOWN_STOPPED_MESSAGE };
      return undefined;
    };
    const inGate = async (): Promise<ModelLoad> => {
      const before = stopped();
      if (before) return finish(before);
      if (removing.has(tag)) return finish({ model, numCtx, state: "error", message: removingMessage(model) });
      const here = await residency(baseUrl, gen, signal);
      const afterPs = stopped();
      if (afterPs) return finish(afterPs);
      if (!here.ok) return finish({ model, numCtx, state: "error", message: PS_UNREADABLE_MESSAGE });
      if (here.models.has(tag) && !owned.has(tag)) {
        // Someone else's: say it is ready, never preload it, never claim it.
        return finish({ model, numCtx, state: "ready", message: `${model} is already in memory, loaded by another program; the app leaves it to that program.` });
      }
      const report = await deps.fit(model, numCtx, baseUrl, signal);
      const afterFit = stopped();
      if (afterFit) return finish(afterFit);
      numCtx = report.numCtx;
      if (report.verdict === "refuse") return finish({ model, numCtx, state: "error", message: report.message ?? `${model} at num_ctx ${numCtx} does not fit.` });
      // Empty generate uses a runner slot too. A redundant preload could wait
      // behind its reply while holding the load gate needed by another chat.
      if (here.models.get(tag)?.contextLength === numCtx) return finish({ model, numCtx, state: "ready" });
      notice = openNotice(model, numCtx);
      try {
        await preload(baseUrl, model, numCtx, signal);
      } catch (e) {
        return finish(stopped() ?? { model, numCtx, state: "error", message: `Could not load ${model}: ${(e as Error).message}` });
      }
      const afterLoad = stopped();
      if (afterLoad) return finish(afterLoad);
      owned.set(tag, numCtx);
      const ready = finish({ model, numCtx, state: "ready" });
      deps.onLoaded?.();
      return ready;
    };
    try {
      return await (deps.lease ? deps.lease.run("chat", signal, () => gate(inGate)) : gate(inGate));
    } catch (e) {
      // The GPU claim was given up before it was granted (switch or shutdown), or the fit threw.
      return finish(stopped() ?? { model, numCtx, state: "error", message: `Could not load ${model}: ${(e as Error).message}` });
    }
  };

  const loaded = (model: string, numCtx: number, notice: Notice | undefined) => {
    owned.set(canonicalTag(model), numCtx);
    const ready: ModelLoad = { model, numCtx, state: "ready" };
    if (notice) closeNotice(notice, ready);
    else send(ready);
    deps.onLoaded?.();
  };

  return {
    load(model, numCtx) {
      try {
        refuseNew(model);
      } catch (e) {
        return Promise.reject(e);
      }
      const baseUrl = deps.baseUrl();
      if (baseUrl === undefined) return Promise.reject(new ModelActionError("runtime-not-ready", "Ollama is not running, so no model can be loaded."));
      const tag = canonicalTag(model);
      // One model, one load: a second request (another chat, another window) never queues a second one behind it.
      const joined = running.get(tag);
      if (joined !== undefined && joined.numCtx === numCtx && joined.gen === generation) return joined.run;
      // Reserved before the first await, so models.remove refuses from here to the end.
      hold(tag);
      const run = loadModel(model, numCtx, baseUrl, generation, current.signal).finally(() => {
        letGoOf(tag);
        pendingLoads.delete(run);
        if (running.get(tag)?.run === run) running.delete(tag);
      });
      pendingLoads.add(run);
      running.set(tag, { numCtx, gen: generation, run });
      return run;
    },

    reserve(model) {
      refuseNew(model);
      const tag = canonicalTag(model);
      const baseUrl = deps.baseUrl();
      const gen = generation;
      // The turn's own: aborted by runtimeChanged() or close(), and never re-armed.
      const turnGone = new AbortController();
      let markEnded: (() => void) | undefined;
      const live = { gone: turnGone, ended: new Promise<void>((r) => (markEnded = r)) };
      turns.add(live);
      const runtimeGone = turnGone.signal;
      hold(tag);
      let numCtx = 0;
      let admitting = false;
      let notice: Notice | undefined;
      let answered = false;
      let ended = false;
      let releaseGate: (() => void) | undefined;
      const letGo = () => {
        const r = releaseGate;
        releaseGate = undefined;
        r?.();
      };
      const reservation: TurnReservation = {
        baseUrl,
        signal: runtimeGone,
        get cold() {
          return notice !== undefined;
        },
        admit(ctx, options = {}) {
          if (admitting) return Promise.reject(new Error("admit runs once per reservation"));
          admitting = true;
          numCtx = ctx;
          const { signal } = options;
          let gone = false;
          const decision = new Promise<FitReport>((resolve, reject) => {
            const giveUp = (e: unknown) => {
              gone = true;
              reject(e);
            };
            const onAbort = () => giveUp(new AdmitCancelled(`stopped waiting to load ${model}`));
            const onRuntimeGone = () => giveUp(closed ? new ModelActionError("shutting-down", SHUTTING_DOWN_MESSAGE) : switched());
            const done = () => {
              signal?.removeEventListener("abort", onAbort);
              runtimeGone.removeEventListener("abort", onRuntimeGone);
            };
            if (gen !== generation || runtimeGone.aborted) {
              onRuntimeGone();
              return;
            }
            if (baseUrl === undefined) {
              giveUp(new ModelActionError("runtime-not-ready", "Ollama is not running, so no model can be loaded."));
              return;
            }
            if (signal?.aborted) {
              onAbort();
              return;
            }
            signal?.addEventListener("abort", onAbort, { once: true });
            runtimeGone.addEventListener("abort", onRuntimeGone, { once: true });
            // One signal ends the residency read and the fit: the turn's own abort or the runtime's.
            const reads = signal === undefined ? runtimeGone : AbortSignal.any([signal, runtimeGone]);
            const fit = options.fit ?? ((s: AbortSignal) => deps.fit(model, ctx, baseUrl, s));
            gate(async () => {
              if (gone) return;
              try {
                const here = await residency(baseUrl, gen, reads);
                if (gone) return;
                const report = await fit(reads);
                if (gone) return;
                done();
                if (ended) return reject(new AdmitCancelled(`the turn on ${model} ended before it was admitted`));
                if (gen !== generation) return reject(switched());
                const entry = here.ok ? here.models.get(tag) : undefined;
                // Released after the fit only when /api/ps proves no load is coming:
                // resident, at this context. Unknown residency or context holds the gate.
                numCtx = report.numCtx;
                if (report.verdict === "refuse" || (entry !== undefined && entry.contextLength === report.numCtx)) return resolve(report);
                // Proven absent: a cold load this turn causes and the app owns. Resident at
                // another context, or /api/ps unreadable: held, but nothing claimed.
                if (here.ok && entry === undefined) notice = openNotice(model, report.numCtx);
                const held = new Promise<void>((r) => (releaseGate = r));
                resolve(report);
                await held;
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
          if (gen === generation && !used.has(tag)) {
            used.add(tag);
            // the status pushed already calls it protected: refresh it now, not at the next poll
            deps.onLoaded?.();
          }
          if (notice !== undefined && gen === generation) loaded(model, numCtx, notice);
        },
        end() {
          if (ended) return;
          ended = true;
          letGo();
          letGoOf(tag);
          turns.delete(live);
          markEnded?.();
          const open = notice;
          if (answered || open === undefined || baseUrl === undefined || gen !== generation) return;
          // Ended before a token (an error or a cancel mid-load): report what is true now.
          void residency(baseUrl, gen, current.signal).then((here) => {
            if (gen !== generation) return;
            if (here.ok && here.models.has(tag)) loaded(model, numCtx, open);
            else closeNotice(open, { model, numCtx, state: "unloaded" });
          });
        },
      };
      return reservation;
    },

    inUse: (model) => (reservations.get(canonicalTag(model)) ?? 0) > 0,
    busyModels: () => [...reservations.keys()],

    beginRemove(model) {
      const tag = canonicalTag(model);
      if ((reservations.get(tag) ?? 0) > 0) {
        throw new ModelActionError("model-in-use", `${model} is loading or answering in a chat right now. Wait for it to finish or stop that reply, then remove the model.`);
      }
      if (removing.has(tag)) throw new ModelActionError("model-removing", `${model} is already being removed.`);
      removing.add(tag);
      return () => void removing.delete(tag);
    },

    runtimeChanged() {
      generation++;
      owned.clear();
      used.clear();
      switching = true;
      current.abort(switched());
      if (!closed) current = new AbortController();
      for (const turn of turns) turn.gone.abort(switched());
      // Deleting the visited entry while iterating a Set is safe.
      for (const notice of notices) closeNotice(notice, { model: notice.model, numCtx: notice.numCtx, state: "error", message: RUNTIME_CHANGED_MESSAGE });
    },

    async turnsEnded() {
      await Promise.all([...turns].filter((t) => t.gone.signal.aborted).map((t) => t.ended));
    },

    runtimeSettled() {
      switching = false;
    },

    async close() {
      closed = true;
      current.abort(new ModelActionError("shutting-down", SHUTTING_DOWN_MESSAGE));
      for (const turn of turns) turn.gone.abort(new ModelActionError("shutting-down", SHUTTING_DOWN_MESSAGE));
      await Promise.allSettled(pendingLoads);
    },

    appLoadedModels: () => [...owned.keys()],
    loadedOrAnswered,
    async imageMayUnload() {
      const baseUrl = deps.baseUrl();
      if (deps.ownsRuntime?.() === true && baseUrl !== undefined) {
        const gen = generation;
        const here = await residency(baseUrl, gen, current.signal);
        // An unreadable /api/ps falls back to what the app knows it loaded or used.
        if (here.ok && gen === generation) return [...here.models.keys()];
      }
      return loadedOrAnswered();
    },
    unloaded(model) {
      const tag = canonicalTag(model);
      used.delete(tag);
      const numCtx = owned.get(tag);
      if (numCtx === undefined) return;
      owned.delete(tag);
      send({ model: tag, numCtx, state: "unloaded" });
    },
    async residentModels() {
      const baseUrl = deps.baseUrl();
      if (baseUrl === undefined) return [];
      const gen = generation;
      // A switch aborts `current`, so a read of the old runtime ends then rather than late.
      const here = await residency(baseUrl, gen, current.signal, true);
      return here.ok && gen === generation ? [...here.models.values()] : [];
    },
    prune,
  };
}
