// The request handlers: every contracts method the app answers, on the thread store, the
// runtime, the catalog, the fit table and the queue. chat.send takes a turn here and hands it
// to admit.ts (a chat model) or drawing.ts (Image mode).
import type { Params } from "@gates-local/contracts";
import { checkAttachments } from "../chat/attachments.ts";
import { saveFile } from "../chat/files.ts";
import { withSendTimes } from "../chat/send-times.ts";
import { createImageHandlers } from "../image/handlers.ts";
import type { createMeasure } from "../measure/handlers.ts";
import { threadPages } from "../pages/list.ts";
import type { TurnReservation } from "../runtime/load.ts";
import { turnSettings } from "../settings/turn.ts";
import { createSourcesHandlers } from "../sources/handlers.ts";
import { createUpdateHandlers } from "../update/module.ts";
import type { Admission } from "./admit.ts";
import type { DrawTurn, ThreadImages } from "./drawing.ts";
import { AppError, threadGoing } from "./errors.ts";
import type { QueuePump } from "./queue-pump.ts";
import type { AppContext } from "./turn.ts";
import type { AppHandlers } from "./types.ts";

/** What a Retry of `questionId` replaces: that question and the unfinished rows after it. None once something else was asked or a finished reply followed: then it is a new question. */
function retriedRows(messages: readonly { readonly id: string; readonly role: string; readonly interrupted?: true; readonly imageJob?: { readonly state: string } }[], questionId: string): string[] {
  const rows = messages.slice(messages.findLastIndex((m) => m.role === "user"));
  // A picture that failed or was cancelled is unfinished the way a stopped reply is.
  const unfinished = (m: (typeof rows)[number]) => m.interrupted === true || m.imageJob?.state === "error" || m.imageJob?.state === "cancelled";
  return rows[0]?.id === questionId && rows.slice(1).every(unfinished) ? rows.map((m) => m.id) : [];
}

export interface HandlersDeps extends Pick<AppContext,
  "deps" | "store" | "runtime" | "catalog" | "log" | "push" | "turns" | "byThread" | "deleting" | "closing"
  | "imageReady" | "imageFiles" | "attachedFiles" | "queue" | "fitTable" | "reserve" | "pump" | "pushSpeeds" | "pushReply"> {
  readonly measure: Pick<ReturnType<typeof createMeasure>, "handlers"> | undefined;
  readonly lateStop: QueuePump["lateStop"];
  readonly threadImages: ThreadImages;
  readonly drawTurn: DrawTurn;
  readonly admission: Admission;
}

export function createHandlers({
  deps, store, runtime, catalog, log, push, turns, byThread, deleting, closing, imageReady, imageFiles, attachedFiles,
  queue, fitTable, reserve, pump, pushSpeeds, pushReply, measure, lateStop, threadImages, drawTurn, admission,
}: HandlersDeps) {
  const { queueImage, cancelThreadImages } = threadImages;
  const { admitTurn, admitting, blockingTurns, planBeside, notReady } = admission;
  /** Which connection has each row open in its composer. */
  const editors = new Map<string, number>();

  const cancelThreadTurn = async (threadId: string, dropReply: boolean) => {
    const turn = byThread.get(threadId);
    if (turn === undefined) return;
    turn.dropReply ||= dropReply;
    turn.controller.abort();
    await turn.ended;
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
    "threads.get": ({ threadId, before, limit }) => {
      const draft = byThread.get(threadId)?.draftId;
      if (limit === undefined && before === undefined) {
        const saved = store.getThread(threadId);
        return draft === undefined ? saved : { ...saved, messages: saved.messages.filter((m) => m.id !== draft) };
      }
      // a page starts at a question, so a reply never shows without the question it answers
      const page = store.getThreadPage(threadId, { ...(before === undefined ? {} : { before }), ...(limit === undefined ? {} : { limit }), ...(draft === undefined ? {} : { skip: draft }) });
      if (page === undefined) throw new AppError("message-not-found", `message ${before ?? ""} is not in thread ${threadId}`);
      return page;
    },
    "threads.pages": ({ threadId, before }) => threadPages(store, threadId, before, byThread.get(threadId)?.draftId),
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
        queue.dropThread(threadId);
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

    // the status is read after the list, so a reply never pairs a list with a runtime from before it
    "models.list": async () => {
      const models = catalog.current() ?? (await catalog.refresh()).models;
      return { runtime: runtime.status(), models };
    },
    "models.speed": () => store.modelSpeeds(),
    "models.refresh": async () => {
      const { models } = await catalog.refresh();
      return { runtime: runtime.status(), models };
    },

    "runtime.status": () => runtime.status(),
    "runtime.retry": () => runtime.ensure(),
    "runtime.discover": () => runtime.lookIfDown(),

    // chat.send's plan for every model and context without stopping any turn, from one reading.
    "fit.table": () => fitTable.get(),

    // From the moment chat.send took each turn, also while it waits for the GPU or a load.
    "turns.active": () => [...turns.values()]
      .filter((turn) => !turn.terminal && !turn.controller.signal.aborted)
      .map(({ turnId, threadId, clock }) => ({ turnId, threadId, reply: clock.record(Date.now()) })),
    "turns.blocking": async ({ model, numCtx }) => {
      if (![...turns.values()].some((t) => t.started)) return [];
      const baseUrl = runtime.baseUrl();
      if (baseUrl === undefined) throw notReady();
      return blockingTurns((await planBeside(baseUrl, model, numCtx)).stop);
    },

    // `image` is an older client's Image button: accepted and ignored (Tools › Make images decides now).
    "chat.send": (params) => withSendTimes(async () => {
      const { threadId, content, model, numCtx, messageId, retryOf, images = [], files: attaching = [], tools, think, draw, drawCount, stopOthers, stopTurns, askFirst } = params;
      if (closing()) throw new AppError("shutting-down", "the server is stopping; no new turns");
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
    }),

    "queue.list": () => queue.list(),
    "queue.add": (entry) => {
      // already saved (a window's copy of a message that went out), or its chat is going: nothing to queue
      if (store.getMessage(entry.messageId) === undefined && !deleting.has(entry.threadId)) {
        store.getThread(entry.threadId);
        if (queue.add(entry) === "removed") throw new AppError("queue-removed", "This message was removed from the queue.");
        pump();
      }
      return queue.list();
    },
    "queue.update": ({ id, ...patch }, ctx) => {
      if (queue.change(id, patch) === "sending") throw new AppError("queue-sending", "This message is already being sent.");
      // open in one window's composer: when that window's connection closes, the row goes on
      if (patch.editing === false) editors.delete(id);
      if (patch.editing === true) {
        editors.set(id, ctx.clientId);
        ctx.signal?.addEventListener("abort", () => {
          if (editors.get(id) !== ctx.clientId) return;
          editors.delete(id);
          queue.change(id, { editing: false });
          pump();
        }, { once: true });
      }
      pump();
      return queue.list();
    },
    "queue.remove": ({ id }) => {
      if (queue.remove(id)) editors.delete(id);
      return queue.list();
    },

    "chat.cancel": ({ turnId }) => {
      const turn = turns.get(turnId);
      if (turn === undefined) lateStop(turnId);
      if (turn === undefined || turn.controller.signal.aborted) return { cancelled: false };
      turn.stoppedAt = Date.now();
      // words already on their way when the Stop landed change no time on the row
      turn.clock.stop(turn.stoppedAt, turn.thinking);
      // every window stops its clock at the Stop, not when the stream winds down
      if (turn.start !== undefined) pushReply(turn);
      turn.controller.abort();
      return { cancelled: true };
    },
  } satisfies AppHandlers;
  return handlers;
}
