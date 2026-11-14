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
import { checkFiles, fileLifecycle, fileLine, fileSources, saveFile } from "./chat/files.ts";
import type { LibraryEntry } from "../../../packages/harness/src/index.ts";
import { readThumbnail } from "./pictures/thumbs.ts";
import { fitToWindow, OMITTED_IMAGE } from "./chat/window.ts";
import { suggestedList, type AttachedFile, type BlockingTurn, type Channel, type FitOffer, type ImageChoice, type Message, type Params, type Payload, type ShellStatus, type SyncChange, type ToolStep, type TurnEnded } from "@gates-local/contracts";
import { streamTurn, type UsageFigures } from "./chat/stream.ts";
import { streamToolTurn } from "./chat/tools.ts";
import { turnClock, type TurnClock } from "./chat/times.ts";
import type { Sources } from "./sources/index.ts";
import { createSourcesHandlers } from "./sources/handlers.ts";
import type { LibraryImports } from "./sources/imports.ts";
import type { ChatEvent, TurnMessage } from "./chat/types.ts";
import { offerAfterRefusal } from "./fit/alternatives.ts";
import { planLoad, type FitDeps } from "./fit/fit.ts";
import { untilAborted } from "./fit/gpu.ts";
import { fetchShow, sameModel } from "./fit/ollama.ts";
import { createFitTable, type FitTableSource } from "./fit/table.ts";
import type { FitReport } from "./fit/types.ts";
import { catalogModels } from "./runtime/catalog.ts";
import { onChatList } from "./runtime/chat-list.ts";
import { AdmitCancelled, ModelActionError, type AdmitContext, type ModelLoader, type TurnLoad, type TurnReservation } from "./runtime/load.ts";
import type { ModelCatalog } from "./runtime/models.ts";
import type { RuntimeSwitch } from "./runtime/switch.ts";
import type { ThreadStore } from "./threads/store.ts";
import type { NewMessage } from "./threads/types.ts";
import type { Handlers } from "./ws/server.ts";
import { createImageHandlers } from "./image/handlers.ts";
import type { ImageSetupModule } from "./image/setup.ts";
import { IMAGES_UNSET, notRunning, type ImageModule } from "./image/module.ts";
import type { GpuLease } from "./gpu/lease.ts";
import { createMeasure } from "./measure/handlers.ts";
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
  /** The refusing report, for wont-fit: on the wire as error.fit, with the reading it was decided from. */
  readonly report?: FitReport;
  /** For preempted: the model whose load needed the GPU (the terminal event's neededBy). */
  readonly neededBy?: string;
  /** For would-stop: the running turns in the way, on the wire as error.blocking. */
  readonly blocking?: readonly BlockingTurn[];
  /** For wont-fit: what does run from the same reading (WIN-MEM-02), on the wire as error.offer. */
  offer?: FitOffer;
  constructor(code: AppErrorCode, message: string, report?: FitReport, neededBy?: string, blocking?: readonly BlockingTurn[]) {
    super(message);
    this.code = code;
    if (report !== undefined) this.report = report;
    if (neededBy !== undefined) this.neededBy = neededBy;
    if (blocking !== undefined) this.blocking = blocking;
  }
}

/** An attached file the turn can't use: its words go back to the box with this reason. */
const attachError = (e: unknown): never => { throw new AppError("image-input", e instanceof Error ? e.message : "An attached file is no longer available. Attach it again; your words are kept."); };

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

/**
 * How `turn` ended with `event` (chat row 32), decided here once so no client guesses from codes:
 * a halt made way for something; a Stop, or deleting its question, stopped it; else done or failed.
 * A failure of its own that lands after a Stop is said as one.
 */
const endedOf = (turn: Turn, event: TurnEnd, now: number): TurnEnded => {
  if (event.type === "done") return { reason: "done", at: now };
  if (turn.halted !== undefined) return { reason: "preempted", at: now };
  if (event.code === "cancelled" && (turn.dropReply || turn.stoppedAt !== undefined)) return { reason: "stopped", at: turn.stoppedAt ?? now };
  return { reason: "failed", at: now };
};

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
  /** The shell sandbox's probe (cached; a failed one is asked again after a while). Unset: the shell is offered unchecked. */
  readonly shellStatus?: () => Promise<ShellStatus>;
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
  /** Set up images: the app's own ComfyUI and this card's setup, one download (image/setup.ts). */
  readonly imageSetup?: ImageSetupModule;
  /**
   * Tools › Make images: the preset and size a chat turn's image tool uses, or undefined while
   * that switch (or image generation) is off and no chat turn is offered the tool.
   */
  readonly imageTool?: () => ImageChoice | undefined;
  /**
   * The system prompt's line for a chat turn the image tool is not offered to: what turns it on
   * here, so the model never names another app. `toolsOn`: the turn runs tools.
   */
  readonly imageOff?: (toolsOn: boolean) => string | undefined;
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
  /**
   * For in-process callers (tests, the crash server): the saved question of a turn chat.send has
   * just answered, once it starts, or its refusal. Undefined once the turn has ended.
   */
  admission(turnId: string): Promise<Message> | undefined;
  /** Send only this client's current in-flight words before it starts receiving newer events. */
  replayTurns(target: Push): void;
  /** The fit table: main feeds it the GPU watcher's gpu.changed and the loader's models.load. */
  readonly fitTable: Pick<FitTableSource, "changed" | "load">;
  /** Refuse new turns, cancel the active ones and wait for them to end. Idempotent. */
  shutdown(): Promise<void>;
  /** A picture's thumbnail, made in the image files' queue when missing (pictures/thumbs.ts). */
  thumbnail(jobId: string): Promise<Buffer | undefined>;
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
  /** Its saved question once it starts; rejects with its refusal (App.admission). */
  admission?: Promise<Message>;
  terminal: boolean;
  start?: Extract<WireEvent, { type: "start" }>;
  /** The reply's row on disk while it streams. threads.get hides it: this reply reaches clients as its live turn. */
  draftId: string | undefined;
  /** Its thread or the question it answers is being deleted: the reply is dropped, not saved. */
  dropReply: boolean;
  /** When chat.cancel first came for it: a Stop's end is then, not when the stream wound down. */
  stoppedAt?: number;
  /** Its times from reserve(), saved on the reply (chat row 32). */
  readonly clock: TurnClock;
  text: string;
  thinking: string;
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
  // A failed start-up sweep only leaves old pasted files behind; it must not fail every later send and delete that waits for it.
  const imageReady = (imageFiles?.sweep() ?? Promise.resolve()).catch((error: unknown) => log(`image sweep at start-up failed: ${String(error)}`));
  // Attached files' copies: the same rules as pasted images, in their own queue.
  // Ten minutes after start-up, so open windows first say what their saved drafts keep (files.keep),
  // then hourly: a server that runs for days still drops a copy whose day ran out (chat row 35).
  const attachedFiles = deps.dataDir ? fileLifecycle(deps.dataDir, store, { firstSweepAfterMs: 10 * 60 * 1000, sweepEveryMs: 60 * 60 * 1000, log }) : undefined;
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
    comfyPid: () => (deps.image?.current().owner === "app" ? deps.image.reclaimable() : undefined),
    push: (table) => push("fit.changed", table),
    log,
  });
  // Measure (Settings › Models): only on its RPC, holding the GPU alone, at a fixed small window.
  const measure = deps.dataDir === undefined ? undefined : createMeasure({
    dataDir: deps.dataDir,
    baseUrl: () => runtime.baseUrl(),
    installed: async () => catalog.current() ?? (await catalog.refresh()).models,
    plan: async (baseUrl, model, numCtx, signal) => (await planBeside(baseUrl, model, numCtx, { signal })).report,
    push,
    ...(deps.lease ? { lease: deps.lease } : {}),
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
  // A newer chat list from the release page: the clients read the catalog again, the fit table lists its models.
  const offChatList = onChatList((list) => {
    push("models.suggested", suggestedList(list));
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
      clock: turnClock(Date.now()),
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

  const runTurn = async (turn: Turn, end: () => void, baseUrl: string, model: string, numCtx: number, messages: TurnMessage[], load?: TurnLoad, options: { tools?: boolean; think?: boolean; settings?: TurnSettings; files?: readonly LibraryEntry[] } = {}) => {
    const { turnId, threadId, controller } = turn;
    let counted = false;
    const emit = (event: Exclude<WireEvent, TurnEnd>) => {
      if (turn.terminal) return;
      // Only text means the model answered; an error, cancel or end goes through end() below.
      if (event.type === "delta" || event.type === "thinking") load?.firstToken();
      if (event.type !== "start") turn.clock.see(event, Date.now(), turn.thinking);
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
      return { threadId, role: "assistant", content: turn.text, interrupted: true, ...(turn.thinking === "" ? {} : { thinking: turn.thinking }), ...(tools.length === 0 ? {} : { tools }), model, stats: { numCtx } };
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
    /**
     * The words the person saw, saved marked interrupted, with the turn's times. A reply with no words
     * yet saves no row: its question keeps how the turn ended. Nothing is written for a thread or
     * question being deleted.
     */
    const saveUnfinished = (failure: TurnFailure, ended: TurnEnded): TurnFailure => {
      const why = { code: failure.code, message: failure.message, ...(failure.neededBy === undefined ? {} : { neededBy: failure.neededBy }) };
      const times = turn.clock.end(ended, turn.thinking, why);
      try {
        if (turn.dropReply) {
          if (turn.draftId !== undefined) store.deleteMessage(threadId, turn.draftId);
          return failure;
        }
        if (nothingYet()) {
          if (turn.start === undefined) return failure;
          store.stampTimes(threadId, turn.start.userMessage.id, times);
          return { ...failure, question: { ...turn.start.userMessage, times } };
        }
        return { ...failure, partial: store.appendMessage({ ...unfinishedRow(turn.halted !== undefined), times }, replacingDraft()) };
      } catch (e) {
        log(`turn ${turnId}: stopped reply not saved: ${(e as Error).message}`);
        return failure;
      }
    };
    /** The finished reply, saved complete. A store that refuses it keeps the words as an unfinished reply and ends the turn with that error. */
    const saveFinished = (done: StreamDone, now: number): TurnEnd => {
      try {
        return { ...done, message: store.appendMessage({ ...done.message, times: turn.clock.end({ reason: "done", at: now }, turn.thinking) }, replacingDraft()) };
      } catch (e) {
        const code = (e as { code?: unknown }).code;
        return saveUnfinished({ type: "error", code: typeof code === "string" ? code : "internal", message: `the final save failed: ${(e as Error).message}` }, { reason: "failed", at: now });
      }
    };
    /** Every way a turn ends comes here, once: it decides what is saved and sends the one terminal event. */
    const finish = (outcome: StreamDone | TurnFailure) => {
      if (turn.terminal) return;
      turn.terminal = true;
      clearTimeout(draftTimer);
      // Done wins over a Stop, never over deleting the thread or the question.
      const dropped = outcome.type === "done" && turn.dropReply ? { type: "error" as const, code: "cancelled" as const, message: "cancelled: its question was deleted" } : outcome;
      const now = Date.now();
      const saved = dropped.type === "done" ? saveFinished(dropped, now) : saveUnfinished(dropped, endedOf(turn, dropped, now));
      const event: TurnEnd = { ...saved, ended: endedOf(turn, saved, now) };
      push("chat.event", { turnId, threadId, event });
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
      // This thread's attached files join the Library for its own turns only.
      const sources = wantsTools ? [...deps.sources?.entries() ?? [], ...options.files ?? []] : [];
      // The image tool is offered only while Tools › Make images is on, with this thread's preset and
      // size, else the app's last pick.
      const toolChoice = wantsTools && deps.image !== undefined ? deps.imageTool?.() : undefined;
      const imageChoice = toolChoice === undefined ? undefined : store.imageChoiceOf(threadId) ?? toolChoice;
      const image = imageChoice !== undefined;
      const useTools = (wantsTools && sources.length > 0) || image;
      const shell = useTools && deps.shellStatus ? await untilHalted(deps.shellStatus()) : undefined;
      if (shell === HALTED || turn.halted) { finish(haltedEnd(turn.halted!)); return; }
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
      // Without the image tool the model is told what turns it on here, so it never names another app.
      const offLine = image || deps.image === undefined ? undefined : deps.imageOff?.(wantsTools);
      const system = offLine === undefined ? systemPrompt : systemPrompt ? `${systemPrompt}\n\n${offLine}` : offLine;
      const input = {
        baseUrl,
        model,
        messages: system === undefined ? messages
          : systemPrompt === undefined ? [{ role: "system" as const, content: system }, ...messages]
          : [{ role: "system" as const, content: system }, ...messages.filter(m => m.role !== "system")],
        settings: options.settings,
        numCtx,
        signal: controller.signal,
        threadId,
        ...(think === undefined ? {} : { think }),
        // Each request once; the reply counts on its first reported request.
        ...(deps.usage ? { onUsage: (figures: UsageFigures) => {
          if (figures.promptTokens === undefined && figures.completionTokens === undefined) return;
          deps.usage!.record(model, figures, !counted);
          counted = true;
        } } : {}),
      };
      const events = useTools ? streamToolTurn({ ...input, sources, image, ...(shell ? { shell } : {}), ...(imageChoice ? { queueImage: queueImageFor(threadId, controller.signal, imageChoice) } : {}) }) : streamTurn(input);
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

  /**
   * A load of `model` at `numCtx` as the fit plans it (fit/planLoad) beside the admitted turns on
   * other models (a halted one too, until it ends), and the turns it would push out of the GPU.
   * Reads only. `measured`: inside the load gate after the handoff, where no turn is admitted
   * meanwhile, the reading alone decides; before it, the models the handoff will ask to leave count
   * as free.
   */
  const planBeside = async (
    baseUrl: string,
    model: string,
    numCtx: number,
    options: { signal?: AbortSignal; measured?: boolean } = {},
  ): Promise<{ report: FitReport; stop: Turn[] }> => {
    const running = [...turns.values()].filter((t) => t.started && !sameModel(t.model, model));
    const plan = await planLoad({
      ...deps.fit,
      baseUrl,
      model,
      numCtx,
      busy: running.map((t) => t.model),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.measured === true ? { measured: true } : {}),
    });
    return { report: plan.report, stop: running.filter((t) => plan.stop.some((n) => sameModel(n, t.model))) };
  };

  /** What a wont-fit offers instead (fit/alternatives.ts), planned as planBeside plans; undefined when it cannot tell. */
  const offerFor = async (baseUrl: string, report: FitReport) => {
    const installed = catalogModels(catalog.current() ?? []).filter((m) => m.installed).map((m) => m.name);
    return offerAfterRefusal({
      ...deps.fit,
      baseUrl,
      models: installed,
      defaultNumCtx: deps.settings?.get().defaultNumCtx ?? report.numCtx,
      busy: [...turns.values()].filter((t) => t.started && !sameModel(t.model, report.model)).map((t) => t.model),
    }, report);
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
   *
   * `count` pictures (the thread's count, chat.send drawCount): one job after another, seeds one
   * apart, in one group the client shows as tiles of one card. The turn lasts until the last one
   * settles; Stop cancels those not done and keeps the finished ones.
   */
  const drawTurn = (threadId: string, content: string, choice: ImageChoice, count: { now: number; saved: number }, messageId: string | undefined, replaced: readonly string[], attached: boolean, replacedFiles: readonly string[]) => {
    const image = deps.image;
    if (attached) throw new AppError("image-input", "Image mode makes a picture from words alone. Remove the attachments, or turn Image off to ask a chat model about them.");
    if (image === undefined) throw new AppError("image-input", "Image generation is not available in this build.");
    // An Image mode turn never counts as a chat model in GPU memory: the job's own GPU claim covers it.
    const { turn, end } = reserve(threadId, choice.preset);
    admitting(turn, queueDrawing(image, turn, end, { threadId, content, choice, count, messageId, replaced }), replacedFiles);
    return { turnId: turn.turnId };
  };

  /** Kept on the turn for App.admission; its refusal has already gone out as the turn's error event. */
  /**
   * `replacedFiles`: the attached files of the rows a Retry replaces (chat row 35). Once the
   * admission settles, a copy no message holds any more goes; a refused Retry kept those rows.
   */
  const admitting = (turn: Turn, admission: Promise<Message>, replacedFiles: readonly string[] = [], carrying: readonly string[] = []) => {
    // Until the question is saved (or refused), a files.release from the emptied draft leaves these alone.
    const carried = attachedFiles?.sending(carrying);
    admission.catch(() => undefined).finally(() => {
      carried?.();
      if (replacedFiles.length) attachedFiles?.collect(replacedFiles).catch((error: unknown) => log(`attached-file cleanup after a retry failed: ${String(error)}`));
    });
    turn.admission = admission;
  };

  /** An Image mode turn chat.send answered: its question and its jobs, then its start; a refusal is its error event (chat row 32). */
  const queueDrawing = async (
    image: ImageModule,
    turn: Turn,
    end: () => void,
    { threadId, content, choice, count, messageId, replaced }: { threadId: string; content: string; choice: ImageChoice; count: { now: number; saved: number }; messageId: string | undefined; replaced: readonly string[] },
  ): Promise<Message> => {
    const jobIds: string[] = [];
    let userMessage: Message;
    try {
      // after the answer has gone out
      await new Promise((resolve) => setImmediate(resolve));
      // No ComfyUI answered last time and the app has none to start: ask once more, and refuse before
      // any card or question is kept, so the words go back to the composer with one line of why.
      const missing = image.current().state === "missing" ? await image.status() : undefined;
      if (missing?.state === "missing") throw new AppError("image-input", missing.addressSet === true && missing.baseUrl !== undefined ? notRunning(missing.baseUrl) : IMAGES_UNSET);
      if (turn.controller.signal.aborted) throw turn.halted ?? cancelledBeforeStart();
      userMessage = store.appendMessage({ ...(messageId === undefined ? {} : { id: messageId }), threadId, role: "user", content }, replaced);
      try {
        const group = count.now > 1 ? randomUUID() : undefined;
        const seed = Math.floor(Math.random() * 2 ** 32);
        for (let index = 0; index < count.now; index++) {
          const tile = group === undefined ? {} : { group: { id: group, index, of: count.now }, seed: (seed + index) % 2 ** 32 };
          jobIds.push((await queueImage(image, { prompt: content, threadId, choice, ...tile })).jobId);
        }
      } catch (e) {
        // Nothing was made: the question goes too, with any of its pictures already queued, so the words return to the composer as unsent.
        for (const id of jobIds) image.cancel(id);
        await Promise.all(jobIds.map((id) => image.wait(id).catch(() => undefined)));
        for (const id of jobIds) { try { store.deleteMessage(threadId, id); } catch { /* already gone */ } }
        store.deleteMessage(threadId, userMessage.id);
        push("threads.changed", { threadId });
        throw e;
      }
    } catch (e) {
      end();
      refused(turn, e);
      throw e;
    }
    // The thread makes this many from now on, as it keeps the choice it sent.
    if (count.now !== count.saved) {
      try { store.setImageCount(threadId, count.now); } catch (e) { log(`turn ${turn.turnId}: image count not kept: ${(e as Error).message}`); }
    }
    push("threads.changed", { threadId });
    turn.start = { type: "start", model: choice.preset, userMessage, image: true };
    push("chat.event", { turnId: turn.turnId, threadId, event: turn.start });
    const stop = () => { for (const id of jobIds) image.cancel(id); };
    if (turn.controller.signal.aborted) stop();
    else turn.controller.signal.addEventListener("abort", stop, { once: true });
    void Promise.all(jobIds.map((id) => image.wait(id).catch(() => undefined))).then(() => {
      turn.terminal = true;
      turn.controller.signal.removeEventListener("abort", stop);
      const [first] = jobIds as [string, ...string[]];
      const card = store.getMessage(first);
      // Deleting the question takes its pictures with it, as it takes a chat reply.
      if (turn.dropReply) {
        for (const id of jobIds) {
          if (store.getMessage(id) === undefined) continue;
          try { store.deleteMessage(threadId, id); } catch (e) { log(`turn ${turn.turnId}: image card not removed: ${(e as Error).message}`); }
        }
      }
      const last: TurnEnd = card === undefined || turn.dropReply
        ? { type: "error", code: "cancelled", message: "cancelled: its question was deleted" }
        : { type: "done", message: card, stopReason: "stop" };
      // the card says how each picture went; the turn ended as its last one settled
      const event: TurnEnd = { ...last, ended: last.type === "done" ? { reason: "done", at: Date.now() } : { reason: "stopped", at: turn.stoppedAt ?? Date.now() } };
      push("chat.event", { turnId: turn.turnId, threadId, event });
      push("threads.changed", { threadId });
    }).finally(end);
    return userMessage;
  };

  const handlers = {
    ...deps.models?.handlers,
    ...(deps.image ? createImageHandlers({ image: deps.image, ...deps.imageSetup ? { setup: deps.imageSetup } : {} }) : {}),
    // Kept per thread like the tool's jobs, so threads.delete takes them back too.
    ...(deps.image ? { "image.generate": (params: Params<"image.generate">) => queueImage(deps.image!, params) } : {}),
    ...(deps.sources ? createSourcesHandlers({ sources: deps.sources }) : {}),
    ...deps.libraryImports?.handlers,
    ...(deps.update ? createUpdateHandlers(deps.update) : {}),
    ...measure?.handlers,
    // Settings › Tools says Ready for Run commands only after this probe ran a command in the sandbox.
    "tools.shell": async () => deps.shellStatus ? await deps.shellStatus() : { state: "off" as const, word: "Not checked" },
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
    "threads.setImageCount": ({ threadId, count }) => {
      const thread = store.setImageCount(threadId, count);
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
        const messages = store.getThread(threadId).messages;
        const files = messages.flatMap(message => message.images ?? []);
        const attached = messages.flatMap(message => message.files ?? []).map(file => file.path);
        store.deleteThread(threadId);
        await imageFiles?.collect(files).catch((error: unknown) => log(`image cleanup after thread deletion failed: ${String(error)}`));
        await attachedFiles?.collect(attached).catch((error: unknown) => log(`attached-file cleanup after thread deletion failed: ${String(error)}`));
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
        const message = store.getThread(threadId).messages.find(m => m.id === messageId);
        const files = message?.images ?? [];
        const attached = (message?.files ?? []).map(file => file.path);
        store.deleteMessage(threadId, messageId);
        await imageFiles?.collect(files).catch((error: unknown) => log(`image cleanup after message deletion failed: ${String(error)}`));
        await attachedFiles?.collect(attached).catch((error: unknown) => log(`attached-file cleanup after message deletion failed: ${String(error)}`));
      } finally { if (marked) deleting.delete(threadId); }
      push("threads.changed", { threadId });
      pushSpeeds();
      return { messageId };
    },

    "files.attach": async (params) => {
      if (deps.dataDir === undefined) throw new AppError("image-input", "File storage is not available.");
      try { return await saveFile(deps.dataDir, params); }
      catch (e) { throw new AppError("image-input", e instanceof Error ? e.message : `${params.name} could not be attached.`); }
    },
    "files.keep": async ({ paths }) => attachedFiles ? await attachedFiles.keep(paths) : { missing: [...paths] },
    "files.release": async ({ paths }) => {
      await attachedFiles?.release(paths);
      return {};
    },

    "models.list": async () => catalog.current() ?? (await catalog.refresh()).models,
    "models.speed": () => store.modelSpeeds(),
    "models.refresh": async () => (await catalog.refresh()).models,

    "runtime.status": () => runtime.status(),
    "runtime.retry": () => runtime.ensure(),
    "runtime.discover": () => runtime.lookIfDown(),

    // chat.send's plan for every model and context without stopping any turn, from one reading.
    "fit.table": () => fitTable.get(),

    // From the moment chat.send took each turn, also while it waits for the GPU or a load.
    "turns.active": () => [...turns.values()]
      .filter((turn) => !turn.terminal && !turn.controller.signal.aborted)
      .map(({ turnId, threadId }) => ({ turnId, threadId })),
    "turns.blocking": async ({ model, numCtx }) => {
      if (![...turns.values()].some((t) => t.started)) return [];
      const baseUrl = runtime.baseUrl();
      if (baseUrl === undefined) throw notReady();
      return blockingTurns((await planBeside(baseUrl, model, numCtx)).stop);
    },

    // `image` is an older client's Image button: accepted and ignored (Tools › Make images decides now).
    "chat.send": async ({ threadId, content, model, numCtx, messageId, retryOf, images = [], files: attaching = [], tools, think, draw, drawCount, stopOthers, stopTurns, askFirst }) => {
      if (closing) throw new AppError("shutting-down", "the server is stopping; no new turns");
      deps.admit?.();
      // The thread is going: its delete has already listed what it takes back.
      if (deleting.has(threadId)) throw threadGoing(threadId);
      // Keep unfinished text for the person, but never present it to a model as a completed answer.
      const loaded = store.getThread(threadId);
      const stored = loaded.messages;
      const replaced = retryOf === undefined ? [] : retriedRows(stored, retryOf);
      const prior = stored.filter(m => !replaced.includes(m.id) && (m.role !== "assistant" || m.interrupted !== true));
      const replacedFiles = stored.filter(m => replaced.includes(m.id)).flatMap(m => (m.files ?? []).map(file => file.path));
      const saved = messageId === undefined ? undefined : store.getMessage(messageId);
      if (saved) {
        if (saved.threadId !== threadId || saved.role !== "user" || saved.content !== content) throw new AppError("image-input", "This send identity belongs to a different message. Your words were not sent; edit them and try again.");
        return { turnId: `saved-${saved.id}`, userMessage: saved, replayed: true };
      }
      const active = byThread.get(threadId);
      if (active !== undefined) throw new AppError("turn-active", `thread ${threadId} already has turn ${active.turnId} streaming; cancel it or wait`);
      if (draw !== undefined) {
        const kept = loaded.thread.imageCount ?? 1;
        return drawTurn(threadId, content, draw, { now: drawCount ?? kept, saved: kept }, messageId, replaced, images.length > 0 || attaching.length > 0, replacedFiles);
      }
      try { checkAttachments(images); }
      catch (e) { throw new AppError("image-input", e instanceof Error ? e.message : "Could not attach these images."); }
      if (attaching.length && deps.dataDir === undefined) throw new AppError("image-input", "File storage is not available.");
      const settings = turnSettings(deps.settings?.get(), model);
      const { turn, end } = reserve(threadId, model);
      let load: TurnReservation | undefined;
      try {
        // Before the answer, so models.remove sees this turn at once (throws while a removal runs).
        load = deps.models?.loader?.reserve(model);
      } catch (e) {
        end();
        throw e;
      }
      admitting(turn, admitTurn(turn, end, load, { threadId, content, model, numCtx, messageId, images, files: attaching, tools, think, stopOthers, stopTurns, askFirst }, { replaced, prior, settings }), replacedFiles, attaching.map(file => file.path));
      return { turnId: turn.turnId };
    },

    "chat.cancel": ({ turnId }) => {
      const turn = turns.get(turnId);
      if (turn === undefined || turn.controller.signal.aborted) return { cancelled: false };
      turn.stoppedAt = Date.now();
      // words already on their way when the Stop landed change no time on the row
      turn.clock.stop(turn.stoppedAt, turn.thinking);
      turn.controller.abort();
      return { cancelled: true };
    },
  } satisfies AppHandlers;

  /**
   * A turn chat.send took and answered: its fit, its load, its GPU claim and its saved question,
   * then its start and its reply. A refusal on the way is its one error event, before any start,
   * so every window hears of it (chat row 32). It begins after the answer has gone out: no event
   * of this turn reaches a client before the answer that names it.
   */
  async function admitTurn(
    turn: Turn,
    end: () => void,
    load: TurnReservation | undefined,
    { threadId, content, model, numCtx, messageId, images, files: attaching = [], tools, think, stopOthers, stopTurns, askFirst }: Params<"chat.send"> & { images: readonly string[] },
    { replaced, prior, settings }: { replaced: readonly string[]; prior: readonly Message[]; settings: ReturnType<typeof turnSettings> },
  ): Promise<Message> {
    let releaseGpu: (() => void) | undefined;
    let started: Message | undefined;
    let failure: unknown;
    let admissionImages: string[] = [];
    const ending = () => {
      releaseGpu?.();
      end();
    };
    try {
      try {
        await new Promise((resolve) => setImmediate(resolve));
        await imageReady;
        const files = deps.dataDir ? await checkFiles(deps.dataDir, attaching, { threadId, owners: store.fileOwners() }).catch(attachError) : [];
        // The thread's files, this message's included, open by label in this turn when tools are on.
        const wantsTools = tools ?? deps.toolsEnabled?.() ?? false;
        const fileEntries = wantsTools && deps.dataDir ? await fileSources(deps.dataDir, [...prior.flatMap(m => m.files ?? []), ...files], deps.sources?.entries() ?? []).catch(attachError) : new Map<string, LibraryEntry>();
        const withFiles = (text: string, attached: readonly AttachedFile[] | undefined) => attached?.length ? [text, ...attached.map(f => fileLine(f, fileEntries.get(f.path)))].filter(Boolean).join("\n") : text;
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
        const refusal = async (report: FitReport) => {
          const e = new AppError("wont-fit", report.message ?? `${model} at num_ctx ${numCtx} does not fit (fit check refused).`, report);
          const offer = await offerFor(baseUrl, report);
          if (offer !== undefined) e.offer = offer;
          return e;
        };
        // The plan beside the admitted turns. stopOthers ends the ones whose model holds memory this
        // load needs, the way a switch does (each saves what it sent and ends "preempted"), waits
        // for them and plans again until none is in the way. Inside the gate the handoff runs again
        // first (their models are no reply's any more, so they are asked to leave too) and the plan
        // measures what that left. Without it, Ollama queues this load until those turns end on
        // their own. admit passes its own signal (the turn's and the runtime's).
        const fit = async (signal: AbortSignal, context?: AdmitContext): Promise<{ report: FitReport; stop: Turn[] }> => {
          for (;;) {
            const plan = await planBeside(baseUrl, model, numCtx, { signal, measured: context?.handoff !== undefined });
            // Asked about every turn the plan needs, not only the new ones, so the next yes covers them all.
            const unagreed = stopOthers === true ? plan.stop.filter((t) => stopTurns !== undefined && !stopTurns.includes(t.turnId)) : askFirst === true ? plan.stop : [];
            if (unagreed.length > 0) {
              throw new AppError("would-stop", `${model} at num_ctx ${numCtx} needs the GPU memory of a running reply.`, undefined, undefined, blockingTurns(plan.stop));
            }
            const victims = stopOthers === true ? plan.stop : [];
            if (victims.length === 0) return plan;
            for (const t of victims) t.halt(preemptedBy(model, plan.report.numCtx, t.model));
            await untilAborted(Promise.all(victims.map((t) => t.ended)), signal);
            await context?.leave();
          }
        };
        const planned = async () => {
          try {
            return await fit(turnSignal);
          } catch (e) {
            if (turnSignal.aborted) throw stoppedEarly();
            throw e;
          }
        };
        // Before the load gate: a cold turn holds the gate until its first token or its end, so the
        // turns this load needs stopped (that one included) are stopped here. A plan that refuses
        // even with every turn stopped and every idle model gone refuses now, never waiting on a
        // claim, unless the image engine may hold memory the handoff frees (no plan counts that).
        // The plan inside the gate decides again, from its own reading.
        const engineMayHold = deps.image !== undefined && deps.image.current().state !== "off";
        if (stopOthers === true || (askFirst === true && [...turns.values()].some((t) => t.started))) {
          // askFirst: before the claim and the gate, where this send would otherwise wait behind that reply.
          const ahead = await planned();
          if (ahead.report.verdict === "refuse" && !engineMayHold) throw await refusal(ahead.report);
        }
        // Waits while an image job holds the GPU; admit's load gate runs inside this claim.
        try {
          releaseGpu = await deps.lease?.acquire("chat", turnSignal);
        } catch {
          throw stoppedEarly();
        }
        // Inside the gate, after the handoff: a passing fit admits the turn, so the next load plans around it.
        const admitted = async (signal: AbortSignal, context?: AdmitContext) => {
          const r = (await fit(signal, context)).report;
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
        if (report.verdict === "refuse") throw await refusal(report);
        if (turnSignal.aborted) throw stoppedEarly();
        const history = [...prior.map((m): TurnMessage => {
          const priorContent = m.imageJob ? `Image job ${m.imageJob.state}${m.imageJob.message ? `: ${m.imageJob.message}` : ""}` : withFiles(m.content, m.files);
          if (!m.images?.length) return { role: m.role, content: priorContent };
          if (vision && m.role === "user") return { role: m.role, content: priorContent, images: m.images };
          return { role: m.role, content: `${priorContent}\n${OMITTED_IMAGE}`, imageTokens: m.images.map(() => 0) };
        }), { role: "user" as const, content: withFiles(content, files), ...(images.length ? { images } : {}) }].map(imagePrompt);
        // Preserve text-only streaming errors; images must fit before their bytes are saved.
        const imageContext = images.length > 0 || prior.some(m => m.images?.length);
        const firstWindow = imageContext ? fitToWindow(history, report.numCtx) : { ok: true as const, messages: history };
        if (!firstWindow.ok) throw new AppError("image-input", firstWindow.message);
        const imageError = (error: unknown): never => { throw new AppError("image-input", error instanceof Error ? error.message : "An attached image is no longer available. Paste it again; your words are kept."); };
        const accounted = vision && deps.dataDir ? await accountImages(deps.dataDir, firstWindow.messages, show?.model_info).catch(imageError) : { messages: firstWindow.messages, omitted: false };
        const windowed = imageContext ? fitToWindow(accounted.messages, report.numCtx) : { ok: true as const, messages: accounted.messages };
        if (!windowed.ok) throw new AppError("image-input", windowed.message);
        const savedImages = images.length && deps.dataDir ? await saveAttachments(deps.dataDir, images) : [];
        admissionImages = savedImages.filter(attachment => !images.includes(attachment));
        if (savedImages.length) windowed.messages[windowed.messages.length - 1] = { ...windowed.messages.at(-1)!, images: savedImages };
        const modelHistory = vision && deps.dataDir ? await visionHistory(deps.dataDir, windowed.messages).catch(imageError) : windowed.messages;
        if (turnSignal.aborted) throw stoppedEarly();
        const append = () => store.appendMessage({ ...(messageId === undefined ? {} : { id: messageId }), threadId, role: "user", content, ...(savedImages.length ? { images: savedImages } : {}), ...(files.length ? { files } : {}) }, replaced);
        const withImages = () => imageFiles ? imageFiles.save(savedImages, append).catch(imageError) : append();
        // A file removed since the check above (its day ran out) is said, not saved as a dead reference.
        const userMessage = attachedFiles && files.length ? await attachedFiles.save(files, withImages, threadId).catch(attachError) : await withImages();
        push("threads.changed", { threadId });
        started = userMessage;
        turn.started = true;
        // Every client (also one that did not send this) learns of the question here.
        turn.start = { type: "start", model, userMessage };
        // a model it loads is ready at its first token; one already in memory, now
        if (load?.cold !== true) turn.clock.ready(Date.now());
        push("chat.event", { turnId: turn.turnId, threadId, event: turn.start });
        // the plan read the GPU a moment ago: the table takes that reading (chat row 33)
        fitTable.changed({ afterPlan: true });
        void runTurn(turn, ending, baseUrl, model, report.numCtx, modelHistory, load, { tools, think, settings, files: [...fileEntries.values()] });
      } catch (e) {
        failure = e;
        turn.terminal = true;
      } finally {
        try {
          if (!started) await imageFiles?.collect(admissionImages);
        } finally { if (!started) { load?.end(); ending(); } }
      }
    } catch (e) {
      log(`turn ${turn.turnId}: admission cleanup failed: ${(e as Error).message}`);
    }
    // said once the turn let go of everything it held: a client that hears it finds no claim and no file left
    if (started === undefined) {
      refused(turn, failure);
      throw failure;
    }
    return started;
  }

  /**
   * A turn that ended before its start (chat row 32): one error event says why, with the turns
   * in the way for would-stop, and how it ended (a Stop, a halt, or a refusal). Nothing of it was
   * saved, so the sender's words go back to its composer.
   */
  function refused(turn: Turn, e: unknown): void {
    const { code, message, blocking, neededBy, report, offer } = typeof e === "object" && e !== null ? (e as { code?: unknown; message?: unknown; blocking?: readonly BlockingTurn[]; neededBy?: string; report?: FitReport; offer?: FitOffer }) : {};
    const failure: TurnFailure = {
      type: "error",
      code: typeof code === "string" && code !== "" ? code : "internal",
      message: typeof message === "string" ? message : String(e),
      ...(blocking === undefined ? {} : { blocking }),
      ...(neededBy === undefined ? {} : { neededBy }),
      // wont-fit: the reading the refusal was decided from (taken after everything else was asked to leave)
      ...(code === "wont-fit" && report !== undefined ? { fit: report } : {}),
      ...(offer === undefined ? {} : { offer }),
    };
    if (failure.code === "internal") log(`turn ${turn.turnId} refused: ${failure.message}`);
    turn.terminal = true;
    push("chat.event", { turnId: turn.turnId, threadId: turn.threadId, event: { ...failure, ended: endedOf(turn, failure, Date.now()) } });
  }

  function notReady(): AppError {
    const s = runtime.status();
    return new AppError("runtime-not-ready", `Ollama is not ready (${s.state}${s.detail ? `: ${s.detail}` : ""}).`);
  }

  return {
    handlers,
    fitTable,
    thumbnail: async (jobId) => (deps.dataDir && imageFiles ? readThumbnail(deps.dataDir, jobId, imageFiles.queue) : undefined),
    activeTurns: () => turns.size,
    admission: (turnId) => turns.get(turnId)?.admission,
    replayTurns(target) {
      for (const turn of turns.values()) {
        if (turn.start === undefined || turn.terminal) continue;
        const send = (event: WireEvent) => target("chat.event", { turnId: turn.turnId, threadId: turn.threadId, event });
        send({ ...turn.start, replayed: true });
        if (turn.thinking !== "") send({ type: "thinking", text: turn.thinking });
        for (const step of turn.steps.values()) send({ type: "tool", step });
        if (turn.text !== "") send({ type: "delta", text: turn.text });
      }
    },
    async shutdown() {
      closing = true;
      attachedFiles?.stop();
      offRuntime();
      offCatalog();
      offChatList();
      offSources?.();
      offImports?.();
      deps.libraryImports?.close();
      measure?.close();
      const pending = [...turns.values()];
      for (const t of pending) t.halt(new AppError("cancelled", "Gates Local is closing. The reply written so far was saved."));
      await Promise.all(pending.map((t) => t.ended));
    },
  };
}
