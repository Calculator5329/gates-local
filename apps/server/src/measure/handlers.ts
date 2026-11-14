// models.measures, models.measure and models.measurePages (row 29). A measure runs only on its
// RPC: it takes the GPU lease alone ("bench"), so it waits for running replies and a send waits
// for it. Then, in the lock order a send uses (lease, then the memory owner's load gate), the
// owner's handoff asks everything else in memory to leave, and the fit at the chat's window for
// this model is decided from a new reading. It runs the suite, saves the numbers and pushes the
// new list. One model at a time.
//
// The page checks end with a page each, saved as pending. A window runs them in a sandboxed
// frame and sends back what it saw (models.measurePages); the run waits up to PAGE_WAIT_MS for
// that, with the GPU lease already given back. With no window open the pages stay pending and
// the score is over the other parts; the first window that opens later runs them.
import type { FitReport, MeasureRun, ModelInfo, ModelMeasure, PageSeen, ShellStatus } from "@gates-local/contracts";
import type { GpuLease } from "../gpu/lease.ts";
import type { MemoryOwner, Want } from "../gpu/memory.ts";
import type { Push } from "../app.ts";
import type { SettingsReader } from "../settings/store.ts";
import { turnSettings } from "../settings/turn.ts";
import { ensureFixtures } from "./cases.ts";
import { STEPS, measureModel } from "./suite.ts";
import { gradePages, pendingPages } from "./score.ts";
import { measureStore } from "./store.ts";

/** The chat's default window when the settings have none (settings/store.ts). */
const DEFAULT_CTX = 16384;
/** How long a run waits for a window to run its pages. */
export const PAGE_WAIT_MS = 30_000;

export class MeasureError extends Error {
  override readonly name = "MeasureError";
  readonly code: "runtime-not-ready" | "wont-fit" | "measure-busy" | "not-installed" | "shutting-down" | "not-measured";
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
  /** The chat's window and thinking, and the model's sampling settings. */
  readonly settings?: Pick<SettingsReader, "get">;
  /** The shell sandbox's probe: off on Linux skips the database checks, as a chat could not read them. */
  readonly shellStatus?: () => Promise<ShellStatus>;
  readonly platform?: NodeJS.Platform;
  readonly fetch?: typeof fetch;
  readonly pageWaitMs?: number;
}

export function createMeasure(deps: MeasureDeps) {
  const store = measureStore(deps.dataDir);
  const stop = new AbortController();
  let running: string | undefined;
  /** The run waiting for its pages, by model and measure time. */
  let waiting: { model: string; at: number; resolve: () => void } | undefined;
  const total = STEPS + 1;

  /** Refuses at once when it cannot start; otherwise answers with the started run and goes on behind it. */
  const start = async (model: string): Promise<MeasureRun> => {
    if (stop.signal.aborted) throw new MeasureError("shutting-down", "The app is closing.");
    if (running !== undefined) throw new MeasureError("measure-busy", `${running} is being measured. Measure one model at a time.`);
    running = model;
    try {
      const info = (await deps.installed()).find((m) => m.name === model);
      if (info === undefined) throw new MeasureError("not-installed", `${model} is not installed.`);
      const baseUrl = deps.baseUrl();
      if (baseUrl === undefined) throw new MeasureError("runtime-not-ready", "Ollama is not running.");
      const first: MeasureRun = { model, state: "waiting", done: 0, total };
      deps.push("models.measuring", first);
      void run(info, baseUrl).catch(() => undefined).finally(() => { running = undefined; });
      return first;
    } catch (e) {
      running = undefined;
      throw e;
    }
  };

  const run = async (info: ModelInfo, baseUrl: string): Promise<ModelMeasure> => {
    const { name: model, digest } = info;
    const signal = stop.signal;
    const settings = deps.settings?.get();
    // The window a chat with this model gets (web format.ts ctxFor).
    const numCtx = Math.min(settings?.defaultNumCtx ?? DEFAULT_CTX, info.maxContext ?? Infinity);
    try {
      let saved: ModelMeasure;
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
        deps.push("models.measuring", { model, state: "running", done: 0, total });
        let result: Awaited<ReturnType<typeof measureModel>>;
        try {
          const shell = await deps.shellStatus?.();
          const { systemPrompt: _theirs, ...sampling } = turnSettings(settings, model);
          result = await measureModel({
            baseUrl, model, signal, numCtx, sources: ensureFixtures(deps.dataDir), settings: sampling,
            ...(settings?.thinking === undefined ? {} : { think: settings.thinking }),
            ...(shell ? { shell } : {}), ...(deps.platform ? { platform: deps.platform } : {}), ...(deps.fetch ? { fetch: deps.fetch } : {}),
            onStep: (done) => deps.push("models.measuring", { model, state: "running", done, total }),
          });
        } catch (e) {
          memory?.ended();
          throw e;
        }
        memory?.settled(want);
        saved = { model, digest, ...result };
        deps.push("models.measures", store.put(saved));
      } finally {
        release?.();
      }
      if (pendingPages(saved) > 0) {
        const at = saved.at;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(done, deps.pageWaitMs ?? PAGE_WAIT_MS);
          signal.addEventListener("abort", done, { once: true });
          function done() {
            clearTimeout(timer);
            signal.removeEventListener("abort", done);
            waiting = undefined;
            resolve();
          }
          waiting = { model, at, resolve: done };
        });
        saved = store.list().find((m) => m.model === model && m.at === at) ?? saved;
      }
      deps.push("models.measuring", { model, state: "done", done: total, total });
      return saved;
    } catch (e) {
      const message = signal.aborted ? "The app is closing." : (e as Error).message;
      deps.push("models.measuring", { model, state: "error", done: 0, total, message });
      throw e;
    }
  };

  /** What a window saw on a measure's pages: graded, saved and pushed. */
  const pagesSeen = ({ model, at, pages }: { model: string; at: number; pages: readonly PageSeen[] }): ModelMeasure => {
    const measure = store.list().find((m) => m.model === model && m.at === at);
    if (measure === undefined) throw new MeasureError("not-measured", `${model} has no measure from that time; it was measured again since.`);
    const graded = gradePages(measure, pages);
    deps.push("models.measures", store.put(graded));
    if (waiting?.model === model && waiting.at === at && pendingPages(graded) === 0) waiting.resolve();
    return graded;
  };

  return {
    handlers: {
      "models.measures": () => store.list(),
      "models.measure": ({ name }: { name: string }) => start(name),
      "models.measurePages": pagesSeen,
    },
    close: () => stop.abort(),
  };
}
