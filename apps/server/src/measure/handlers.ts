import { measureTotal, type FitReport, type MeasureChat, type MeasureList, type MeasureRun, type ModelInfo, type ModelMeasure, type PageSeen, type ShellStatus } from "@gates-local/contracts";
import type { GpuLease } from "../gpu/lease.ts";
import type { MemoryOwner, Want } from "../gpu/memory.ts";
import type { Push } from "../app/push.ts";
import type { ModelLoader } from "../runtime/load.ts";
import type { SettingsReader } from "../settings/store.ts";
import { turnSettings } from "../settings/turn.ts";
import { CASES, ensureFixtures } from "./cases.ts";
import { measureModel } from "./suite.ts";
import { gradePages, pendingPages, skipPages } from "./score.ts";
import { measureStore } from "./store.ts";
import { chatOf, chatStore } from "./chat.ts";
import { liveChat, type LiveChat } from "./live.ts";

const DEFAULT_CTX = 16384;
export const PAGE_WAIT_MS = 30_000;
// why: a window runs pages only while it is shown, so the run waits for the person to come back.
export const PAGE_HELD_MS = 10 * 60_000;
export const PAGES_UNRUN = "Pages were not run: no window ran them while Measure waited.";
export const PAGES_HIDDEN = "Pages were not run: the app's window stayed in the background while Measure waited.";
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
  readonly plan: (baseUrl: string, model: string, numCtx: number, signal: AbortSignal, measured?: boolean) => Promise<FitReport>;
  readonly push: Push;
  readonly lease?: Pick<GpuLease, "acquire">;
  readonly memory?: Pick<MemoryOwner, "gate" | "handoff" | "stage" | "settled" | "ended">;
  readonly loader?: Pick<ModelLoader, "reserve">;
  readonly settings?: Pick<SettingsReader, "get">;
  readonly shellStatus?: () => Promise<ShellStatus>;
  readonly platform?: NodeJS.Platform;
  readonly fetch?: typeof fetch;
  readonly pageWaitMs?: number;
  readonly pageHeldMs?: number;
  readonly pushMs?: number;
}

export interface Caller {
  readonly clientId: number;
  readonly signal?: AbortSignal;
}

export function createMeasure(deps: MeasureDeps) {
  const store = measureStore(deps.dataDir);
  const chats = chatStore(deps.dataDir);
  const stop = new AbortController();
  let running: string | undefined;
  // why: Stop works until the measure is saved; past that only the pages are left to wait on.
  let halt: AbortController | undefined;
  let live: LiveChat | undefined;
  let last: MeasureRun | undefined;
  let waiting: { model: string; at: number; resolve: () => void; held: (on: boolean) => void } | undefined;
  let starter: Caller | undefined;
  let holder: { model: string; at: number; clientId: number } | undefined;
  const total = measureTotal(CASES.length);
  const step = (run: MeasureRun) => {
    last = run;
    deps.push("models.measuring", run);
  };
  const settled = (m: ModelMeasure) => (waiting?.model === m.model && waiting.at === m.at ? m : skipPages(m, PAGES_UNRUN));

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
      const hold = deps.loader?.reserve(model);
      const first: MeasureRun = { model, state: "waiting", done: 0, total };
      const at = Date.now();
      halt = new AbortController();
      live = liveChat(model, at, (index, turn) => deps.push("models.measureTurn", { model, at, index, turn }), deps.pushMs);
      step(first);
      void run(info, baseUrl, hold, halt.signal, live).catch(() => undefined).finally(() => {
        running = undefined;
        halt = undefined;
        live = undefined;
      });
      return first;
    } catch (e) {
      running = undefined;
      throw e;
    }
  };

  const run = async (info: ModelInfo, baseUrl: string, hold: ReturnType<ModelLoader["reserve"]> | undefined, halted: AbortSignal, chat: LiveChat): Promise<ModelMeasure> => {
    const { name: model, digest } = info;
    const signal = AbortSignal.any([stop.signal, halted, ...(hold ? [hold.signal] : [])]);
    const settings = deps.settings?.get();
    // why: the window a chat with this model gets.
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
            // why: Measure samples its own way; only how long the model stays in memory is the person's.
            const { keep_alive: keepAlive } = turnSettings(settings, model);
            result = await measureModel({
              baseUrl, model, signal, numCtx, sources: ensureFixtures(deps.dataDir), ...(keepAlive === undefined ? {} : { keepAlive }),
              ...(settings?.thinking === undefined ? {} : { think: settings.thinking }),
              ...(shell ? { shell } : {}), ...(deps.platform ? { platform: deps.platform } : {}), ...(deps.fetch ? { fetch: deps.fetch } : {}),
              onStep: (done, _steps, tokensPerSecond) => step({ model, state: "running", done, total, ...(tokensPerSecond > 0 ? { tokensPerSecond } : {}) }),
              onTurn: chat.turn,
            });
          } catch (e) {
            memory?.ended();
            throw e;
          }
          memory?.settled(want);
          halt = undefined;
          chat.end();
          saved = { model, digest, ...result };
          // why: kept before the measure is sent, so a window that opens the new score finds its chat.
          chats.put({ model, at: saved.at, turns: chat.chat().turns });
          // why: set before the push below, or `settled` would send its pages out as skipped.
          if (pendingPages(saved) > 0) waiting = { model, at: saved.at, resolve: () => undefined, held: () => undefined };
          deps.push("models.measures", store.put(saved).map(settled));
        } finally {
          release?.();
        }
      } finally {
        // why: the runtime is not used past here, so a switch need not wait for the pages.
        hold?.end();
      }
      if (pendingPages(saved) > 0) {
        const at = saved.at;
        let why = PAGES_UNRUN;
        await new Promise<void>((resolve) => {
          let timer = setTimeout(done, deps.pageWaitMs ?? PAGE_WAIT_MS);
          stop.signal.addEventListener("abort", done, { once: true });
          function done() {
            clearTimeout(timer);
            stop.signal.removeEventListener("abort", done);
            waiting = undefined;
            holder = undefined;
            resolve();
          }
          const held = (on: boolean) => {
            clearTimeout(timer);
            why = on ? PAGES_HIDDEN : PAGES_UNRUN;
            timer = setTimeout(done, on ? deps.pageHeldMs ?? PAGE_HELD_MS : deps.pageWaitMs ?? PAGE_WAIT_MS);
          };
          waiting = { model, at, resolve: done, held };
        });
        saved = store.list().find((m) => m.model === model && m.at === at) ?? saved;
        if (pendingPages(saved) > 0) {
          saved = skipPages(saved, why);
          deps.push("models.measures", store.put(saved).map(settled));
        }
      }
      step({ model, state: "done", done: total, total });
      return saved;
    } catch (e) {
      waiting = undefined;
      chat.end();
      if (halted.aborted && !stop.signal.aborted) {
        step({ model, state: "stopped", done: 0, total });
        throw e;
      }
      const message = stop.signal.aborted ? "The app is closing." : hold?.signal.aborted ? RUNTIME_CHANGED_MEASURE : (e as Error).message;
      step({ model, state: "error", done: 0, total, message });
      throw e;
    }
  };

  const waitsFor = (model: string, at: number) => waiting?.model === model && waiting.at === at;

  const claim = ({ model, at }: { model: string; at: number }, caller?: Caller): { claimed: boolean } => {
    if (!waitsFor(model, at)) return { claimed: false };
    const id = caller?.clientId ?? -1;
    if (holder !== undefined) return { claimed: holder.model === model && holder.at === at && holder.clientId === id };
    const starterHere = starter !== undefined && starter.signal?.aborted !== true;
    if (starterHere && starter?.clientId !== id) return { claimed: false };
    const held = { model, at, clientId: id };
    holder = held;
    waiting?.held(true);
    caller?.signal?.addEventListener("abort", () => {
      if (holder !== held) return;
      holder = undefined;
      if (!waitsFor(model, at)) return;
      waiting?.held(false);
      deps.push("models.measures", store.list().map(settled));
    }, { once: true });
    return { claimed: true };
  };

  const pagesSeen = ({ model, at, pages }: { model: string; at: number; pages: readonly PageSeen[] }, caller?: Caller): ModelMeasure => {
    const measure = store.list().find((m) => m.model === model && m.at === at);
    if (measure === undefined) throw new MeasureError("not-measured", `${model} has no measure from that time; it was measured again since.`);
    if (!waitsFor(model, at)) throw new MeasureError("not-waiting", "Measure stopped waiting for these pages, so they were left out of the score.");
    if (holder !== undefined && holder.clientId !== (caller?.clientId ?? -1)) throw new MeasureError("not-claimed", "Another window is running these pages.");
    const graded = gradePages(measure, pages);
    if (live !== undefined && running === model) {
      const turns = live.chat().turns;
      for (const check of graded.checks) {
        const index = turns.findIndex((t) => t.id === check.id);
        const turn = turns[index];
        if (turn?.part === "pages") live.turn(index, { ...turn, check });
      }
    }
    deps.push("models.measures", store.put(graded).map(settled));
    if (pendingPages(graded) === 0) waiting?.resolve();
    return graded;
  };

  const list = (): MeasureList => ({
    measures: store.list().map(settled),
    ...(last === undefined || last.state === "done" || last.state === "stopped" ? {} : { run: last }),
    ...(live === undefined ? {} : { live: live.chat() }),
  });

  const stopRun = ({ name }: { name: string }): { stopped: boolean } => {
    if (running !== name || halt === undefined || halt.signal.aborted) return { stopped: false };
    halt.abort(new Error("Stopped."));
    return { stopped: true };
  };

  const chatFor = ({ model }: { model: string }): MeasureChat | null => {
    const m = store.list().find((x) => x.model === model);
    return m === undefined ? null : chatOf(settled(m), chats.get(model));
  };

  return {
    handlers: {
      "models.measures": list,
      "models.measure": ({ name }: { name: string }, caller?: Caller) => start(name, caller),
      "models.measureStop": stopRun,
      "models.measureChat": chatFor,
      "models.measurePages": pagesSeen,
      "models.measurePagesClaim": claim,
    },
    close: () => stop.abort(),
  };
}
