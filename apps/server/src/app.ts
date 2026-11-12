// The server's handlers: every contracts method wired onto the thread store,
// the Ollama runtime, the model catalog, the fit check and the streamed turn.
// main.ts only parses flags and owns the process; tests drive this directly.
//
// A chat turn: one active turn per thread, a ready runtime, a fit verdict
// other than refuse; then the user message persists and the reply streams on
// chat.event. A finished reply is saved complete; any other end keeps the words
// sent so far, marked interrupted (runTurn's finish).
import { randomUUID } from "node:crypto";
import { accountImages, checkAttachments, imagePrompt, saveAttachments, visionHistory } from "./chat/attachments.ts";
import { imageLifecycle } from "./chat/image-lifecycle.ts";
import { fitToWindow, IMAGE_CONTEXT_NOTICE, OMITTED_IMAGE } from "./chat/window.ts";
import type { BlockingTurn, Channel, ImageChoice, Message, Params, Payload, SyncChange, ToolStep } from "@gates-local/contracts";
import { streamTurn, type UsageFigures } from "./chat/stream.ts";
import { streamToolTurn } from "./chat/tools.ts";
import type { Sources } from "./sources/index.ts";
import { createSourcesHandlers } from "./sources/handlers.ts";
import type { LibraryImports } from "./sources/imports.ts";
import type { ChatEvent, TurnMessage } from "./chat/types.ts";
import { planLoad, type FitDeps } from "./fit/fit.ts";
import { untilAborted } from "./fit/gpu.ts";
import { fetchShow, sameModel } from "./fit/ollama.ts";
import { createFitTable, type FitTableSource } from "./fit/table.ts";
import type { FitReport } from "./fit/types.ts";
import { catalogModels } from "./runtime/catalog.ts";
import { AdmitCancelled, ModelActionError, type ModelLoader, type TurnLoad, type TurnReservation } from "./runtime/load.ts";
import type { ModelCatalog } from "./runtime/models.ts";
import type { RuntimeSwitch } from "./runtime/switch.ts";
import type { ThreadStore } from "./threads/store.ts";
import type { NewMessage } from "./threads/types.ts";
import type { Handlers } from "./ws/server.ts";
import { createImageHandlers } from "./image/handlers.ts";
import type { ImageModule } from "./image/module.ts";
import type { GpuLease } from "./gpu/lease.ts";
import { createUpdateHandlers, type UpdateModule } from "./update/module.ts";
import type { Usage } from "./usage/index.ts";
import type { SettingsReader } from "./settings/store.ts";
import { turnSettings, type TurnSettings } from "./settings/turn.ts";

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
  | "fit.table"
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
  | "would-stop" // chat.send askFirst: running turns are in the way (error.blocking); nothing was saved or stopped
  | "thread-not-found" // the store's code, also thrown while the thread's delete runs
  | "image-input"
  | "shutting-down"; // the server is stopping and takes no new turns

export class AppError extends Error {
  override readonly name = "AppError";
  readonly code: AppErrorCode;
  /** The refusing report, for wont-fit. Not on the wire (the message carries it). */
  readonly report?: FitReport;
  /** For preempted: the model whose load needed the GPU (the terminal event's neededBy). */
  readonly neededBy?: string;
  /** For would-stop: the running turns in the way, on the wire as error.blocking. */
  readonly blocking?: readonly BlockingTurn[];
  constructor(code: AppErrorCode, message: string, report?: FitReport, neededBy?: string, blocking?: readonly BlockingTurn[]) {
    super(message);
    this.code = code;
    if (report !== undefined) this.report = report;
    if (neededBy !== undefined) this.neededBy = neededBy;
    if (blocking !== undefined) this.blocking = blocking;
  }
}

/** A runtime switch ended the turn; the reply streamed so far is saved as a stopped reply. */
export const RUNTIME_CHANGED_TURN_MESSAGE = "The Ollama runtime changed while this reply was running, so it stopped. Send the message again.";
const runtimeChangedTurn = (): AppError => new AppError("runtime-changed", RUNTIME_CHANGED_TURN_MESSAGE);
/** What a Retry of `questionId` replaces: that question and the unfinished rows after it. None once something else was asked or a finished reply followed: then it is a new question. */
function retriedRows(messages: readonly { readonly id: string; readonly role: string; readonly interrupted?: true; readonly imageJob?: { readonly state: string } }[], questionId: string): string[] {
  const rows = messages.slice(messages.findLastIndex((m) => m.role === "user"));
  // A picture that failed or was cancelled is unfinished the way a stopped reply is.
  const unfinished = (m: (typeof rows)[number]) => m.interrupted === true || m.imageJob?.state === "error" || m.imageJob?.state === "cancelled";
  return rows[0]?.id === questionId && rows.slice(1).every(unfinished) ? rows.map((m) => m.id) : [];
}

const HALTED = Symbol("halted");
/** chat.send stopOthers ended this turn: `model`'s load needed the GPU memory `held` was using. */
const preemptedBy = (model: string, numCtx: number, held: string): AppError =>
  new AppError("preempted", `${model} at num_ctx ${numCtx} needed the GPU memory ${held} was using, so this reply stopped. Send the message again.`, undefined, model);
const threadGoing = (threadId: string) => new AppError("thread-not-found", `thread ${threadId} is being deleted`);
const cancelledBeforeStart = () => new AppError("cancelled", "the turn was cancelled before it started");

export type Push = <C extends Channel>(channel: C, payload: Payload<C>, changes?: readonly SyncChange[]) => void;
type WireEvent = Payload<"chat.event">["event"];
type TurnEnd = Extract<WireEvent, { type: "done" | "error" }>;
type TurnFailure = Extract<WireEvent, { type: "error" }>;
type StreamDone = Extract<ChatEvent, { type: "done" }>;
/** A halt's one terminal event: its error's code, message and, for preempted, the model that needed the GPU. */
const haltedEnd = (reason: AppError): TurnFailure => ({ type: "error", code: reason.code, message: reason.message, ...(reason.neededBy === undefined ? {} : { neededBy: reason.neededBy }) });

export interface AppDeps {
  readonly admit?: () => void;
  readonly dataDir?: string;
  readonly store: ThreadStore;
  readonly runtime: Pick<RuntimeSwitch, "status" | "baseUrl" | "onChange" | "ensure" | "lookIfDown">;
  readonly catalog: ModelCatalog;
  /** Bound late: main creates the ws server after the handlers. */
  readonly push: Push;
  /** nvidia-smi, meminfo, clock and margins for the fit check; defaults read the real machine. */
  readonly fit?: Omit<FitDeps, "baseUrl">;
  /** Ollama's think flag for every turn; omitted from the request when undefined. */
  readonly think?: boolean;
  readonly settings?: Pick<SettingsReader, "get">;
  readonly sources?: Sources;
  readonly libraryImports?: LibraryImports;
  readonly toolsEnabled?: () => boolean;
  readonly newId?: () => string;
  readonly log?: (line: string) => void;
  /** How often a streaming reply is rewritten on disk; a crash loses at most this much. Defaults to a second. */
  readonly draftEveryMs?: number;
  /**
   * Settings, GPU status, catalog, downloads and preloading (built in main
   * from settings/, fit/ and runtime/), plus the loader: a turn reserves its
   * model before its first await and runs its fit inside the load gate
   * (admit), which pushes models.load around a turn whose model is not resident.
   */
  readonly models?: { readonly handlers: Partial<Handlers>; readonly loader?: Pick<ModelLoader, "reserve"> };
  /** Image jobs: chat.send draw (Image mode) and a chat turn's image tool queue them here for their thread. */
  readonly image?: ImageModule;
  /**
   * Tools › Make images: the preset and size a chat turn's image tool uses, or undefined while
   * that switch (or image generation) is off and no chat turn is offered the tool.
   */
  readonly imageTool?: () => ImageChoice | undefined;
  /**
   * The app's one GPU lease. A turn holds a shared chat claim from just after
   * its reservation to its end, so an image job never runs beside a stream.
   */
  readonly lease?: Pick<GpuLease, "acquire">;
  /** Settings › Updates: the version, the one-click check and the last update's result (update/module.ts). */
  readonly update?: UpdateModule;
  /** Token counts per hour and model (usage/); each model request's done line records here. */
  readonly usage?: Pick<Usage, "record">;
}

export interface App {
  readonly handlers: AppHandlers;
  /** Turns streaming now (or reserved and starting). */
  activeTurns(): number;
  /** Send only this client's current in-flight words before it starts receiving newer events. */
  replayTurns(target: Push): void;
  /** The fit table: main feeds it the GPU watcher's gpu.changed and the loader's models.load. */
  readonly fitTable: Pick<FitTableSource, "changed" | "load">;
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
  /**
   * An Image mode turn: one image job, no chat model. It runs (turns.active lists it) but never
   * counts as a chat model in GPU memory: the job's own GPU claim covers it.
   */
  drawing?: true;
  terminal: boolean;
  start?: Extract<WireEvent, { type: "start" }>;
  /** The reply's row on disk while it streams. threads.get hides it: this reply reaches clients as its live turn. */
  draftId: string | undefined;
  /** Its thread or the question it answers is being deleted: the reply is dropped, not saved. */
  dropReply: boolean;
  text: string;
  thinking: string;
  contextNotice?: string;
  readonly steps: Map<string, ToolStep>;
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
  const imageFiles = deps.dataDir ? imageLifecycle(deps.dataDir, store) : undefined;
  const imageReady = imageFiles?.sweep() ?? Promise.resolve();
  const draftEveryMs = deps.draftEveryMs ?? 1000;
  const turns = new Map<string, Turn>();
  const byThread = new Map<string, Turn>();
  let closing = false;

  const push: Push = (channel, payload, changes) => {
    try {
      deps.push(channel, payload, changes);
    } catch (e) {
      log(`push ${channel} failed: ${(e as Error).message}`);
    }
  };

  const refreshModels = () => {
    catalog.refresh().catch((e: unknown) => log(`model refresh failed: ${(e as Error).message}`));
  };
  // Every model at every offered context from one reading, pushed when what it reads changes.
  const fitTable = createFitTable({
    baseUrl: () => runtime.baseUrl(),
    ...(deps.fit ? { fit: deps.fit } : {}),
    models: async () => catalogModels(catalog.current() ?? (await catalog.refresh()).models),
    busy: () => [...turns.values()].filter((t) => t.started).map((t) => t.model),
    comfyPid: () => reclaimableComfy(),
    push: (table) => push("fit.changed", table),
    log,
  });
  const offRuntime = runtime.onChange((status) => {
    push("runtime.changed", status);
    refreshModels();
    fitTable.changed();
  });
  const offCatalog = catalog.onChange((models) => {
    push("models.changed", models);
    fitTable.changed();
  });
  /** Measured speeds change only when a finished reply is saved or replies are deleted; one read then, never per word. */
  const pushSpeeds = () => {
    try {
      push("models.speed", store.modelSpeeds());
    } catch (e) {
      log(`model speeds not read: ${(e as Error).message}`);
    }
  };
  const offSources = deps.sources?.onChange(sources => push("sources.changed", sources));
  const offImports = deps.libraryImports?.onChange(value => push("sources.imports", value));

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
      terminal: false,
      draftId: undefined,
      dropReply: false,
      text: "",
      thinking: "",
      steps: new Map(),
    };
    turns.set(turn.turnId, turn);
    byThread.set(threadId, turn);
    return {
      turn,
      end: () => {
        turns.delete(turn.turnId);
        if (byThread.get(threadId) === turn) byThread.delete(threadId);
        end();
        // An admitted turn's model was busy in every row's plan; now it is not.
        if (turn.started) fitTable.changed();
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
  const queueImageFor = (threadId: string, turnSignal: AbortSignal, choice: ImageChoice) => async (prompt: string): Promise<{ jobId: string }> => {
    const job = await queueImage(deps.image!, { prompt, threadId, choice });
    const takeBack = () => deps.image?.cancel(job.jobId);
    if (turnSignal.aborted) takeBack();
    else turnSignal.addEventListener("abort", takeBack, { once: true });
    return job;
  };

  const runTurn = async (turn: Turn, end: () => void, baseUrl: string, model: string, numCtx: number, messages: TurnMessage[], load?: TurnLoad, options: { tools?: boolean; think?: boolean; contextNotice?: string; settings?: TurnSettings } = {}) => {
    const { turnId, threadId, controller } = turn;
    // Exactly the text that reached the client: the reply a halted turn saves.
    turn.contextNotice = options.contextNotice;
    let noticeSent = false;
    let counted = false;
    const imageOmitted = () => {
      turn.contextNotice = IMAGE_CONTEXT_NOTICE;
      if (noticeSent || turn.terminal || controller.signal.aborted) return;
      noticeSent = true;
      // Send metadata before words using the trimmed context, without marking a first token.
      push("chat.event", { turnId, threadId, event: { type: "delta", text: "", contextNotice: turn.contextNotice } });
    };
    const emit = (event: Exclude<WireEvent, TurnEnd>) => {
      if (turn.terminal) return;
      // Only text means the model answered; an error, cancel or end goes through end() below.
      if (event.type === "delta" || event.type === "thinking") load?.firstToken();
      if (event.type === "delta") turn.text += event.text;
      if (event.type === "thinking") turn.thinking += event.text;
      if (event.type === "tool") turn.steps.set(event.step.callId, event.step);
      push("chat.event", { turnId, threadId, event });
      keepDraft();
    };
    const nothingYet = () => turn.text === "" && turn.thinking === "" && turn.steps.size === 0;
    const replacingDraft = () => (turn.draftId === undefined ? [] : [turn.draftId]);
    /**
     * A call still running is saved as "error", marked stopped when a halt (a runtime switch, a load that
     * needed the GPU, the app closing) ended the turn. A cancel needs no mark here: the harness has already
     * closed its running call as stopped (loop.ts) before the turn ends.
     */
    const unfinishedRow = (halted = false): NewMessage => {
      const tools = [...turn.steps.values()].map((t) => t.state === "running" ? { ...t, state: "error" as const, ...(halted ? { stopped: true as const } : {}) } : t);
      return { threadId, role: "assistant", content: turn.text, interrupted: true, ...(turn.thinking === "" ? {} : { thinking: turn.thinking }), ...(tools.length === 0 ? {} : { tools }), model, stats: { numCtx }, ...(turn.contextNotice ? { contextNotice: turn.contextNotice } : {}) };
    };
    let drafted = false;
    let draftTimer: ReturnType<typeof setTimeout> | undefined;
    /** The reply so far on disk, marked interrupted, so a crash needs no recovery pass. Each write and the final save replace this one row. */
    const writeDraft = () => {
      draftTimer = undefined;
      if (turn.terminal || turn.dropReply) return;
      try {
        turn.draftId = store.appendMessage(unfinishedRow(), replacingDraft()).id;
      } catch (e) {
        log(`turn ${turnId}: reply in progress not written: ${(e as Error).message}`);
      }
    };
    /** Written at the first words, then at most once per draftEveryMs. */
    const keepDraft = () => {
      if (nothingYet()) return;
      if (drafted) draftTimer ??= setTimeout(writeDraft, draftEveryMs);
      else {
        drafted = true;
        writeDraft();
      }
    };
    /** The words the person saw, saved marked interrupted. Nothing is written for a reply with no words yet, or one whose thread or question is being deleted. */
    const saveUnfinished = (failure: TurnFailure): TurnFailure => {
      try {
        if (turn.dropReply) {
          if (turn.draftId !== undefined) store.deleteMessage(threadId, turn.draftId);
          return failure;
        }
        if (nothingYet()) return failure;
        return { ...failure, partial: store.appendMessage(unfinishedRow(turn.halted !== undefined), replacingDraft()) };
      } catch (e) {
        log(`turn ${turnId}: stopped reply not saved: ${(e as Error).message}`);
        return failure;
      }
    };
    /** The finished reply, saved complete. A store that refuses it keeps the words as an unfinished reply and ends the turn with that error. */
    const saveFinished = (done: StreamDone): TurnEnd => {
      try {
        const notice = turn.contextNotice ?? done.message.contextNotice;
        return { ...done, message: store.appendMessage({ ...done.message, ...(notice ? { contextNotice: notice } : {}) }, replacingDraft()) };
      } catch (e) {
        const code = (e as { code?: unknown }).code;
        return saveUnfinished({ type: "error", code: typeof code === "string" ? code : "internal", message: `the final save failed: ${(e as Error).message}` });
      }
    };
    /** Every way a turn ends comes here, once: it decides what is saved and sends the one terminal event. */
    const finish = (outcome: StreamDone | TurnFailure) => {
      if (turn.terminal) return;
      turn.terminal = true;
      clearTimeout(draftTimer);
      // Done wins over a Stop, never over deleting the thread or the question.
      const dropped = outcome.type === "done" && turn.dropReply ? { type: "error" as const, code: "cancelled" as const, message: "cancelled: its question was deleted" } : outcome;
      const event = dropped.type === "done" ? saveFinished(dropped) : saveUnfinished(dropped);
      push("chat.event", { turnId, threadId, event: event.type === "error" && turn.contextNotice ? { ...event, contextNotice: turn.contextNotice } : event });
      if (event.type === "done" || event.partial !== undefined) push("threads.changed", { threadId });
      if (event.type === "done") pushSpeeds();
    };
    /** `work`, or HALTED as soon as halt() runs; the dropped work finishes in the background. */
    const untilHalted = <T>(work: Promise<T>): Promise<T | typeof HALTED> => {
      work.catch(() => undefined);
      return Promise.race([work, turn.onHalt]);
    };
    try {
      const wantsTools = options.tools ?? deps.toolsEnabled?.() ?? false;
      const sources = wantsTools ? deps.sources?.entries() ?? [] : [];
      // The image tool is offered only while Tools › Make images is on, with this thread's preset and
      // size, else the app's last pick.
      const toolChoice = wantsTools && deps.image !== undefined ? deps.imageTool?.() : undefined;
      const imageChoice = toolChoice === undefined ? undefined : store.imageChoiceOf(threadId) ?? toolChoice;
      const image = imageChoice !== undefined;
      const useTools = (wantsTools && sources.length > 0) || image;
      // Ollama refuses think: true for a model that cannot think, so its turns go without the flag.
      const think = await untilHalted(thinkFlag(baseUrl, model, options.think ?? deps.think, controller.signal));
      if (think === HALTED || turn.halted) {
        finish(haltedEnd(turn.halted!));
        return;
      }
      // Include the installed prompt explicitly so context accounting sees it, including on tool turns.
      // A failed show must not send a prompt whose size we could not account for.
      let systemPrompt = options.settings?.systemPrompt;
      if (systemPrompt === undefined && deps.settings !== undefined) {
        const show = await untilHalted(fetchShow(baseUrl, model, controller.signal));
        if (show === HALTED || turn.halted) { finish(haltedEnd(turn.halted!)); return; }
        systemPrompt = show.system ?? "";
      }
      const input = {
        baseUrl,
        model,
        messages: systemPrompt === undefined ? messages : [{ role: "system" as const, content: systemPrompt }, ...messages.filter(m => m.role !== "system")],
        settings: options.settings,
        numCtx,
        signal: controller.signal,
        threadId,
        onImageOmitted: imageOmitted,
        ...(think === undefined ? {} : { think }),
        // Each request once; the reply counts on its first reported request.
        ...(deps.usage ? { onUsage: (figures: UsageFigures) => {
          if (figures.promptTokens === undefined && figures.completionTokens === undefined) return;
          deps.usage!.record(model, figures, !counted);
          counted = true;
        } } : {}),
      };
      if (turn.contextNotice) imageOmitted();
      const events = useTools ? streamToolTurn({ ...input, sources, image, ...(imageChoice ? { queueImage: queueImageFor(threadId, controller.signal, imageChoice) } : {}) }) : streamTurn(input);
      const iterator = events[Symbol.asyncIterator]();
      let dropped = false;
      try {
        for (;;) {
          const step = await untilHalted(iterator.next());
          if (step === HALTED || turn.halted) {
            dropped = step === HALTED;
            finish(haltedEnd(turn.halted!));
            return;
          }
          if (step.done === true) {
            finish({ type: "error", code: "internal", message: "the reply ended without finishing" });
            return;
          }
          const event = step.value;
          // A Stop that lands with the done line keeps the finished reply: the done event wins.
          if (event.type === "done" || event.type === "error") {
            finish(event);
            return;
          }
          emit(event);
        }
      } finally {
        // The generator's own cleanup (its finally: the socket, a queued image's take-back) runs on
        // every exit. A step a halt dropped is still pending, so that cleanup runs when it settles.
        const cleanup = iterator.return(undefined).catch(() => undefined);
        if (!dropped) await cleanup;
      }
    } catch (e) {
      if (turn.halted) finish(haltedEnd(turn.halted));
      // chat.cancel aborted a wait before the chat request (the system prompt's /api/show): the person's cancel, not a failure
      else if (controller.signal.aborted) finish({ type: "error", code: "cancelled", message: "cancelled before the reply started" });
      else {
        log(`turn ${turnId} failed: ${(e as Error).message}`);
        finish({ type: "error", code: "internal", message: (e as Error).message });
      }
    } finally {
      load?.end();
      end();
    }
  };

  /** The idle ComfyUI this app started (its MainPID): the one GPU tenant besides chat models a load may reclaim. */
  const reclaimableComfy = () => (deps.image?.current().owner === "app" ? deps.image.reclaimable() : undefined);

  /**
   * A load of `model` at `numCtx` as the fit plans it (fit/planLoad) beside the admitted turns on
   * other models (a halted one too, until it ends), the turns it would push out of the GPU, and
   * whether it needs the ComfyUI `comfyPid` names stopped too. Reads only. Inside the load gate no
   * turn is admitted meanwhile, so the plan is current.
   */
  const planBeside = async (
    baseUrl: string,
    model: string,
    numCtx: number,
    options: { signal?: AbortSignal; comfyPid?: number | undefined } = {},
  ): Promise<{ report: FitReport; stop: Turn[]; comfy: boolean }> => {
    const running = [...turns.values()].filter((t) => t.started && !sameModel(t.model, model));
    const plan = await planLoad({
      ...deps.fit,
      baseUrl,
      model,
      numCtx,
      busy: running.map((t) => t.model),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.comfyPid === undefined ? {} : { comfyPid: options.comfyPid }),
    });
    return { report: plan.report, stop: running.filter((t) => plan.stop.some((n) => sameModel(n, t.model))), comfy: plan.comfy };
  };

  /** Turns as the client names them in its warning. */
  const blockingTurns = (stop: readonly Turn[]): BlockingTurn[] => {
    const titles = new Map(store.listThreads().map((t) => [t.id, t.title]));
    return stop.map((t) => ({ threadId: t.threadId, title: titles.get(t.threadId) ?? "", model: t.model, turnId: t.turnId }));
  };

  const cancelThreadTurn = async (threadId: string, dropReply: boolean) => {
    const turn = byThread.get(threadId);
    if (turn === undefined) return;
    turn.dropReply ||= dropReply;
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

  /**
   * Image mode (chat.send draw): the words go to the image module as its prompt and no chat model
   * runs, so there is no fit, no load and no chat claim; the job claims the GPU alone. The turn
   * lasts as long as the job: a second send in the thread waits, Stop (or deleting the thread or
   * the question, or shutdown) cancels the job, and the card ends the turn as its reply. A job
   * that fails says why on its card, the way a tool-made picture does.
   */
  const drawTurn = async (threadId: string, content: string, choice: ImageChoice, messageId: string | undefined, replaced: readonly string[], attached: boolean) => {
    const image = deps.image;
    if (attached) throw new AppError("image-input", "Image mode makes a picture from words alone. Remove the attachments, or turn Image off to ask a chat model about them.");
    if (image === undefined) throw new AppError("image-input", "Image generation is not available in this build.");
    const { turn, end } = reserve(threadId, choice.preset);
    turn.drawing = true;
    let jobId: string;
    let userMessage: Message;
    try {
      userMessage = store.appendMessage({ ...(messageId === undefined ? {} : { id: messageId }), threadId, role: "user", content }, replaced);
      try {
        ({ jobId } = await queueImage(image, { prompt: content, threadId, choice }));
      } catch (e) {
        // Nothing was made: the question goes too, so the words return to the composer as unsent.
        store.deleteMessage(threadId, userMessage.id);
        push("threads.changed", { threadId });
        throw e;
      }
    } catch (e) {
      end();
      throw e;
    }
    push("threads.changed", { threadId });
    turn.start = { type: "start", model: choice.preset, userMessage, image: true };
    push("chat.event", { turnId: turn.turnId, threadId, event: turn.start });
    const stop = () => image.cancel(jobId);
    if (turn.controller.signal.aborted) stop();
    else turn.controller.signal.addEventListener("abort", stop, { once: true });
    void image.wait(jobId).catch(() => undefined).then(() => {
      turn.terminal = true;
      turn.controller.signal.removeEventListener("abort", stop);
      const card = store.getMessage(jobId);
      // Deleting the question takes its picture with it, as it takes a chat reply.
      if (turn.dropReply && card !== undefined) {
        try { store.deleteMessage(threadId, jobId); } catch (e) { log(`turn ${turn.turnId}: image card not removed: ${(e as Error).message}`); }
      }
      const event: WireEvent = card === undefined || turn.dropReply
        ? { type: "error", code: "cancelled", message: "cancelled: its question was deleted" }
        : { type: "done", message: card, stopReason: "stop" };
      push("chat.event", { turnId: turn.turnId, threadId, event });
      push("threads.changed", { threadId });
    }).finally(end);
    return { turnId: turn.turnId, userMessage };
  };

  const handlers = {
    ...deps.models?.handlers,
    ...(deps.image ? createImageHandlers({ image: deps.image }) : {}),
    // Kept per thread like the tool's jobs, so threads.delete takes them back too.
    ...(deps.image ? { "image.generate": (params: Params<"image.generate">) => queueImage(deps.image!, params) } : {}),
    ...(deps.sources ? createSourcesHandlers({ sources: deps.sources }) : {}),
    ...deps.libraryImports?.handlers,
    ...(deps.update ? createUpdateHandlers(deps.update) : {}),
    "threads.list": () => store.listThreads(),
    "threads.create": ({ title }) => {
      const thread = store.createThread(title === undefined ? {} : { title });
      push("threads.changed", { threadId: thread.id });
      return thread;
    },
    "threads.get": ({ threadId }) => {
      const saved = store.getThread(threadId);
      const draft = byThread.get(threadId)?.draftId;
      return draft === undefined ? saved : { ...saved, messages: saved.messages.filter((m) => m.id !== draft) };
    },
    "threads.rename": ({ threadId, title }) => {
      const thread = store.renameThread(threadId, title);
      push("threads.changed", { threadId });
      return thread;
    },
    "threads.setImageChoice": ({ threadId, choice }) => {
      const thread = store.setImageChoice(threadId, choice);
      push("threads.changed", { threadId });
      return thread;
    },
    "threads.delete": async ({ threadId }) => {
      // Before the first await: no new turn or image job for this thread from here on.
      const marked = !deleting.has(threadId);
      deleting.add(threadId);
      try {
        await cancelThreadTurn(threadId, true);
        // After the turn: its cancel takes back what it queued, and a finished turn's jobs are still here.
        await cancelThreadImages(threadId);
        await imageReady;
        const files = store.getThread(threadId).messages.flatMap(message => message.images ?? []);
        store.deleteThread(threadId);
        await imageFiles?.collect(files).catch((error: unknown) => log(`image cleanup after thread deletion failed: ${String(error)}`));
      } finally {
        if (marked) deleting.delete(threadId);
      }
      push("threads.changed", { threadId });
      pushSpeeds();
      return { threadId };
    },
    "messages.delete": async ({ threadId, messageId }) => {
      const marked = !deleting.has(threadId);
      deleting.add(threadId);
      try {
        // Deleting any other message stops the reply and keeps its words.
        await cancelThreadTurn(threadId, byThread.get(threadId)?.start?.userMessage.id === messageId);
        await imageReady;
        const files = store.getThread(threadId).messages.find(message => message.id === messageId)?.images ?? [];
        store.deleteMessage(threadId, messageId);
        await imageFiles?.collect(files).catch((error: unknown) => log(`image cleanup after message deletion failed: ${String(error)}`));
      } finally { if (marked) deleting.delete(threadId); }
      push("threads.changed", { threadId });
      pushSpeeds();
      return { messageId };
    },

    "models.list": async () => catalog.current() ?? (await catalog.refresh()).models,
    "models.speed": () => store.modelSpeeds(),
    "models.refresh": async () => (await catalog.refresh()).models,

    "runtime.status": () => runtime.status(),
    "runtime.retry": () => runtime.ensure(),
    "runtime.discover": () => runtime.lookIfDown(),

    // chat.send's plan for every model and context without stopping any turn, from one reading.
    "fit.table": () => fitTable.get(),

    "turns.active": () => [...turns.values()]
      .filter((turn) => (turn.started || turn.drawing) && !turn.terminal && !turn.controller.signal.aborted)
      .map(({ turnId, threadId }) => ({ turnId, threadId })),
    "turns.blocking": async ({ model, numCtx }) => {
      if (![...turns.values()].some((t) => t.started)) return [];
      const baseUrl = runtime.baseUrl();
      if (baseUrl === undefined) throw notReady();
      return blockingTurns((await planBeside(baseUrl, model, numCtx, { comfyPid: reclaimableComfy() })).stop);
    },

    // `image` is an older client's Image button: accepted and ignored (Tools › Make images decides now).
    "chat.send": async ({ threadId, content, model, numCtx, messageId, retryOf, images = [], tools, think, draw, stopOthers, stopTurns, askFirst }) => {
      if (closing) throw new AppError("shutting-down", "the server is stopping; no new turns");
      deps.admit?.();
      // The thread is going: its delete has already listed what it takes back.
      if (deleting.has(threadId)) throw threadGoing(threadId);
      // Keep unfinished text for the person, but never present it to a model as a completed answer.
      const stored = store.getThread(threadId).messages;
      const replaced = retryOf === undefined ? [] : retriedRows(stored, retryOf);
      const prior = stored.filter(m => !replaced.includes(m.id) && (m.role !== "assistant" || m.interrupted !== true));
      const saved = messageId === undefined ? undefined : store.getMessage(messageId);
      if (saved) {
        if (saved.threadId !== threadId || saved.role !== "user" || saved.content !== content) throw new AppError("image-input", "This send identity belongs to a different message. Your words were not sent; edit them and try again.");
        return { turnId: `saved-${saved.id}`, userMessage: saved, replayed: true };
      }
      const active = byThread.get(threadId);
      if (active !== undefined) throw new AppError("turn-active", `thread ${threadId} already has turn ${active.turnId} streaming; cancel it or wait`);
      if (draw !== undefined) return drawTurn(threadId, content, draw, messageId, replaced, images.length > 0);
      try { checkAttachments(images); }
      catch (e) { throw new AppError("image-input", e instanceof Error ? e.message : "Could not attach these images."); }
      const settings = turnSettings(deps.settings?.get(), model);
      const { turn, end: endTurn } = reserve(threadId, model);
      let releaseGpu: (() => void) | undefined;
      // Every way a turn ends goes through end(): the GPU claim goes with it.
      const end = () => {
        releaseGpu?.();
        endTurn();
      };
      let load: TurnReservation | undefined;
      let started = false;
      let admissionImages: string[] = [];
      try {
        // Before the first await, so models.remove sees this turn at once (throws while a removal runs).
        load = deps.models?.loader?.reserve(model);
        await imageReady;
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
        const stoppedEarly = () => turn.halted ?? cancelledBeforeStart();
        // The runtime the reservation captured: fit, admit and chat all talk to it.
        const baseUrl = load ? load.baseUrl : runtime.baseUrl();
        if (baseUrl === undefined) throw notReady();
        const show = images.length || prior.some(m => m.images?.length) ? await fetchShow(baseUrl, model, turn.controller.signal) : undefined;
        const vision = show?.capabilities?.includes("vision") === true;
        if (images.length && !vision) throw new AppError("image-input", `${model} cannot see images. Pick a model that reads images, or remove the attachments.`);
        if (images.length && deps.dataDir === undefined) throw new AppError("image-input", "Image storage is not available.");
        // Every plan reads with a signal (fit/planLoad ends each read on it); a plan error that lands
        // after the turn's cancel is the cancel.
        const turnSignal = turn.controller.signal;
        const refusal = (report: FitReport) =>
          new AppError("wont-fit", report.message ?? `${model} at num_ctx ${numCtx} does not fit (fit check refused).`, report);
        // The plan beside the admitted turns. stopOthers ends the ones whose model holds memory this
        // load needs, the way a switch does (each saves what it sent and ends "preempted"), waits
        // for them and plans again until none is in the way: the plan that returns counts their
        // memory, idle by then, as reclaimable. Without it, Ollama queues this load until those
        // turns end on their own. `comfyPid` lets the plan count the idle ComfyUI this app started;
        // this never stops it. admit passes its own signal (the turn's and the runtime's).
        const fit = async (signal: AbortSignal, comfyPid?: number): Promise<{ report: FitReport; stop: Turn[]; comfy: boolean }> => {
          for (;;) {
            const plan = await planBeside(baseUrl, model, numCtx, { signal, comfyPid });
            // Asked about every turn the plan needs, not only the new ones, so the next yes covers them all.
            const unagreed = stopOthers === true ? plan.stop.filter((t) => stopTurns !== undefined && !stopTurns.includes(t.turnId)) : askFirst === true ? plan.stop : [];
            if (unagreed.length > 0) {
              throw new AppError("would-stop", `${model} at num_ctx ${numCtx} needs the GPU memory of a running reply.`, undefined, undefined, blockingTurns(plan.stop));
            }
            const victims = stopOthers === true ? plan.stop : [];
            if (victims.length === 0) return plan;
            for (const t of victims) t.halt(preemptedBy(model, plan.report.numCtx, t.model));
            await untilAborted(Promise.all(victims.map((t) => t.ended)), signal);
          }
        };
        const planned = async (comfyPid?: number) => {
          try {
            return await fit(turnSignal, comfyPid);
          } catch (e) {
            if (turnSignal.aborted) throw stoppedEarly();
            throw e;
          }
        };
        // Before the load gate: a cold turn holds the gate until its first token or its end, so the
        // turns this load needs stopped (that one included) are stopped here, the ComfyUI stop it
        // also needs counted. No plan fits, even with every turn and ComfyUI gone: refuse now, never
        // wait on a claim. The plan inside the gate decides again.
        if (stopOthers === true) {
          const ahead = await planned(reclaimableComfy());
          if (ahead.report.verdict === "refuse" && !ahead.comfy) throw refusal(ahead.report);
        } else if (askFirst === true && [...turns.values()].some((t) => t.started)) {
          // Before the claim and the gate, where this send would otherwise wait behind that reply; fit refuses it.
          const ahead = await planned(reclaimableComfy());
          if (ahead.report.verdict === "refuse" && !ahead.comfy) throw refusal(ahead.report);
        }
        // Waits while an image job holds the GPU; admit's load gate runs inside this claim.
        const claim = async () => {
          try {
            releaseGpu = await deps.lease?.acquire("chat", turnSignal);
          } catch {
            throw stoppedEarly();
          }
        };
        await claim();
        // An idle ComfyUI this app started is the one GPU tenant besides chat models a turn may free.
        // The check runs inside the claim, so a ComfyUI an image job started while this turn waited
        // counts. With ComfyUI idle the plan decides (its nvidia-smi memory, or a try when unlisted);
        // with a job still registered (one queued behind this turn) the turn tries when it does not
        // fit. stopIdle claims the GPU alone: the turn lets its claim go first (a nested claim would
        // wait on itself), then claims again and plans again. stopIdle declines while a job is
        // registered: at most three tries, then admission decides as usual. A cancel, switch or
        // shutdown ends a try at once, unless the ComfyUI stop has begun: the turn then ends with
        // the stop, so a switch's drain waits for it (or fails the switch).
        for (let attempt = 0; attempt < 3 && deps.image?.current().owner === "app"; attempt += 1) {
          const idlePid = reclaimableComfy();
          const inside = await planned(idlePid);
          if (!inside.comfy && (idlePid !== undefined || inside.report.verdict === "fits")) break;
          // Turns this turn may not stop are in the way too: stopIdle would wait on their claims.
          if (inside.stop.length > 0) break;
          releaseGpu?.();
          releaseGpu = undefined;
          try {
            await deps.image.stopIdle(turnSignal);
          } catch (e) {
            if (turnSignal.aborted) throw stoppedEarly();
            throw e;
          }
          await claim();
        }
        // Inside the gate: a passing fit admits the turn, so the next load plans around it.
        const admitted = async (signal: AbortSignal) => {
          const r = (await fit(signal)).report;
          if (r.verdict !== "refuse") turn.started = true;
          return r;
        };
        let report: FitReport;
        try {
          report = load ? await load.admit(numCtx, { fit: admitted, signal: turnSignal }) : await admitted(turnSignal);
        } catch (e) {
          // Without a loader too: a plan error that lands after a cancel is the cancel.
          if (e instanceof AdmitCancelled || turn.halted || turnSignal.aborted) throw stoppedEarly();
          throw e;
        }
        if (report.verdict === "refuse") throw refusal(report);
        if (turnSignal.aborted) throw stoppedEarly();
        let omitted = false;
        const history = [...prior.map((m): TurnMessage => {
          const priorContent = m.imageJob ? `Image job ${m.imageJob.state}${m.imageJob.message ? `: ${m.imageJob.message}` : ""}` : m.content;
          if (!m.images?.length) return { role: m.role, content: priorContent };
          if (vision && m.role === "user") return { role: m.role, content: priorContent, images: m.images };
          omitted = true;
          return { role: m.role, content: `${priorContent}\n${OMITTED_IMAGE}`, imageTokens: m.images.map(() => 0) };
        }), { role: "user" as const, content, ...(images.length ? { images } : {}) }].map(imagePrompt);
        // Preserve text-only streaming errors; images must fit before their bytes are saved.
        const imageContext = images.length > 0 || prior.some(m => m.images?.length);
        const firstWindow = imageContext ? fitToWindow(history, report.numCtx) : { ok: true as const, messages: history };
        if (!firstWindow.ok) throw new AppError("image-input", firstWindow.message);
        const imageError = (error: unknown): never => { throw new AppError("image-input", error instanceof Error ? error.message : "An attached image is no longer available. Paste it again; your words are kept."); };
        const accounted = vision && deps.dataDir ? await accountImages(deps.dataDir, firstWindow.messages, show?.model_info).catch(imageError) : { messages: firstWindow.messages, omitted: false };
        const windowed = imageContext ? fitToWindow(accounted.messages, report.numCtx) : { ok: true as const, messages: accounted.messages };
        if (!windowed.ok) throw new AppError("image-input", windowed.message);
        const contextNotice = omitted || accounted.omitted || ("omittedImages" in firstWindow && firstWindow.omittedImages) || ("omittedImages" in windowed && windowed.omittedImages) ? IMAGE_CONTEXT_NOTICE : undefined;
        const savedImages = images.length && deps.dataDir ? await saveAttachments(deps.dataDir, images) : [];
        admissionImages = savedImages.filter(attachment => !images.includes(attachment));
        if (savedImages.length) windowed.messages[windowed.messages.length - 1] = { ...windowed.messages.at(-1)!, images: savedImages };
        const modelHistory = vision && deps.dataDir ? await visionHistory(deps.dataDir, windowed.messages).catch(imageError) : windowed.messages;
        if (turnSignal.aborted) throw stoppedEarly();
        const append = () => store.appendMessage({ ...(messageId === undefined ? {} : { id: messageId }), threadId, role: "user", content, ...(savedImages.length ? { images: savedImages } : {}) }, replaced);
        const userMessage = imageFiles ? await imageFiles.save(savedImages, append).catch(imageError) : append();
        push("threads.changed", { threadId });
        started = true;
        turn.started = true;
        // Before the answer, so every client (also one that did not send this) knows the turn first.
        turn.start = { type: "start", model, userMessage };
        push("chat.event", { turnId: turn.turnId, threadId, event: turn.start });
        fitTable.changed();
        void runTurn(turn, end, baseUrl, model, report.numCtx, modelHistory, load, { tools, think, contextNotice, settings });
        return { turnId: turn.turnId, userMessage };
      } finally {
        try {
          if (!started) await imageFiles?.collect(admissionImages);
        } finally { if (!started) { load?.end(); end(); } }
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
    fitTable,
    activeTurns: () => turns.size,
    replayTurns(target) {
      for (const turn of turns.values()) {
        if (turn.start === undefined || turn.terminal) continue;
        const send = (event: WireEvent) => target("chat.event", { turnId: turn.turnId, threadId: turn.threadId, event });
        send({ ...turn.start, replayed: true });
        if (turn.thinking !== "") send({ type: "thinking", text: turn.thinking });
        for (const step of turn.steps.values()) send({ type: "tool", step });
        if (turn.text !== "" || turn.contextNotice) send({ type: "delta", text: turn.text, ...(turn.contextNotice ? { contextNotice: turn.contextNotice } : {}) });
      }
    },
    async shutdown() {
      closing = true;
      offRuntime();
      offCatalog();
      offSources?.();
      offImports?.();
      deps.libraryImports?.close();
      const pending = [...turns.values()];
      for (const t of pending) t.halt(new AppError("cancelled", "Gates Local is closing. The reply written so far was saved."));
      await Promise.all(pending.map((t) => t.ended));
    },
  };
}
