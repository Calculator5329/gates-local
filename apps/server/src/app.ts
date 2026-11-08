// The server's handlers: every contracts method wired onto the thread store,
// the Ollama runtime, the model catalog, the fit check and the streamed turn.
// main.ts only parses flags and owns the process; tests drive this directly.
//
// A chat turn: one active turn per thread, a ready runtime, a fit verdict
// other than refuse; then the user message persists, the reply streams on
// chat.event and only the finished assistant message reaches the store.
import { randomUUID } from "node:crypto";
import type { Channel, Params, Payload } from "@gates-local/contracts";
import { streamTurn } from "./chat/stream.ts";
import { streamToolTurn } from "./chat/tools.ts";
import type { Sources } from "./sources/index.ts";
import { createSourcesHandlers } from "./sources/handlers.ts";
import type { TurnMessage } from "./chat/types.ts";
import { checkFit, type FitDeps } from "./fit/fit.ts";
import { fetchShow } from "./fit/ollama.ts";
import type { FitReport } from "./fit/types.ts";
import { AdmitCancelled, type ModelLoader, type TurnLoad, type TurnReservation } from "./runtime/load.ts";
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
  | "thread-not-found" // the store's code, also thrown while the thread's delete runs
  | "shutting-down"; // the server is stopping and takes no new turns

export class AppError extends Error {
  override readonly name = "AppError";
  readonly code: AppErrorCode;
  /** The refusing report, for wont-fit. Not on the wire (the message carries it). */
  readonly report?: FitReport;
  constructor(code: AppErrorCode, message: string, report?: FitReport) {
    super(message);
    this.code = code;
    if (report !== undefined) this.report = report;
  }
}

const threadGoing = (threadId: string) => new AppError("thread-not-found", `thread ${threadId} is being deleted`);
const cancelledBeforeStart = () => new AppError("cancelled", "the turn was cancelled before it started");

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
  readonly controller: AbortController;
  /** Resolves once the turn has pushed its last event and left the registry. */
  readonly ended: Promise<void>;
}

/**
 * The think flag a turn sends: none when /api/show lists the model's
 * capabilities without "thinking". An Ollama that lists none, or a show that
 * fails, keeps the request as asked; the chat request reports a real error.
 * The turn's signal ends the probe: a cancel never waits on a stalled show
 * (the aborted turn then ends as cancelled before any chat request).
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
  const reserve = (threadId: string): { turn: Turn; end: () => void } => {
    let end!: () => void;
    const ended = new Promise<void>((resolve) => (end = resolve));
    const turn: Turn = { turnId: newId(), threadId, controller: new AbortController(), ended };
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

  /** Threads whose threads.delete is running: marked before its first await, cleared when it ends. */
  const deleting = new Set<string>();

  /**
   * Image jobs queued for a thread (its turns' tool, or image.generate with its
   * threadId), until each job's wait settles: threads.delete takes them back.
   * Each entry is the job id as a promise, so a generate still in flight counts.
   */
  const imageJobs = new Map<string, Set<Promise<string>>>();

  /** Queues the job and, with a threadId, keeps it for threads.delete. Refuses a thread being deleted. */
  const queueImage = (image: ImageModule, params: Params<"image.generate">): Promise<{ jobId: string }> => {
    const { threadId } = params;
    if (threadId === undefined) return image.generate(params);
    if (deleting.has(threadId)) return Promise.reject(threadGoing(threadId));
    const jobs = imageJobs.get(threadId) ?? new Set<Promise<string>>();
    imageJobs.set(threadId, jobs);
    const queued = image.generate(params).then((job) => job.jobId);
    jobs.add(queued);
    void queued.then((id) => image.wait(id)).catch(() => undefined).finally(() => {
      jobs.delete(queued);
      if (jobs.size === 0 && imageJobs.get(threadId) === jobs) imageJobs.delete(threadId);
    });
    return queued.then((jobId) => ({ jobId }));
  };

  /**
   * The turn's image tool. It queues the job and returns: the job claims the
   * GPU alone, and this turn holds a shared claim until it ends, so waiting
   * here for the picture would wait forever. The job adds the picture to the
   * thread after the reply; a cancelled turn takes its jobs back, and so does
   * deleting the thread after the turn ended.
   */
  const queueImageFor = (threadId: string, turnSignal: AbortSignal) => async (prompt: string): Promise<{ jobId: string }> => {
    const job = await queueImage(deps.image!, { prompt, threadId });
    const takeBack = () => deps.image?.cancel(job.jobId);
    if (turnSignal.aborted) takeBack();
    else turnSignal.addEventListener("abort", takeBack, { once: true });
    return job;
  };

  const runTurn = async (turn: Turn, end: () => void, baseUrl: string, model: string, numCtx: number, messages: TurnMessage[], load?: TurnLoad, options: { tools?: boolean; think?: boolean; image?: boolean } = {}) => {
    const { turnId, threadId, controller } = turn;
    const emit = (event: WireEvent) => {
      // Only text means the model answered; an error, cancel or end goes through end() below.
      if (event.type === "delta" || event.type === "thinking") load?.firstToken();
      push("chat.event", { turnId, threadId, event });
    };
    try {
      const wantsTools = options.tools ?? deps.toolsEnabled?.() ?? false;
      const sources = wantsTools ? deps.sources?.entries() ?? [] : [];
      // The image tool is offered only when this turn asked for it and image generation is wired.
      const image = options.image === true && deps.image !== undefined;
      const useTools = (wantsTools && sources.length > 0) || image;
      // Ollama refuses think: true for a model that cannot think, so its turns go without the flag.
      const think = await thinkFlag(baseUrl, model, options.think ?? deps.think, controller.signal);
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
      for await (const event of events) {
        if (event.type !== "done") {
          emit(event);
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
    } catch (e) {
      log(`turn ${turnId} failed: ${(e as Error).message}`);
      emit({ type: "error", code: "internal", message: (e as Error).message });
    } finally {
      load?.end();
      end();
    }
  };

  const cancelThreadTurn = async (threadId: string) => {
    const turn = byThread.get(threadId);
    if (turn === undefined) return;
    turn.controller.abort();
    await turn.ended;
  };

  /** Cancels every image job queued for this thread that has not settled, and waits for each to end. */
  const cancelThreadImages = async (threadId: string) => {
    const image = deps.image;
    const queued = [...(imageJobs.get(threadId) ?? [])];
    if (image === undefined || queued.length === 0) return;
    const ids = (await Promise.all(queued.map((p) => p.catch(() => undefined)))).filter((id) => id !== undefined);
    for (const id of ids) image.cancel(id);
    await Promise.all(ids.map((id) => image.wait(id).catch(() => undefined)));
  };

  const handlers = {
    ...deps.models?.handlers,
    ...(deps.image ? createImageHandlers({ image: deps.image }) : {}),
    // Kept per thread like the tool's jobs, so threads.delete takes them back too.
    ...(deps.image ? { "image.generate": (params: Params<"image.generate">) => queueImage(deps.image!, params) } : {}),
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
      // Before the first await: no new turn or image job for this thread from here on.
      const marked = !deleting.has(threadId);
      deleting.add(threadId);
      try {
        await cancelThreadTurn(threadId);
        // After the turn: its cancel takes back what it queued, and a finished turn's jobs are still here.
        await cancelThreadImages(threadId);
        store.deleteThread(threadId);
      } finally {
        if (marked) deleting.delete(threadId);
      }
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

    "chat.send": async ({ threadId, content, model, numCtx, tools, think, image }) => {
      if (closing) throw new AppError("shutting-down", "the server is stopping; no new turns");
      // The thread is going: its delete has already listed what it takes back.
      if (deleting.has(threadId)) throw threadGoing(threadId);
      const active = byThread.get(threadId);
      if (active !== undefined) throw new AppError("turn-active", `thread ${threadId} already has turn ${active.turnId} streaming; cancel it or wait`);
      store.getThread(threadId); // thread-not-found before anything is reserved
      const { turn, end: endTurn } = reserve(threadId);
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
        const baseUrl = runtime.baseUrl();
        if (baseUrl === undefined) throw notReady();
        // The fit check takes no signal: the turn stops waiting on a cancel (its claim goes with end()),
        // and a fit error that lands after the cancel is the cancel.
        const signal = turn.controller.signal;
        const fit = async () => {
          if (signal.aborted) throw cancelledBeforeStart();
          let onAbort: (() => void) | undefined;
          const aborted = new Promise<never>((_, reject) => {
            onAbort = () => reject(cancelledBeforeStart());
            signal.addEventListener("abort", onAbort, { once: true });
          });
          try {
            return (await Promise.race([checkFit({ ...deps.fit, baseUrl, model, numCtx }), aborted])).report;
          } catch (e) {
            if (signal.aborted) throw cancelledBeforeStart();
            throw e;
          } finally {
            if (onAbort) signal.removeEventListener("abort", onAbort);
          }
        };
        // Waits while an image job holds the GPU; admit's load gate runs inside this claim.
        const claim = async () => {
          try {
            releaseGpu = await deps.lease?.acquire("chat", turn.controller.signal);
          } catch {
            throw new AppError("cancelled", "the turn was cancelled before it started");
          }
        };
        await claim();
        // An idle ComfyUI this app started is the one GPU tenant a turn may free. The check runs inside
        // the claim, so a ComfyUI an image job started while this turn waited counts. stopIdle claims
        // the GPU alone: the turn lets its claim go first (a nested claim would wait on itself), then
        // claims again and measures again. An image queued behind the turn runs in that gap and
        // stopIdle declines while it is registered, so only an owner that is no longer app counts as
        // stopped: the turn tries again, at most three times, then admission decides as usual.
        let measured = deps.image?.current().owner === "app" ? await fit() : undefined;
        for (let attempt = 0; attempt < 3 && measured !== undefined && measured.verdict !== "fits" && deps.image?.current().owner === "app"; attempt += 1) {
          if (turn.controller.signal.aborted) throw new AppError("cancelled", "the turn was cancelled before it started");
          releaseGpu?.();
          releaseGpu = undefined;
          await deps.image.stopIdle();
          await claim();
          measured = await fit();
        }
        let report: FitReport;
        try {
          report = load ? await load.admit(numCtx, { fit, signal: turn.controller.signal }) : measured ?? (await fit());
        } catch (e) {
          if (e instanceof AdmitCancelled) throw new AppError("cancelled", "the turn was cancelled before it started");
          throw e;
        }
        if (report.verdict === "refuse") {
          throw new AppError("wont-fit", report.message ?? `${model} at num_ctx ${numCtx} does not fit (fit check refused).`, report);
        }
        if (turn.controller.signal.aborted) throw new AppError("cancelled", "the turn was cancelled before it started");
        const userMessage = store.appendMessage({ threadId, role: "user", content });
        push("threads.changed", { threadId });
        const history = store.getThread(threadId).messages.map((m): TurnMessage => ({ role: m.role, content: m.content }));
        started = true;
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
