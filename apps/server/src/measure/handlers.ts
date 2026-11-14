// models.measures and models.measure (row 29). A measure runs only on its RPC: it takes the
// GPU lease alone ("bench"), so it waits for running replies and a send waits for it; it checks
// the fit at the measure's window, runs the suite, saves the numbers and pushes the new list.
// One model at a time.
import type { FitReport, MeasureRun, ModelInfo, ModelMeasure } from "@gates-local/contracts";
import type { GpuLease } from "../gpu/lease.ts";
import type { Push } from "../app.ts";
import { CASES, MEASURE_CTX, ensureShopDb, measureModel } from "./suite.ts";
import { measureStore } from "./store.ts";

export class MeasureError extends Error {
  override readonly name = "MeasureError";
  readonly code: "runtime-not-ready" | "wont-fit" | "measure-busy" | "not-installed" | "shutting-down";
  constructor(code: MeasureError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

export interface MeasureDeps {
  readonly dataDir: string;
  readonly baseUrl: () => string | undefined;
  readonly installed: () => Promise<readonly ModelInfo[]>;
  readonly plan: (baseUrl: string, model: string, numCtx: number, signal: AbortSignal) => Promise<FitReport>;
  readonly push: Push;
  readonly lease?: Pick<GpuLease, "acquire">;
  readonly fetch?: typeof fetch;
}

export function createMeasure(deps: MeasureDeps) {
  const store = measureStore(deps.dataDir);
  const stop = new AbortController();
  let running: string | undefined;
  const total = CASES.length + 1;

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
      void run(model, info.digest, baseUrl).catch(() => undefined).finally(() => { running = undefined; });
      return first;
    } catch (e) {
      running = undefined;
      throw e;
    }
  };

  const run = async (model: string, digest: string, baseUrl: string): Promise<ModelMeasure> => {
    const signal = stop.signal;
    try {
      const release = await deps.lease?.acquire("bench", signal);
      try {
        const report = await deps.plan(baseUrl, model, MEASURE_CTX, signal);
        if (report.verdict === "refuse") throw new MeasureError("wont-fit", report.message ?? `${model} does not fit in memory here.`);
        deps.push("models.measuring", { model, state: "running", done: 0, total });
        const result = await measureModel({
          baseUrl, model, signal, dbFile: ensureShopDb(deps.dataDir),
          ...(deps.fetch ? { fetch: deps.fetch } : {}),
          onStep: (done) => deps.push("models.measuring", { model, state: "running", done, total }),
        });
        const saved: ModelMeasure = { model, digest, ...result };
        deps.push("models.measures", store.put(saved));
        deps.push("models.measuring", { model, state: "done", done: total, total });
        return saved;
      } finally {
        release?.();
      }
    } catch (e) {
      const message = signal.aborted ? "The app is closing." : (e as Error).message;
      deps.push("models.measuring", { model, state: "error", done: 0, total, message });
      throw e;
    }
  };

  return {
    handlers: {
      "models.measures": () => store.list(),
      "models.measure": ({ name }: { name: string }) => start(name),
    },
    close: () => stop.abort(),
  };
}
