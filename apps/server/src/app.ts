// The server's app: every contracts method wired onto the thread store, the Ollama runtime,
// the model catalog, the fit check and the streamed turn. main.ts only parses flags and owns
// the process; tests drive this directly.
//
// A chat turn: one active turn per thread, a ready runtime, a fit verdict
// other than refuse; then the user message persists and the reply streams on
// chat.event. A finished reply is saved complete; any other end keeps the words
// sent so far, marked interrupted (app/run-turn.ts finish).
//
// This file builds the state the app's jobs share and wires them together; each job is a
// file in app/: the request handlers (handlers.ts), taking a send in (admit.ts), running a
// reply (run-turn.ts), pictures in a chat (drawing.ts) and the queue (queue-pump.ts).
import { randomUUID } from "node:crypto";
import path from "node:path";
import { suggestedList, type Payload } from "@gates-local/contracts";
import { fileLifecycle } from "./chat/files.ts";
import { imageLifecycle } from "./chat/image-lifecycle.ts";
import { createQueue } from "./chat/queue.ts";
import { turnClock } from "./chat/times.ts";
import { sameModel } from "./fit/ollama.ts";
import { createFitTable } from "./fit/table.ts";
import { createMeasure } from "./measure/handlers.ts";
import { readThumbnail } from "./pictures/thumbs.ts";
import { catalogModels } from "./runtime/catalog.ts";
import { onChatList } from "./runtime/chat-list.ts";
import { createAdmission, type Admission } from "./app/admit.ts";
import { createDrawTurn, createThreadImages } from "./app/drawing.ts";
import { AppError } from "./app/errors.ts";
import { createHandlers } from "./app/handlers.ts";
import type { Push } from "./app/push.ts";
import { createQueuePump } from "./app/queue-pump.ts";
import { createTurnRunner } from "./app/run-turn.ts";
import { HALTED, type AppContext, type Turn, type WireEvent } from "./app/turn.ts";
import type { App, AppDeps } from "./app/types.ts";

export { AppError, RUNTIME_CHANGED_TURN_MESSAGE, type AppErrorCode } from "./app/errors.ts";
export type { Push } from "./app/push.ts";
export type { App, AppDeps, AppHandlers } from "./app/types.ts";

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
    if (channel === "chat.event") pumper.heard(payload as Payload<"chat.event">);
  };

  // The queue every window shows, kept and sent here (chat/queue.ts, app/queue-pump.ts).
  const queue = createQueue({ file: deps.dataDir === undefined ? undefined : path.join(deps.dataDir, "queue.json"), changed: (list) => push("queue.changed", list), log });
  const pumper = createQueuePump({
    queue, turns, byThread, closing: () => closing, catalog, runtime, settings: deps.settings,
    // bound late: the handlers are built last
    send: (params) => handlers["chat.send"](params),
  });
  const { pump } = pumper;

  /** The turn's reply record as it is now, to every window (decision 33). */
  const pushReply = (turn: Turn) => push("chat.event", { turnId: turn.turnId, threadId: turn.threadId, event: { type: "reply", reply: turn.clock.record(Date.now()) } });

  /** Models a models.load says are loading now (a preload the first key started, or another window's). */
  const loadingModels = new Set<string>();
  /** A turn that waits while its own model loads says "loading", not "waiting" (decision 33). */
  const waitsOnLoad = (turn: Turn) => {
    if (turn.terminal || turn.start !== undefined || turn.answered !== true) return;
    if (![...loadingModels].some((m) => sameModel(m, turn.model))) return;
    if (turn.clock.loading()) pushReply(turn);
  };
  const modelLoad = (l: Payload<"models.load">) => {
    if (l.state === "loading") loadingModels.add(l.model);
    else loadingModels.delete(l.model);
    if (l.state === "loading") for (const turn of turns.values()) waitsOnLoad(turn);
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
  // Measure (Settings › Models): only on its RPC, holding the GPU alone, at the chat's window.
  const measure = deps.dataDir === undefined ? undefined : createMeasure({
    ...(deps.settings ? { settings: deps.settings } : {}),
    ...(deps.shellStatus ? { shellStatus: deps.shellStatus } : {}),
    dataDir: deps.dataDir,
    baseUrl: () => runtime.baseUrl(),
    installed: async () => catalog.current() ?? (await catalog.refresh()).models,
    plan: async (baseUrl, model, numCtx, signal, measured) => (await admission.planBeside(baseUrl, model, numCtx, { signal, ...measured === true ? { measured } : {} })).report,
    push,
    ...(deps.lease ? { lease: deps.lease } : {}),
    ...(deps.memory ? { memory: deps.memory } : {}),
    // a runtime switch stops a running measure as it ends a chat turn, and waits for its end
    ...(deps.models?.loader ? { loader: deps.models.loader } : {}),
  });
  const offRuntime = runtime.onChange((status) => {
    push("runtime.changed", status);
    pump();
    refreshModels();
    fitTable.changed();
  });
  const offCatalog = catalog.onChange((models) => {
    push("models.changed", models);
    // the first model's download finished: what was typed behind it goes
    pump();
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
        pumper.rememberEnd(turn.turnId, threadId);
        end();
        // An admitted turn's model was busy in every row's plan; now it is not.
        if (turn.started) fitTable.changed();
        // the queue sends one reply at a time: this one's end may be what the next waits for
        pump();
      },
    };
  };

  /** Threads whose threads.delete is running: marked before its first await, cleared when it ends. */
  const deleting = new Set<string>();

  const context: AppContext = {
    deps, store, runtime, catalog, log, push, turns, byThread, closing: () => closing, deleting,
    imageFiles, imageReady, attachedFiles, draftEveryMs, queue, fitTable, pushReply, waitsOnLoad, pushSpeeds, reserve, pump,
  };
  const threadImages = createThreadImages(context);
  const runTurn = createTurnRunner({ ...context, queueImageFor: threadImages.queueImageFor });
  const admission: Admission = createAdmission({ ...context, runTurn });
  const drawTurn = createDrawTurn({ ...context, queueImage: threadImages.queueImage, admitting: admission.admitting, refused: admission.refused });
  const handlers = createHandlers({ ...context, measure, lateStop: pumper.lateStop, threadImages, drawTurn, admission });

  return {
    handlers,
    fitTable: {
      changed: (...a) => fitTable.changed(...a),
      load(l) {
        fitTable.load(l);
        modelLoad(l);
      },
    },
    thumbnail: async (jobId) => (deps.dataDir && imageFiles ? readThumbnail(deps.dataDir, jobId, imageFiles.queue) : undefined),
    activeTurns: () => turns.size,
    admission: (turnId) => turns.get(turnId)?.admission,
    replayTurns(target) {
      for (const turn of turns.values()) {
        if (turn.start === undefined || turn.terminal) continue;
        const send = (event: WireEvent) => target("chat.event", { turnId: turn.turnId, threadId: turn.threadId, event });
        send({ ...turn.start, replayed: true });
        // the record as it is now: a window that joins mid-reply draws the same stage and seconds
        send({ type: "reply", reply: turn.clock.record(Date.now()) });
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
