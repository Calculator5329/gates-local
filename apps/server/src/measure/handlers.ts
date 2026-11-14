// models.measures and models.measure (row 29). A measure runs only on its RPC: it takes the
// GPU lease alone ("bench"), so it waits for running replies and a send waits for it. Then, in
// the lock order a send uses (lease, then the memory owner's load gate), the owner's handoff asks
// everything else in memory to leave, and the fit at the measure's window is decided from a new
// reading. It runs the suite, saves the numbers and pushes the new list. One model at a time.
import type { FitReport, MeasureRun, ModelInfo, ModelMeasure } from "@gates-local/contracts";
import type { GpuLease } from "../gpu/lease.ts";
import type { MemoryOwner, Want } from "../gpu/memory.ts";
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
  /** `measured`: after the handoff, inside the load gate, the reading alone decides (app.ts planBeside). */
  readonly plan: (baseUrl: string, model: string, numCtx: number, signal: AbortSignal, measured?: boolean) => Promise<FitReport>;
  readonly push: Push;
  readonly lease?: Pick<GpuLease, "acquire">;
  /** The one owner of what is in memory: Measure hands off through it as a send does. */
  readonly memory?: Pick<MemoryOwner, "gate" | "handoff" | "stage" | "settled" | "ended">;
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
        const memory = deps.memory;
        const want: Want = { kind: "chat", model, numCtx: MEASURE_CTX };
        const decide = async () => {
          const report = await deps.plan(baseUrl, model, MEASURE_CTX, signal, memory !== undefined);
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
          result = await measureModel({
            baseUrl, model, signal, dbFile: ensureShopDb(deps.dataDir),
            ...(deps.fetch ? { fetch: deps.fetch } : {}),
            onStep: (done) => deps.push("models.measuring", { model, state: "running", done, total }),
          });
        } catch (e) {
          memory?.ended();
          throw e;
        }
        memory?.settled(want);
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
