// models.measures, models.measure and models.measurePages (row 29). A measure runs only on its
// RPC: it takes the GPU lease alone ("bench"), so it waits for running replies and a send waits
// for it. Then, in the lock order a send uses (lease, then the memory owner's load gate), the
// owner's handoff asks everything else in memory to leave, and the fit at the chat's window for
// this model is decided from a new reading. It runs the suite, saves the numbers and pushes the
// new list. One model at a time.
//
// A run holds its model in the loader the way a chat turn does (a reservation, never admitted), so
// a runtime switch stops it as it ends a turn and waits for its end, and the model cannot be
// removed under it. A check whose turn failed (the runtime crashed, the model did not load) ends
// the run as an error: nothing is saved and the model's earlier measure stays.
//
// The page checks end with a page each, saved as pending. One window runs them, in a sandboxed
// frame, and sends back what it saw (models.measurePages) while the run waits up to PAGE_WAIT_MS
// for that, with the GPU lease already given back. Which window: the one that claims them first
// (models.measurePagesClaim), the window that started the run coming first while it is connected.
// The claim is the connection's: a window that reloads or closes lets it go, the list is pushed
// again, and the next window to ask runs them. A second window is refused while one holds them,
// and its pages are refused too. Pages still pending when the wait ends are skipped, saying why,
// and the score is over the other parts.
//
// The server keeps its own record of the run, its last step: models.measures answers with it, so
// a window that connects mid-run, or missed the run's last push, shows what is true.
import type { FitReport, MeasureList, MeasureRun, ModelInfo, ModelMeasure, PageSeen, ShellStatus } from "@gates-local/contracts";
import type { GpuLease } from "../gpu/lease.ts";
import type { MemoryOwner, Want } from "../gpu/memory.ts";
import type { Push } from "../app.ts";
import type { ModelLoader } from "../runtime/load.ts";
import type { SettingsReader } from "../settings/store.ts";
import { turnSettings } from "../settings/turn.ts";
import { ensureFixtures } from "./cases.ts";
import { STEPS, measureModel } from "./suite.ts";
import { gradePages, pendingPages, skipPages } from "./score.ts";
import { measureStore } from "./store.ts";

/** The chat's default window when the settings have none (settings/store.ts). */
const DEFAULT_CTX = 16384;
/** How long a run waits for a window to run its pages. */
export const PAGE_WAIT_MS = 30_000;
/** Why a page check counts for nothing: no window ran it in time. */
export const PAGES_UNRUN = "Pages were not run: no window ran them while Measure waited.";
export const RUNTIME_CHANGED_MEASURE = "The Ollama runtime changed while Measure ran, so it stopped.";

export class MeasureError extends Error {
  override readonly name = "MeasureError";
  readonly code: "runtime-not-ready" | "wont-fit" | "measure-busy" | "not-installed" | "shutting-down" | "not-measured" | "not-waiting" | "not-claimed";
  constructor(code: MeasureError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

export interface MeasureDeps {
  readonly dataDir: string;
  readonly baseUrl: () => string | undefined;
  readonly installed: () => Promise<readonly ModelInfo[]>;
  /** `measured`: after the handoff, inside the load gate, the reading alone decides (app.ts planBeside). */
  readonly plan: (baseUrl: string, model: string, numCtx: number, signal: AbortSignal, measured?: boolean) => Promise<FitReport>;
  readonly push: Push;
  readonly lease?: Pick<GpuLease, "acquire">;
  /** The one owner of what is in memory: Measure hands off through it as a send does. */
  readonly memory?: Pick<MemoryOwner, "gate" | "handoff" | "stage" | "settled" | "ended">;
  /** The model loader: a run reserves its model as a chat turn does, so a runtime switch stops it and waits for it. */
  readonly loader?: Pick<ModelLoader, "reserve">;
  /** The chat's window and thinking, and the model's sampling settings. */
  readonly settings?: Pick<SettingsReader, "get">;
  /** The shell sandbox's probe: off on Linux skips the database checks, as a chat could not read them. */
  readonly shellStatus?: () => Promise<ShellStatus>;
  readonly platform?: NodeJS.Platform;
  readonly fetch?: typeof fetch;
  readonly pageWaitMs?: number;
}

/** The connection a call came on (ws HandlerContext): its id, and a signal that aborts when it closes. */
export interface Caller {
  readonly clientId: number;
  readonly signal?: AbortSignal;
}

export function createMeasure(deps: MeasureDeps) {
  const store = measureStore(deps.dataDir);
  const stop = new AbortController();
  let running: string | undefined;
  /** The server's record of the last run: its last step, kept until the next run starts. */
  let last: MeasureRun | undefined;
  /** The run waiting for its pages, by model and measure time. */
  let waiting: { model: string; at: number; resolve: () => void } | undefined;
  /** The connection that started the running measure. */
  let starter: Caller | undefined;
  /** The connection running the waiting run's pages now. */
  let holder: { model: string; at: number; clientId: number } | undefined;
  const total = STEPS + 1;
  const step = (run: MeasureRun) => {
    last = run;
    deps.push("models.measuring", run);
  };
  /** Pages no run waits for any more (a run from before a restart, or an earlier build's) are skipped. */
  const settled = (m: ModelMeasure) => (waiting?.model === m.model && waiting.at === m.at ? m : skipPages(m, PAGES_UNRUN));

  /** Refuses at once when it cannot start; otherwise answers with the started run and goes on behind it. */
  const start = async (model: string, caller?: Caller): Promise<MeasureRun> => {
    if (stop.signal.aborted) throw new MeasureError("shutting-down", "The app is closing.");
    if (running !== undefined) throw new MeasureError("measure-busy", `${running} is being measured. Measure one model at a time.`);
    running = model;
    starter = caller;
    holder = undefined;
    try {
      const info = (await deps.installed()).find((m) => m.name === model);
      if (info === undefined) throw new MeasureError("not-installed", `${model} is not installed.`);
      const baseUrl = deps.baseUrl();
      if (baseUrl === undefined) throw new MeasureError("runtime-not-ready", "Ollama is not running.");
      // Throws while the runtime switches, the model is being removed or the app closes.
      const hold = deps.loader?.reserve(model);
      const first: MeasureRun = { model, state: "waiting", done: 0, total };
      step(first);
      void run(info, baseUrl, hold).catch(() => undefined).finally(() => { running = undefined; });
      return first;
    } catch (e) {
      running = undefined;
      throw e;
    }
  };

  const run = async (info: ModelInfo, baseUrl: string, hold: ReturnType<ModelLoader["reserve"]> | undefined): Promise<ModelMeasure> => {
    const { name: model, digest } = info;
    const signal = hold ? AbortSignal.any([stop.signal, hold.signal]) : stop.signal;
    const settings = deps.settings?.get();
    // The window a chat with this model gets (web format.ts ctxFor).
    const numCtx = Math.min(settings?.defaultNumCtx ?? DEFAULT_CTX, info.maxContext ?? Infinity);
    try {
      let saved: ModelMeasure;
      try {
        const release = await deps.lease?.acquire("bench", signal);
        try {
          const memory = deps.memory;
          const want: Want = { kind: "chat", model, numCtx };
          const decide = async () => {
            const report = await deps.plan(baseUrl, model, numCtx, signal, memory !== undefined);
            if (report.verdict === "refuse") throw new MeasureError("wont-fit", report.message ?? `${model} does not fit in memory here.`);
          };
          if (memory === undefined) await decide();
          else {
            await memory.gate(async () => {
              try {
                await memory.handoff(want, signal);
                await decide();
              } catch (e) {
                memory.ended();
                throw e;
              }
              memory.stage(want, "loading");
            });
          }
          step({ model, state: "running", done: 0, total });
          let result: Awaited<ReturnType<typeof measureModel>>;
          try {
            const shell = await deps.shellStatus?.();
            const { systemPrompt: _theirs, ...sampling } = turnSettings(settings, model);
            result = await measureModel({
              baseUrl, model, signal, numCtx, sources: ensureFixtures(deps.dataDir), settings: sampling,
              ...(settings?.thinking === undefined ? {} : { think: settings.thinking }),
              ...(shell ? { shell } : {}), ...(deps.platform ? { platform: deps.platform } : {}), ...(deps.fetch ? { fetch: deps.fetch } : {}),
              onStep: (done) => step({ model, state: "running", done, total }),
            });
          } catch (e) {
            memory?.ended();
            throw e;
          }
          memory?.settled(want);
          saved = { model, digest, ...result };
          // Waiting from here: the push that carries its pages to the window keeps them pending.
          if (pendingPages(saved) > 0) waiting = { model, at: saved.at, resolve: () => undefined };
          deps.push("models.measures", store.put(saved).map(settled));
        } finally {
          release?.();
        }
      } finally {
        // The runtime is not used past here: a switch need not wait for the pages.
        hold?.end();
      }
      if (pendingPages(saved) > 0) {
        const at = saved.at;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(done, deps.pageWaitMs ?? PAGE_WAIT_MS);
          stop.signal.addEventListener("abort", done, { once: true });
          function done() {
            clearTimeout(timer);
            stop.signal.removeEventListener("abort", done);
            waiting = undefined;
            holder = undefined;
            resolve();
          }
          waiting = { model, at, resolve: done };
        });
        saved = store.list().find((m) => m.model === model && m.at === at) ?? saved;
        if (pendingPages(saved) > 0) {
          saved = skipPages(saved, PAGES_UNRUN);
          deps.push("models.measures", store.put(saved).map(settled));
        }
      }
      step({ model, state: "done", done: total, total });
      return saved;
    } catch (e) {
      waiting = undefined;
      const message = stop.signal.aborted ? "The app is closing." : hold?.signal.aborted ? RUNTIME_CHANGED_MEASURE : (e as Error).message;
      step({ model, state: "error", done: 0, total, message });
      throw e;
    }
  };

  const waitsFor = (model: string, at: number) => waiting?.model === model && waiting.at === at;

  /**
   * A window asks to run the waiting run's pages. The one that started the run is first while it is
   * connected; else the first to ask. The hold ends with its connection, and the list goes out
   * again so a window still open (or the one just reloaded) can ask.
   */
  const claim = ({ model, at }: { model: string; at: number }, caller?: Caller): { claimed: boolean } => {
    if (!waitsFor(model, at)) return { claimed: false };
    const id = caller?.clientId ?? -1;
    if (holder !== undefined) return { claimed: holder.model === model && holder.at === at && holder.clientId === id };
    const starterHere = starter !== undefined && starter.signal?.aborted !== true;
    if (starterHere && starter?.clientId !== id) return { claimed: false };
    const held = { model, at, clientId: id };
    holder = held;
    caller?.signal?.addEventListener("abort", () => {
      if (holder !== held) return;
      holder = undefined;
      if (waitsFor(model, at)) deps.push("models.measures", store.list().map(settled));
    }, { once: true });
    return { claimed: true };
  };

  /** What the window holding the run's pages saw on them: graded, saved and pushed, while the run waits. */
  const pagesSeen = ({ model, at, pages }: { model: string; at: number; pages: readonly PageSeen[] }, caller?: Caller): ModelMeasure => {
    const measure = store.list().find((m) => m.model === model && m.at === at);
    if (measure === undefined) throw new MeasureError("not-measured", `${model} has no measure from that time; it was measured again since.`);
    if (!waitsFor(model, at)) throw new MeasureError("not-waiting", "Measure stopped waiting for these pages, so they were left out of the score.");
    if (holder !== undefined && holder.clientId !== (caller?.clientId ?? -1)) throw new MeasureError("not-claimed", "Another window is running these pages.");
    const graded = gradePages(measure, pages);
    deps.push("models.measures", store.put(graded).map(settled));
    if (pendingPages(graded) === 0) waiting?.resolve();
    return graded;
  };

  /** Every measure, and the run going now or the one that stopped on an error. */
  const list = (): MeasureList => ({ measures: store.list().map(settled), ...(last === undefined || last.state === "done" ? {} : { run: last }) });

  return {
    handlers: {
      "models.measures": list,
      "models.measure": ({ name }: { name: string }, caller?: Caller) => start(name, caller),
      "models.measurePages": pagesSeen,
      "models.measurePagesClaim": claim,
    },
    close: () => stop.abort(),
  };
}
