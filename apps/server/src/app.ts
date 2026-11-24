import { randomUUID } from "node:crypto";
import path from "node:path";
import { suggestedList, type Payload } from "@gates-local/contracts";
import { fileLifecycle } from "./chat/files.ts";
import { imageLifecycle } from "./chat/image-lifecycle.ts";
import { createReplies, type Replies } from "./chat/replies.ts";
import type { Rules } from "./chat/reply.ts";
import { turnClock } from "./chat/times.ts";
import { sameModel } from "./fit/ollama.ts";
import { createFitTable } from "./fit/table.ts";
import { createMeasure } from "./measure/handlers.ts";
import { readThumbnail } from "./pictures/thumbs.ts";
import { catalogModels } from "./runtime/catalog.ts";
import { onChatList } from "./runtime/chat-list.ts";
import { createAdmission, type Admission } from "./app/admit.ts";
import { createDrawTurn, createThreadImages } from "./app/drawing.ts";
import { AppError, cancelledBeforeStart, refusalOf } from "./app/errors.ts";
import { createHandlers } from "./app/handlers.ts";
import type { Push } from "./app/push.ts";
import { createQueuePump } from "./app/queue-pump.ts";
import { createTurnRunner } from "./app/run-turn.ts";
import { HALTED, type AppContext, type Taken, type Turn, type TurnSaid } from "./app/turn.ts";
import type { App, AppDeps } from "./app/types.ts";

export { AppError, RUNTIME_CHANGED_TURN_MESSAGE, type AppErrorCode } from "./app/errors.ts";
export type { Push } from "./app/push.ts";
export type { App, AppDeps, AppHandlers } from "./app/types.ts";

export function createApp(deps: AppDeps, rules?: Rules): App {
  const { store, runtime, catalog } = deps;
  const log = deps.log ?? ((line: string) => console.error(`[app] ${line}`));
  const newId = deps.newId ?? randomUUID;
  const imageFiles = deps.dataDir ? imageLifecycle(deps.dataDir, store) : undefined;
  // why: a failed sweep only leaves old pasted files behind
  const imageReady = (imageFiles?.sweep() ?? Promise.resolve()).catch((error: unknown) => log(`image sweep at start-up failed: ${String(error)}`));
  // why: the first sweep waits so open windows can say what their drafts keep (files.keep)
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
  const said = (told: TurnSaid) => {
    try {
      deps.turnSaid?.(told);
    } catch (e) {
      log(`turn ${told.turnId}: its event was not taken: ${(e as Error).message}`);
    }
  };

  const deleting = new Set<string>();

  // why: one table moves every record, so the wiring never sets a stage itself
  const replies: Replies = createReplies({
    file: deps.dataDir === undefined ? undefined : path.join(deps.dataDir, "queue.json"),
    log,
    told: (change) => push("reply.changed", change),
    saved: (messageId) => store.getMessage(messageId),
    deleting: (threadId) => deleting.has(threadId),
    closing: () => closing,
    cut(turnId, at) {
      const turn = turns.get(turnId);
      if (turn === undefined || turn.controller.signal.aborted) return;
      turn.clock.stop(at, turn.thinking);
      pushReply(turn);
      turn.controller.abort();
    },
    clock: (turnId, now) => turns.get(turnId)?.clock.record(now),
    ...(rules === undefined ? {} : { rules }),
  });
  const queue = createQueuePump({
    replies, turns, byThread, closing: () => closing, catalog, runtime, store, settings: deps.settings, newId,
    // why: the handlers are built last
    begin: (params, taken) => begin(params, taken),
  });
  const { pump } = queue;

  const pushReply = (turn: Turn) => {
    said({ turnId: turn.turnId, threadId: turn.threadId, event: { type: "reply", reply: turn.clock.record(Date.now()) } });
    replies.clocked(turn.turnId);
  };

  const loadingModels = new Set<string>();
  const answeredTurns = new WeakSet<Turn>();
  const waitsOnLoad = (turn: Turn) => {
    if (!answeredTurns.has(turn) || ![...loadingModels].some((m) => sameModel(m, turn.model))) return;
    if (replies.loading(turn.turnId) && turn.clock.loading()) pushReply(turn);
  };
  const answered = (turn: Turn) => {
    answeredTurns.add(turn);
    waitsOnLoad(turn);
  };
  const modelLoad = (l: Payload<"models.load">) => {
    if (l.state === "loading") loadingModels.add(l.model);
    else loadingModels.delete(l.model);
    if (l.state === "loading") for (const turn of turns.values()) waitsOnLoad(turn);
  };

  const refreshModels = () => {
    catalog.refresh().catch((e: unknown) => log(`model refresh failed: ${(e as Error).message}`));
  };
  const fitTable = createFitTable({
    baseUrl: () => runtime.baseUrl(),
    ...(deps.fit ? { fit: deps.fit } : {}),
    models: async () => catalogModels(catalog.current() ?? (await catalog.refresh()).models),
    busy: () => [...turns.values()].filter((t) => t.inMemory).map((t) => t.model),
    comfyPid: () => (deps.image?.current().owner === "app" ? deps.image.reclaimable() : undefined),
    push: (table) => push("fit.changed", table),
    log,
  });
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
    pump();
    fitTable.changed();
  });
  const offChatList = onChatList((list) => {
    push("models.suggested", suggestedList(list));
    fitTable.changed();
  });
  const pushSpeeds = () => {
    try {
      push("models.speed", store.modelSpeeds());
    } catch (e) {
      log(`model speeds not read: ${(e as Error).message}`);
    }
  };
  const { sources: library, libraryImports } = deps;
  const offSources = library?.onChange(sources => push("sources.changed", sources, [library.stamp(sources)]));
  const offImports = libraryImports?.onChange(value => push("sources.imports", value, [libraryImports.stamp(value)]));

  const reserve = (threadId: string, model: string, taken: Taken): { turn: Turn; end: () => void } => {
    let end!: () => void;
    const ended = new Promise<void>((resolve) => (end = resolve));
    let wake!: (h: typeof HALTED) => void;
    const onHalt = new Promise<typeof HALTED>((resolve) => (wake = resolve));
    const turn: Turn = {
      turnId: taken.turnId,
      attempt: taken.attempt,
      threadId,
      model,
      controller: new AbortController(),
      ended,
      halted: undefined,
      onHalt,
      halt(reason) {
        if (turn.halted !== undefined) return;
        turn.halted = reason;
        turn.controller.abort(reason);
        wake(HALTED);
      },
      inMemory: false,
      draftId: undefined,
      dropReply: false,
      clock: turnClock(Date.now()),
      text: "",
      thinking: "",
      steps: new Map(),
    };
    turns.set(turn.turnId, turn);
    byThread.set(threadId, turn);
    turn.controller.signal.addEventListener("abort", () => {
      if (replies.of(turn.turnId)?.stage === "starting") replies.refused(turn.turnId, turn.attempt, refusalOf(turn.halted ?? cancelledBeforeStart()));
    }, { once: true });
    return {
      turn,
      end: () => {
        turns.delete(turn.turnId);
        if (byThread.get(threadId) === turn) byThread.delete(threadId);
        replies.left(turn.turnId);
        end();
        if (turn.inMemory) fitTable.changed();
        pump();
      },
    };
  };

  const context: AppContext = {
    deps, store, runtime, catalog, log, push, said, turns, byThread, closing: () => closing, deleting,
    imageFiles, imageReady, attachedFiles, draftEveryMs, replies, fitTable, pushReply, answered, pushSpeeds, reserve, pump,
  };
  const threadImages = createThreadImages(context);
  const runTurn = createTurnRunner({ ...context, queueImageFor: threadImages.queueImageFor });
  const admission: Admission = createAdmission({ ...context, runTurn });
  const drawTurn = createDrawTurn({ ...context, queueImage: threadImages.queueImage, admitting: admission.admitting, refused: admission.refused });
  const { handlers, begin } = createHandlers({ ...context, measure, threadImages, drawTurn, admission, queue, newId });

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
    windowGone(window) {
      replies.windowGone(window);
      pump();
    },
    started(id) {
      for (const t of turns.values()) if (t.admission !== undefined && replies.of(t.turnId)?.id === id) return { turnId: t.turnId, admission: t.admission, ended: t.ended };
      return undefined;
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
