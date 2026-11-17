import type { FitOffer, FitReport, ModelLoad } from "@gates-local/contracts";
import { withFree } from "../fit/alternatives.ts";
import { createFifoGate, type LoadGate } from "../gpu/gate.ts";
import type { GpuLease } from "../gpu/lease.ts";
import { ENGINE_BUSY_NOTE, createLoadedRecord, snapshotWithout, type Handoff, type LoadedSnapshot, type MemoryOwner, type Want } from "../gpu/memory.ts";
import { canonicalTag } from "./recommended.ts";
import { sendMark, sendSpan } from "../chat/send-times.ts";
import { GenerateResponse, decode, parseJson } from "./schemas.ts";
import type { LoadedModel } from "./types.ts";

// external: 5m is Ollama's own keep_alive default, so a preload stays as long as a turn's load
export const PRELOAD_KEEP_ALIVE = "5m";
// why: a cold load of a large model from disk can take minutes
const PRELOAD_TIMEOUT_MS = 10 * 60_000;

export type ModelErrorCode = "model-in-use" | "model-removing" | "runtime-not-ready" | "runtime-switching" | "shutting-down" | "remove-failed";

export class ModelActionError extends Error {
  override readonly name = "ModelActionError";
  readonly code: ModelErrorCode;
  constructor(code: ModelErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export class AdmitCancelled extends Error {
  override readonly name = "AdmitCancelled";
}

export interface TurnLoad {
  firstToken(): void;
  end(): void;
}

export interface AdmitContext {
  readonly handoff: Handoff | undefined;
  leave(): Promise<Handoff | undefined>;
}

export interface AdmitOptions {
  readonly fit?: (signal: AbortSignal, context: AdmitContext) => Promise<FitReport>;
  readonly signal?: AbortSignal;
}

export interface TurnReservation extends TurnLoad {
  readonly baseUrl: string | undefined;
  readonly signal: AbortSignal;
  readonly cold: boolean;
  admit(numCtx: number, options?: AdmitOptions): Promise<FitReport>;
}

export interface ModelLoader {
  load(model: string, numCtx: number, options?: { readonly typed?: boolean }): Promise<ModelLoad>;
  reserve(model: string): TurnReservation;
  inUse(model: string): boolean;
  busyModels(): string[];
  beginRemove(model: string): () => void;
  runtimeChanged(): void;
  runtimeKept(): void;
  turnsEnded(): Promise<void>;
  runtimeSettled(): void;
  close(): Promise<void>;
  appLoadedModels(): readonly string[];
  replying(): readonly string[];
  unloaded(model: string): void;
  residentModels(): Promise<readonly LoadedModel[]>;
  prune(resident: readonly string[]): void;
}

export interface ModelLoaderDeps {
  readonly baseUrl: () => string | undefined;
  readonly push: (load: ModelLoad) => void;
  readonly listLoaded: (baseUrl: string, signal: AbortSignal) => Promise<readonly LoadedModel[]>;
  readonly fit: (model: string, numCtx: number, baseUrl: string, signal: AbortSignal) => Promise<FitReport>;
  readonly offer?: (refused: FitReport, baseUrl: string) => Promise<FitOffer | undefined>;
  readonly gate?: LoadGate;
  readonly memory?: MemoryOwner;
  readonly lease?: Pick<GpuLease, "run">;
  readonly onLoaded?: () => void;
  readonly log?: (line: string) => void;
  readonly faultForTest?: "gate-before-lease" | "gate-let-go-at-send" | "record-without-generation-check" | "fit-from-the-first-reading" | "refusal-names-nothing" | "forget-on-refused-switch";
}

const removingMessage = (model: string) => `${model} is being removed right now, so it cannot be used. Wait for the removal to finish or pick another model.`;
export const RUNTIME_SWITCHING_MESSAGE = "The runtime is changing. Try again in a moment.";
export const RUNTIME_CHANGED_MESSAGE = "The runtime changed while this model was loading.";
export const PS_UNREADABLE_MESSAGE = "Could not read which models Ollama has loaded, so the app did not load this one. Try again.";
const SHUTTING_DOWN_MESSAGE = "The app is shutting down, so no model can be loaded.";
const SHUTDOWN_STOPPED_MESSAGE = "The app is shutting down, so this model's load was stopped.";
const switched = () => new ModelActionError("runtime-switching", RUNTIME_SWITCHING_MESSAGE);
const behindReply = (model: string) => new ModelActionError("model-in-use", `A reply is running in another chat, so ${model} loads when you send.`);
const withBusyNote = (report: FitReport, handoff: Handoff | undefined): FitReport =>
  report.verdict === "refuse" && handoff?.engine === "busy" ? { ...report, message: `${report.message ?? `${report.model} does not fit.`} ${ENGINE_BUSY_NOTE}` } : report;

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

interface Notice {
  readonly model: string;
  readonly numCtx: number;
  end?: ModelLoad;
}

function count(counts: Map<string, number>, tag: string, by: 1 | -1): void {
  const left = (counts.get(tag) ?? 0) + by;
  if (left > 0) counts.set(tag, left);
  else counts.delete(tag);
}

export function createModelLoader(deps: ModelLoaderDeps): ModelLoader {
  const log = deps.log ?? (() => undefined);
  const memory = deps.memory;
  const gate = memory?.gate ?? deps.gate ?? createFifoGate();
  const record = memory?.loaded ?? createLoadedRecord();
  const noted: typeof withBusyNote = deps.faultForTest === "refusal-names-nothing" ? (report) => report : withBusyNote;
  const reservations = new Map<string, number>();
  const replying = new Map<string, number>();
  const removing = new Set<string>();
  const notices = new Set<Notice>();
  const pendingLoads = new Set<Promise<ModelLoad>>();
  const running = new Map<string, { readonly numCtx: number; readonly gen: number; readonly claims: boolean; readonly run: Promise<ModelLoad> }>();
  let generation = 0;
  let forgotten: LoadedSnapshot | undefined;
  let switching = false;
  let closed = false;
  let current = new AbortController();
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
  const closeNotice = (notice: Notice, end: ModelLoad): ModelLoad => {
    if (notice.end !== undefined) return notice.end;
    notice.end = end;
    notices.delete(notice);
    send(end);
    return end;
  };

  const hold = (tag: string) => count(reservations, tag, 1);
  const letGoOf = (tag: string) => count(reservations, tag, -1);

  const prune = (resident: readonly string[]) => {
    for (const [tag, numCtx] of record.observe(resident.map((name) => ({ name })))) send({ model: tag, numCtx, state: "unloaded" });
  };
  const recordLoaded = (model: string, numCtx: number) => {
    for (const [tag, at] of record.loaded(model, numCtx)) send({ model: tag, numCtx: at, state: "unloaded" });
  };

  let pollFailure: string | undefined;

  const residency = async (baseUrl: string, gen: number, signal: AbortSignal, poll = false): Promise<Residency> => {
    try {
      const loaded = await deps.listLoaded(baseUrl, signal);
      pollFailure = undefined;
      if (gen === generation) {
        prune(loaded.map((m) => m.name));
        memory?.observe(loaded);
      }
      return { ok: true, models: new Map(loaded.map((m) => [canonicalTag(m.name), m])) };
    } catch (e) {
      const message = (e as Error).message;
      if (poll && (signal.aborted || message === pollFailure)) return { ok: false };
      if (poll) pollFailure = message;
      log(`reading /api/ps failed: ${message}`);
      return { ok: false };
    }
  };

  const refuseNew = (model: string) => {
    if (closed) throw new ModelActionError("shutting-down", SHUTTING_DOWN_MESSAGE);
    if (switching) throw new ModelActionError("runtime-switching", RUNTIME_SWITCHING_MESSAGE);
    if (removing.has(canonicalTag(model))) throw new ModelActionError("model-removing", removingMessage(model));
  };

  const loadModel = async (model: string, requested: number, baseUrl: string, gen: number, signal: AbortSignal, claims: boolean): Promise<ModelLoad> => {
    const tag = canonicalTag(model);
    let notice: Notice | undefined;
    let numCtx = requested;
    const finish = (end: ModelLoad): ModelLoad => {
      if (notice !== undefined) return closeNotice(notice, end);
      send(end);
      return end;
    };
    const stopped = (): ModelLoad | undefined => {
      if (gen !== generation) return { model, numCtx, state: "error", message: RUNTIME_CHANGED_MESSAGE };
      if (signal.aborted) return { model, numCtx, state: "error", message: SHUTDOWN_STOPPED_MESSAGE };
      return undefined;
    };
    const want = (ctx: number): Want => ({ kind: "chat", model, numCtx: ctx });
    const inGate = async (): Promise<ModelLoad> => {
      const before = stopped();
      if (before) return finish(before);
      if (removing.has(tag)) return finish({ model, numCtx, state: "error", message: removingMessage(model) });
      if ([...replying.keys()].some((t) => t !== tag)) throw behindReply(model);
      const handoff = await memory?.handoff(want(requested), signal);
      const afterHandoff = stopped();
      if (afterHandoff) return finish(afterHandoff);
      const here = await residency(baseUrl, gen, signal);
      const afterPs = stopped();
      if (afterPs) return finish(afterPs);
      if (!here.ok) return finish({ model, numCtx, state: "error", message: PS_UNREADABLE_MESSAGE });
      const resident = here.models.get(tag);
      // decision: docs/decisions.md "Other programs' memory is freed only with a click"
      if (resident !== undefined && record.oursAt(tag) === undefined) {
        if (claims) recordLoaded(tag, resident.contextLength ?? numCtx);
        const ready = finish({ model, numCtx, state: "ready" });
        deps.onLoaded?.();
        return ready;
      }
      const report = noted(await deps.fit(model, numCtx, baseUrl, signal), handoff);
      const afterFit = stopped();
      if (afterFit) return finish(afterFit);
      numCtx = report.numCtx;
      if (report.verdict === "refuse") {
        const offer = withFree(await deps.offer?.(report, baseUrl).catch(() => undefined), report, handoff?.held);
        return finish({ model, numCtx, state: "error", message: report.message ?? `${model} at num_ctx ${numCtx} does not fit.`, ...(offer === undefined ? {} : { offer }) });
      }
      if (here.models.get(tag)?.contextLength === numCtx) return finish({ model, numCtx, state: "ready" });
      if (replying.has(tag)) throw behindReply(model);
      memory?.stage(want(numCtx), "loading");
      notice = openNotice(model, numCtx);
      try {
        await preload(baseUrl, model, numCtx, signal);
      } catch (e) {
        return finish(stopped() ?? { model, numCtx, state: "error", message: `Could not load ${model}: ${(e as Error).message}` });
      }
      const afterLoad = stopped();
      if (afterLoad) return finish(afterLoad);
      recordLoaded(tag, numCtx);
      const ready = finish({ model, numCtx, state: "ready" });
      deps.onLoaded?.();
      return ready;
    };
    const owning = async (): Promise<ModelLoad> => {
      try {
        const end = await inGate();
        if (end.state === "ready" && gen === generation) memory?.settled(want(end.numCtx));
        else memory?.ended();
        return end;
      } catch (e) {
        memory?.ended();
        throw e;
      }
    };
    const claimed = <T>(job: () => Promise<T>) => (deps.lease ? deps.lease.run("chat", signal, job) : job());
    try {
      return await (deps.faultForTest === "gate-before-lease" ? gate(() => claimed(owning)) : claimed(() => gate(owning)));
    } catch (e) {
      if (e instanceof ModelActionError && e.code === "model-in-use") throw e;
      return finish(stopped() ?? { model, numCtx, state: "error", message: `Could not load ${model}: ${(e as Error).message}` });
    }
  };

  const loaded = (model: string, numCtx: number, notice: Notice | undefined) => {
    recordLoaded(model, numCtx);
    const ready: ModelLoad = { model, numCtx, state: "ready" };
    if (notice) closeNotice(notice, ready);
    else send(ready);
    deps.onLoaded?.();
  };

  return {
    load(model, numCtx, options = {}) {
      try {
        refuseNew(model);
      } catch (e) {
        return Promise.reject(e);
      }
      const baseUrl = deps.baseUrl();
      if (baseUrl === undefined) return Promise.reject(new ModelActionError("runtime-not-ready", "Ollama is not running, so no model can be loaded."));
      const tag = canonicalTag(model);
      const claims = options.typed !== true;
      const joined = running.get(tag);
      // why: a pick that joined a typed load would not make the model the app's
      if (joined !== undefined && joined.numCtx === numCtx && joined.gen === generation && (joined.claims || !claims)) return joined.run;
      hold(tag);
      const run = loadModel(model, numCtx, baseUrl, generation, current.signal, claims).finally(() => {
        letGoOf(tag);
        pendingLoads.delete(run);
        if (running.get(tag)?.run === run) running.delete(tag);
      });
      pendingLoads.add(run);
      running.set(tag, { numCtx, gen: generation, claims, run });
      return run;
    },

    reserve(model) {
      refuseNew(model);
      const tag = canonicalTag(model);
      const baseUrl = deps.baseUrl();
      const gen = generation;
      const turnGone = new AbortController();
      let markEnded: (() => void) | undefined;
      const live = { gone: turnGone, ended: new Promise<void>((r) => (markEnded = r)) };
      turns.add(live);
      const runtimeGone = turnGone.signal;
      hold(tag);
      let numCtx = 0;
      let admitting = false;
      let notice: Notice | undefined;
      let reloaded = false;
      let answered = false;
      let ended = false;
      let counted = false;
      let handing = false;
      let releaseGate: (() => void) | undefined;
      const wanted = (): Want => ({ kind: "chat", model, numCtx });
      const handed = (inMemory: boolean) => {
        if (!handing) return;
        handing = false;
        if (inMemory && gen === generation) memory?.settled(wanted());
        else memory?.ended();
      };
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
            const reads = signal === undefined ? runtimeGone : AbortSignal.any([signal, runtimeGone]);
            const fit = options.fit ?? ((s: AbortSignal) => deps.fit(model, ctx, baseUrl, s));
            gate(async () => {
              if (gone) return;
              try {
                if (memory !== undefined) handing = true;
                sendMark("gate");
                const early = deps.faultForTest === "fit-from-the-first-reading" ? await fit(reads, { handoff: undefined, leave: async () => undefined }) : undefined;
                let handoff = await memory?.handoff(wanted(), reads);
                if (gone) return handed(false);
                const here = await sendSpan("residency", () => residency(baseUrl, gen, reads));
                if (gone) return handed(false);
                const leave = async () => (memory === undefined ? undefined : (handoff = await memory.handoff(wanted(), reads)));
                const report = noted(early ?? await fit(reads, { get handoff() { return handoff; }, leave }), handoff);
                if (gone) return handed(false);
                done();
                if (ended) {
                  handed(false);
                  return reject(new AdmitCancelled(`the turn on ${model} ended before it was admitted`));
                }
                if (gen !== generation) {
                  handed(false);
                  return reject(switched());
                }
                const entry = here.ok ? here.models.get(tag) : undefined;
                numCtx = report.numCtx;
                // why: Ollama loads a resident model again at another context, so this send loads it
                reloaded = entry?.contextLength !== undefined && entry.contextLength !== numCtx;
                if (report.verdict === "refuse") {
                  handed(false);
                  return resolve(report);
                }
                counted = true;
                count(replying, tag, 1);
                if (entry !== undefined && entry.contextLength === report.numCtx) {
                  handed(true);
                  return resolve(report);
                }
                memory?.stage(wanted(), "loading");
                if (here.ok && entry === undefined) notice = openNotice(model, report.numCtx);
                const held = new Promise<void>((r) => (releaseGate = r));
                resolve(report);
                if (deps.faultForTest !== "gate-let-go-at-send") await held;
              } catch (e) {
                handed(false);
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
          handed(true);
          letGo();
          if (notice !== undefined && (gen === generation || deps.faultForTest === "record-without-generation-check")) loaded(model, numCtx, notice);
          // decision: docs/decisions.md "Other programs' memory is freed only with a click"
          else if (reloaded && gen === generation) {
            recordLoaded(tag, numCtx);
            deps.onLoaded?.();
          }
        },
        end() {
          if (ended) return;
          ended = true;
          // why: ended before a token, so what it began loading is the next handoff's to measure
          handed(false);
          letGo();
          letGoOf(tag);
          if (counted) count(replying, tag, -1);
          turns.delete(live);
          markEnded?.();
          const open = notice;
          if (answered || open === undefined || baseUrl === undefined || gen !== generation) return;
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
      forgotten = record.clear();
      memory?.observe([]);
      switching = true;
      current.abort(switched());
      if (!closed) current = new AbortController();
      for (const turn of turns) turn.gone.abort(switched());
      // why: closeNotice deletes the visited entry, which is safe while iterating a Set
      for (const notice of notices) closeNotice(notice, { model: notice.model, numCtx: notice.numCtx, state: "error", message: RUNTIME_CHANGED_MESSAGE });
    },

    async turnsEnded() {
      await Promise.all([...turns].filter((t) => t.gone.signal.aborted).map((t) => t.ended));
    },

    runtimeKept() {
      if (forgotten === undefined || deps.faultForTest === "forget-on-refused-switch") return;
      record.restore(forgotten);
      forgotten = undefined;
    },

    runtimeSettled() {
      switching = false;
      forgotten = undefined;
    },

    async close() {
      closed = true;
      current.abort(new ModelActionError("shutting-down", SHUTTING_DOWN_MESSAGE));
      for (const turn of turns) turn.gone.abort(new ModelActionError("shutting-down", SHUTTING_DOWN_MESSAGE));
      await Promise.allSettled(pendingLoads);
    },

    appLoadedModels: () => record.ours(),
    replying: () => [...replying.keys()],
    unloaded(model) {
      if (forgotten !== undefined) forgotten = snapshotWithout(forgotten, model);
      const numCtx = record.left(model);
      if (numCtx !== undefined) send({ model: canonicalTag(model), numCtx, state: "unloaded" });
    },
    async residentModels() {
      const baseUrl = deps.baseUrl();
      if (baseUrl === undefined) return [];
      const gen = generation;
      const here = await residency(baseUrl, gen, current.signal, true);
      return here.ok && gen === generation ? [...here.models.values()] : [];
    },
    prune,
  };
}
