// The server's handlers: every contracts method wired onto the thread store,
// the Ollama runtime, the model catalog, the fit check and the streamed turn.
// main.ts only parses flags and owns the process; tests drive this directly.
//
// A chat turn: one active turn per thread, a ready runtime, a fit verdict
// other than refuse; then the user message persists, the reply streams on
// chat.event and only the finished assistant message reaches the store.
import { randomUUID } from "node:crypto";
import type { Channel, Message, Payload } from "@gates-local/contracts";
import { streamTurn } from "./chat/stream.ts";
import { streamToolTurn } from "./chat/tools.ts";
import type { Sources } from "./sources/index.ts";
import { createSourcesHandlers } from "./sources/handlers.ts";
import type { TurnMessage } from "./chat/types.ts";
import { checkFit, planLoad, type FitDeps } from "./fit/fit.ts";
import { untilAborted } from "./fit/gpu.ts";
import { fetchShow, sameModel } from "./fit/ollama.ts";
import type { FitReport } from "./fit/types.ts";
import { AdmitCancelled, ModelActionError, type ModelLoader, type TurnLoad, type TurnReservation } from "./runtime/load.ts";
import type { ModelCatalog } from "./runtime/models.ts";
import type { OllamaRuntime } from "./runtime/runtime.ts";
import type { ThreadStore } from "./threads/store.ts";
import type { Handlers } from "./ws/server.ts";
import { createImageHandlers } from "./image/handlers.ts";
import type { ImageModule } from "./image/module.ts";
import type { GpuLease } from "./gpu/lease.ts";

/** The slice-1 methods every build answers. v2 methods join as their lanes land; until then the socket answers "not-implemented". */
type CoreMethod =
  | "threads.list"
  | "threads.create"
  | "threads.get"
  | "threads.rename"
  | "threads.delete"
  | "models.list"
  | "models.refresh"
  | "runtime.status"
  | "fit.check"
  | "chat.send"
  | "chat.cancel";
export type AppHandlers = Pick<Handlers, CoreMethod> & Partial<Handlers>;

/**
 * Codes the handlers here throw. packages/contracts lists only the
 * protocol's own codes (WireErrorCode, "Handlers may add their own codes");
 * clients switch on these strings.
 */
export type AppErrorCode =
  | "turn-active" // the thread already has a turn streaming
  | "runtime-not-ready" // no ready Ollama to talk to
  | "wont-fit" // the fit check refused this model at this num_ctx; the message names the numbers
  | "cancelled" // the turn was cancelled (or its thread deleted) before it started
  | "runtime-changed" // a runtime switch ended the turn (any text sent is saved, event.partial); the client sends the message again
  | "preempted" // chat.send stopOthers ended the turn: another model's load needed its GPU (event.neededBy, event.partial)
  | "shutting-down"; // the server is stopping and takes no new turns

export class AppError extends Error {
  override readonly name = "AppError";
  readonly code: AppErrorCode;
  /** The refusing report, for wont-fit. Not on the wire (the message carries it). */
  readonly report?: FitReport;
  /** For preempted: the model whose load needed the GPU (the terminal event's neededBy). */
  readonly neededBy?: string;
  constructor(code: AppErrorCode, message: string, report?: FitReport, neededBy?: string) {
    super(message);
    this.code = code;
    if (report !== undefined) this.report = report;
    if (neededBy !== undefined) this.neededBy = neededBy;
  }
}

/** A runtime switch ended the turn; the reply streamed so far is saved as a stopped reply. */
export const RUNTIME_CHANGED_TURN_MESSAGE = "The Ollama runtime changed while this reply was running, so it stopped. Send the message again.";
const runtimeChangedTurn = (): AppError => new AppError("runtime-changed", RUNTIME_CHANGED_TURN_MESSAGE);
const HALTED = Symbol("halted");
/** chat.send stopOthers ended this turn: `model`'s load needed the GPU memory `held` was using. */
const preemptedBy = (model: string, numCtx: number, held: string): AppError =>
  new AppError("preempted", `${model} at num_ctx ${numCtx} needed the GPU memory ${held} was using, so this reply stopped. Send the message again.`, undefined, model);

export type Push = <C extends Channel>(channel: C, payload: Payload<C>) => void;
type WireEvent = Payload<"chat.event">["event"];

export interface AppDeps {
  readonly store: ThreadStore;
  readonly runtime: Pick<OllamaRuntime, "status" | "baseUrl" | "onChange">;
  readonly catalog: ModelCatalog;
  /** Bound late: main creates the ws server after the handlers. */
  readonly push: Push;
  /** nvidia-smi, meminfo, clock and margins for the fit check; defaults read the real machine. */
  readonly fit?: Omit<FitDeps, "baseUrl">;
  /** Ollama's think flag for every turn; omitted from the request when undefined. */
  readonly think?: boolean;
  readonly sources?: Sources;
  readonly toolsEnabled?: () => boolean;
  readonly newId?: () => string;
  readonly log?: (line: string) => void;
  /**
   * Settings, GPU status, catalog, downloads and preloading (built in main
   * from settings/, fit/ and runtime/), plus the loader: a turn reserves its
   * model before its first await and runs its fit inside the load gate
   * (admit), which pushes models.load around a turn whose model is not resident.
   */
  readonly models?: { readonly handlers: Partial<Handlers>; readonly loader?: Pick<ModelLoader, "reserve"> };
  /** Image jobs; a turn's image tool queues one here for its thread (chat.send image: true). */
  readonly image?: ImageModule;
  /**
   * The app's one GPU lease. A turn holds a shared chat claim from just after
   * its reservation to its end, so an image job never runs beside a stream.
   */
  readonly lease?: Pick<GpuLease, "acquire">;
}

export interface App {
  readonly handlers: AppHandlers;
  /** Turns streaming now (or reserved and starting). */
  activeTurns(): number;
  /** Refuse new turns, cancel the active ones and wait for them to end. Idempotent. */
  shutdown(): Promise<void>;
}

interface Turn {
  readonly turnId: string;
  readonly threadId: string;
  readonly model: string;
  readonly controller: AbortController;
  /** Resolves once the turn has pushed its last event and left the registry. */
  readonly ended: Promise<void>;
  /**
   * Set by halt(): a runtime switch ended this turn now, whatever it waits on. Its one terminal
   * event carries this error's code; the reply sent so far is saved.
   */
  halted: AppError | undefined;
  /** Resolves with halted. */
  readonly onHalt: Promise<typeof HALTED>;
  halt(reason: AppError): void;
  /**
   * Admitted: its model holds (or is loading into) GPU memory, so a later load plans around it.
   * Set inside the load gate when its fit passes, before the user message is saved.
   */
  started: boolean;
}

/**
 * The think flag a turn sends: none when /api/show lists the model's
 * capabilities without "thinking". An Ollama that lists none, or a show that
 * fails, keeps the request as asked; the chat request reports a real error.
 */
async function thinkFlag(baseUrl: string, model: string, requested: boolean | undefined, signal: AbortSignal): Promise<boolean | undefined> {
  if (requested === undefined) return undefined;
  let capabilities: readonly string[] | undefined;
  try {
    ({ capabilities } = await fetchShow(baseUrl, model, signal));
  } catch {
    return requested;
  }
  return capabilities === undefined || capabilities.includes("thinking") ? requested : undefined;
}

export function createApp(deps: AppDeps): App {
  const { store, runtime, catalog } = deps;
  const log = deps.log ?? ((line: string) => console.error(`[app] ${line}`));
  const newId = deps.newId ?? randomUUID;
  const turns = new Map<string, Turn>();
  const byThread = new Map<string, Turn>();
  let closing = false;

  const push: Push = (channel, payload) => {
    try {
      deps.push(channel, payload);
    } catch (e) {
      log(`push ${channel} failed: ${(e as Error).message}`);
    }
  };

  const refreshModels = () => {
    catalog.refresh().catch((e: unknown) => log(`model refresh failed: ${(e as Error).message}`));
  };
  const offRuntime = runtime.onChange((status) => {
    push("runtime.changed", status);
    refreshModels();
  });
  const offCatalog = catalog.onChange((models) => push("models.changed", models));
  const offSources = deps.sources?.onChange(sources => push("sources.changed", sources));

  /** Claims the thread synchronously so a second send cannot slip in during the fit check. */
  const reserve = (threadId: string, model: string): { turn: Turn; end: () => void } => {
    let end!: () => void;
    const ended = new Promise<void>((resolve) => (end = resolve));
    let wake!: (h: typeof HALTED) => void;
    const onHalt = new Promise<typeof HALTED>((resolve) => (wake = resolve));
    const turn: Turn = {
      turnId: newId(),
      threadId,
      model,
      controller: new AbortController(),
      ended,
      halted: undefined,
      onHalt,
      halt(reason) {
        if (turn.halted !== undefined) return;
        turn.halted = reason;
        // A turn chat.cancel already aborted keeps that reason on its signal; halted still wins.
        turn.controller.abort(reason);
        wake(HALTED);
      },
      started: false,
    };
    turns.set(turn.turnId, turn);
    byThread.set(threadId, turn);
    return {
      turn,
      end: () => {
        turns.delete(turn.turnId);
        if (byThread.get(threadId) === turn) byThread.delete(threadId);
        end();
      },
    };
  };

  /**
   * The turn's image tool. It queues the job and returns: the job claims the
   * GPU alone, and this turn holds a shared claim until it ends, so waiting
   * here for the picture would wait forever. The job adds the picture to the
   * thread after the reply; a cancelled turn takes its jobs back.
   */
  const queueImageFor = (threadId: string, turnSignal: AbortSignal) => async (prompt: string): Promise<{ jobId: string }> => {
    const job = await deps.image!.generate({ prompt, threadId });
    const takeBack = () => deps.image?.cancel(job.jobId);
    if (turnSignal.aborted) takeBack();
    else turnSignal.addEventListener("abort", takeBack, { once: true });
    return job;
  };

  const runTurn = async (turn: Turn, end: () => void, baseUrl: string, model: string, numCtx: number, messages: TurnMessage[], load?: TurnLoad, options: { tools?: boolean; think?: boolean; image?: boolean } = {}) => {
    const { turnId, threadId, controller } = turn;
    // Exactly the text that reached the client: the reply a halted turn saves.
    let sentText = "";
    let sentThinking = "";
    // The one terminal event (error or done) went out: nothing follows it, a halt included.
    let over = false;
    const emit = (event: WireEvent) => {
      if (over) return;
      if (event.type === "error" || event.type === "done") over = true;
      // Only text means the model answered; an error, cancel or end goes through end() below.
      if (event.type === "delta" || event.type === "thinking") load?.firstToken();
      if (event.type === "delta") sentText += event.text;
      if (event.type === "thinking") sentThinking += event.text;
      push("chat.event", { turnId, threadId, event });
    };
    /** halt() ended the turn: save the text and thinking sent so far, then its one terminal event. */
    const endHalted = (reason: AppError) => {
      if (over) return;
      let partial: Message | undefined;
      if (sentText !== "" || sentThinking !== "") {
        try {
          partial = store.appendMessage({ threadId, role: "assistant", content: sentText, ...(sentThinking === "" ? {} : { thinking: sentThinking }), model, stats: { numCtx } });
        } catch (e) {
          log(`turn ${turnId}: stopped reply not saved: ${(e as Error).message}`);
        }
      }
      emit({ type: "error", code: reason.code, message: reason.message, ...(partial ? { partial } : {}), ...(reason.neededBy === undefined ? {} : { neededBy: reason.neededBy }) });
      if (partial) push("threads.changed", { threadId });
    };
    /** `work`, or HALTED as soon as halt() runs; the dropped work finishes in the background. */
    const untilHalted = <T>(work: Promise<T>): Promise<T | typeof HALTED> => {
      work.catch(() => undefined);
      return Promise.race([work, turn.onHalt]);
    };
    try {
      const wantsTools = options.tools ?? deps.toolsEnabled?.() ?? false;
      const sources = wantsTools ? deps.sources?.entries() ?? [] : [];
      // The image tool is offered only when this turn asked for it and image generation is wired.
      const image = options.image === true && deps.image !== undefined;
      const useTools = (wantsTools && sources.length > 0) || image;
      // Ollama refuses think: true for a model that cannot think, so its turns go without the flag.
      const think = await untilHalted(thinkFlag(baseUrl, model, options.think ?? deps.think, controller.signal));
      if (think === HALTED || turn.halted) {
        endHalted(turn.halted!);
        return;
      }
      const input = {
        baseUrl,
        model,
        messages,
        numCtx,
        signal: controller.signal,
        threadId,
        ...(think === undefined ? {} : { think }),
      };
      const events = useTools ? streamToolTurn({ ...input, sources, image, ...(image ? { queueImage: queueImageFor(threadId, controller.signal) } : {}) }) : streamTurn(input);
      const iterator = events[Symbol.asyncIterator]();
      let dropped = false;
      try {
        for (;;) {
          const step = await untilHalted(iterator.next());
          if (step === HALTED || turn.halted) {
            dropped = step === HALTED;
            endHalted(turn.halted!);
            return;
          }
          if (step.done === true) return;
          const event = step.value;
          if (event.type !== "done") {
            emit(event);
            if (over) return;
            continue;
          }
          // A cancel that lands with the done line still wins: nothing persists.
          if (controller.signal.aborted) {
            emit({ type: "error", code: "cancelled", message: "cancelled as the reply finished; not saved" });
            return;
          }
          let saved;
          try {
            saved = store.appendMessage(event.message);
          } catch (e) {
            const code = (e as { code?: unknown }).code;
            emit({ type: "error", code: typeof code === "string" ? code : "internal", message: `reply not saved: ${(e as Error).message}` });
            return;
          }
          emit({ type: "done", message: saved, stopReason: event.stopReason });
          push("threads.changed", { threadId });
          return;
        }
      } finally {
        // The generator's own cleanup (its finally: the socket, a queued image's take-back) runs on
        // every exit. A step a halt dropped is still pending, so that cleanup runs when it settles.
        const cleanup = iterator.return(undefined).catch(() => undefined);
        if (!dropped) await cleanup;
      }
    } catch (e) {
      if (turn.halted) endHalted(turn.halted);
      else {
        log(`turn ${turnId} failed: ${(e as Error).message}`);
        emit({ type: "error", code: "internal", message: (e as Error).message });
      }
    } finally {
      load?.end();
      end();
    }
  };

  /**
   * A load of `model` at `numCtx` as the fit plans it (fit/planLoad) beside the admitted turns on
   * other models (a halted one too, until it ends), and the turns it would push out of the GPU.
   * Reads only. Inside the load gate no turn is admitted meanwhile, so the plan is current.
   */
  const planBeside = async (baseUrl: string, model: string, numCtx: number, signal?: AbortSignal): Promise<{ report: FitReport; stop: Turn[] }> => {
    const running = [...turns.values()].filter((t) => t.started && !sameModel(t.model, model));
    const plan = await planLoad({ ...deps.fit, baseUrl, model, numCtx, busy: running.map((t) => t.model), ...(signal ? { signal } : {}) });
    return { report: plan.report, stop: running.filter((t) => plan.stop.some((n) => sameModel(n, t.model))) };
  };

  const cancelThreadTurn = async (threadId: string) => {
    const turn = byThread.get(threadId);
    if (turn === undefined) return;
    turn.controller.abort();
    await turn.ended;
  };

  const handlers = {
    ...deps.models?.handlers,
    ...(deps.image ? createImageHandlers({ image: deps.image }) : {}),
    ...(deps.sources ? createSourcesHandlers({ sources: deps.sources }) : {}),
    "threads.list": () => store.listThreads(),
    "threads.create": ({ title }) => {
      const thread = store.createThread(title === undefined ? {} : { title });
      push("threads.changed", { threadId: thread.id });
      return thread;
    },
    "threads.get": ({ threadId }) => store.getThread(threadId),
    "threads.rename": ({ threadId, title }) => {
      const thread = store.renameThread(threadId, title);
      push("threads.changed", { threadId });
      return thread;
    },
    "threads.delete": async ({ threadId }) => {
      await cancelThreadTurn(threadId);
      store.deleteThread(threadId);
      push("threads.changed", { threadId });
      return { threadId };
    },

    "models.list": async () => catalog.current() ?? (await catalog.refresh()).models,
    "models.refresh": async () => (await catalog.refresh()).models,

    "runtime.status": () => runtime.status(),

    "fit.check": async ({ model, numCtx }) => {
      const baseUrl = runtime.baseUrl();
      if (baseUrl === undefined) throw notReady();
      return (await checkFit({ ...deps.fit, baseUrl, model, numCtx })).report;
    },

    "turns.blocking": async ({ model, numCtx }) => {
      if (![...turns.values()].some((t) => t.started)) return [];
      const baseUrl = runtime.baseUrl();
      if (baseUrl === undefined) throw notReady();
      const blocking = (await planBeside(baseUrl, model, numCtx)).stop;
      const titles = new Map(store.listThreads().map((t) => [t.id, t.title]));
      return blocking.map((t) => ({ threadId: t.threadId, title: titles.get(t.threadId) ?? "", model: t.model }));
    },

    "chat.send": async ({ threadId, content, model, numCtx, tools, think, image, stopOthers }) => {
      if (closing) throw new AppError("shutting-down", "the server is stopping; no new turns");
      const active = byThread.get(threadId);
      if (active !== undefined) throw new AppError("turn-active", `thread ${threadId} already has turn ${active.turnId} streaming; cancel it or wait`);
      store.getThread(threadId); // thread-not-found before anything is reserved
      const { turn, end: endTurn } = reserve(threadId, model);
      let releaseGpu: (() => void) | undefined;
      // Every way a turn ends goes through end(): the GPU claim goes with it.
      const end = () => {
        releaseGpu?.();
        endTurn();
      };
      let load: TurnReservation | undefined;
      let started = false;
      try {
        // Before the first await, so models.remove sees this turn at once (throws while a removal runs).
        load = deps.models?.loader?.reserve(model);
        // A runtime switch ends this turn now, at every phase; the switch waits for its end().
        // The loader's close (shutdown) cancels it the way chat.cancel does.
        const reservation = load;
        if (reservation !== undefined) {
          const runtimeGone = () => {
            const reason: unknown = reservation.signal.reason;
            if (reason instanceof ModelActionError && reason.code === "shutting-down") turn.controller.abort(reason);
            else turn.halt(runtimeChangedTurn());
          };
          if (reservation.signal.aborted) runtimeGone();
          else reservation.signal.addEventListener("abort", runtimeGone, { once: true });
        }
        // Before it started: a cancel, or the runtime switch above.
        const stoppedEarly = () => turn.halted ?? new AppError("cancelled", "the turn was cancelled before it started");
        // The runtime the reservation captured: fit, admit and chat all talk to it.
        const baseUrl = load ? load.baseUrl : runtime.baseUrl();
        if (baseUrl === undefined) throw notReady();
        // The fit, planned beside the admitted turns. stopOthers ends the ones whose model holds
        // memory this load needs, the way a switch does (each saves what it sent and ends
        // "preempted"), waits for them and plans again until none is in the way: the plan that
        // returns counts their memory, idle by then, as free. Without it, Ollama queues this load
        // until those turns end on their own. It runs before the ComfyUI reclaim (a turn it stops
        // holds a chat claim the reclaim's exclusive one would wait on) and again inside admit's
        // load gate, where the decision is current: no turn is admitted while this one plans.
        // admit passes its own signal (the turn's and the runtime's); every other caller passes the turn's.
        const fit = async (signal: AbortSignal): Promise<FitReport> => {
          for (;;) {
            const { report, stop } = await planBeside(baseUrl, model, numCtx, signal);
            if (stopOthers !== true || stop.length === 0) return report;
            for (const t of stop) t.halt(preemptedBy(model, numCtx, t.model));
            await untilAborted(Promise.all(stop.map((t) => t.ended)), signal);
          }
        };
        // An idle ComfyUI this app started is the one GPU tenant a turn may free. stopIdle claims the
        // GPU alone, so it runs before this turn's own claim: a nested claim would wait on itself.
        // A cancel, switch or shutdown ends the reclaim at once, unless its ComfyUI stop has begun:
        // the turn then ends with the stop, so a switch's drain waits for it (or fails the switch).
        if (deps.image?.current().owner === "app") {
          const comfy = deps.image;
          const signal = turn.controller.signal;
          try {
            if ((await fit(signal)).verdict !== "fits") await comfy.stopIdle(signal);
          } catch (e) {
            if (signal.aborted) throw stoppedEarly();
            throw e;
          }
        }
        // Waits while an image job holds the GPU; admit's load gate runs inside this claim.
        try {
          releaseGpu = await deps.lease?.acquire("chat", turn.controller.signal);
        } catch {
          throw stoppedEarly();
        }
        // Inside the gate: a passing fit admits the turn, so the next load plans around it.
        const admitted = async (signal: AbortSignal) => {
          const r = await fit(signal);
          if (r.verdict !== "refuse") turn.started = true;
          return r;
        };
        let report: FitReport;
        try {
          report = load ? await load.admit(numCtx, { fit: admitted, signal: turn.controller.signal }) : await admitted(turn.controller.signal);
        } catch (e) {
          if (e instanceof AdmitCancelled || turn.halted) throw stoppedEarly();
          throw e;
        }
        if (report.verdict === "refuse") {
          throw new AppError("wont-fit", report.message ?? `${model} at num_ctx ${numCtx} does not fit (fit check refused).`, report);
        }
        if (turn.controller.signal.aborted) throw stoppedEarly();
        const userMessage = store.appendMessage({ threadId, role: "user", content });
        push("threads.changed", { threadId });
        const history = store.getThread(threadId).messages.map((m): TurnMessage => ({ role: m.role, content: m.content }));
        started = true;
        turn.started = true;
        void runTurn(turn, end, baseUrl, model, numCtx, history, load, { tools, think, image });
        return { turnId: turn.turnId, userMessage };
      } finally {
        if (!started) {
          load?.end();
          end();
        }
      }
    },

    "chat.cancel": ({ turnId }) => {
      const turn = turns.get(turnId);
      if (turn === undefined || turn.controller.signal.aborted) return { cancelled: false };
      turn.controller.abort();
      return { cancelled: true };
    },
  } satisfies AppHandlers;

  function notReady(): AppError {
    const s = runtime.status();
    return new AppError("runtime-not-ready", `Ollama is not ready (${s.state}${s.detail ? `: ${s.detail}` : ""}).`);
  }

  return {
    handlers,
    activeTurns: () => turns.size,
    async shutdown() {
      closing = true;
      offRuntime();
      offCatalog();
      offSources?.();
      const pending = [...turns.values()];
      for (const t of pending) t.controller.abort();
      await Promise.all(pending.map((t) => t.ended));
    },
  };
}
