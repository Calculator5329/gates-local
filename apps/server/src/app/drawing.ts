import { randomUUID } from "node:crypto";
import type { ImageChoice, Message, Params } from "@gates-local/contracts";
import { IMAGES_UNSET, notRunning, type ImageModule } from "../image/module.ts";
import { threadChanged } from "../threads/sync.ts";
import { AppError, cancelledBeforeStart, refusalOf, threadGoing } from "./errors.ts";
import type { AppContext, Taken, Turn, TurnEnd } from "./turn.ts";

export interface ThreadImages {
  queueImage(image: ImageModule, params: Params<"image.generate">): Promise<{ jobId: string }>;
  queueImageFor(threadId: string, turnSignal: AbortSignal, choice: ImageChoice): (prompt: string) => Promise<{ jobId: string }>;
  cancelThreadImages(threadId: string): Promise<void>;
}

export function createThreadImages({ deps, deleting }: Pick<AppContext, "deps" | "deleting">): ThreadImages {
  const imageJobs = new Map<string, Set<Promise<string>>>();

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

  const queueImageFor = (threadId: string, turnSignal: AbortSignal, choice: ImageChoice) => async (prompt: string): Promise<{ jobId: string }> => {
    const job = await queueImage(deps.image!, { prompt, threadId, choice });
    const takeBack = () => deps.image?.cancel(job.jobId);
    if (turnSignal.aborted) takeBack();
    else turnSignal.addEventListener("abort", takeBack, { once: true });
    return job;
  };

  const cancelThreadImages = async (threadId: string) => {
    const image = deps.image;
    const queued = [...(imageJobs.get(threadId) ?? [])];
    if (image === undefined || queued.length === 0) return;
    const ids = (await Promise.all(queued.map((p) => p.catch(() => undefined)))).filter((id) => id !== undefined);
    for (const id of ids) image.cancel(id);
    await Promise.all(ids.map((id) => image.wait(id).catch(() => undefined)));
  };

  return { queueImage, queueImageFor, cancelThreadImages };
}

export interface DrawTurnDeps extends Pick<AppContext, "deps" | "store" | "log" | "push" | "said" | "reserve" | "replies"> {
  readonly queueImage: ThreadImages["queueImage"];
  readonly admitting: (turn: Turn, admission: Promise<Message>, replacedFiles?: readonly string[]) => void;
  readonly refused: (turn: Turn, e: unknown, stoppedAt: number | undefined) => void;
}

export type DrawTurn = (threadId: string, content: string, choice: ImageChoice, count: { now: number; saved: number }, messageId: string | undefined, replaced: readonly string[], attached: boolean, replacedFiles: readonly string[], taken: Taken) => { turnId: string };

export function createDrawTurn({ deps, store, log, push, said, reserve, replies, queueImage, admitting, refused }: DrawTurnDeps): DrawTurn {
  const drawTurn: DrawTurn = (threadId, content, choice, count, messageId, replaced, attached, replacedFiles, taken) => {
    const image = deps.image;
    if (attached) throw new AppError("image-input", "Image mode makes a picture from words alone. Remove the attachments, or turn Image off to ask a chat model about them.");
    if (image === undefined) throw new AppError("image-input", "Image generation is not available in this build.");
    const { turn, end } = reserve(threadId, choice.preset, taken);
    admitting(turn, queueDrawing(image, turn, end, { threadId, content, choice, count, messageId, replaced }), replacedFiles);
    return { turnId: turn.turnId };
  };

  const queueDrawing = async (
    image: ImageModule,
    turn: Turn,
    end: () => void,
    { threadId, content, choice, count, messageId, replaced }: { threadId: string; content: string; choice: ImageChoice; count: { now: number; saved: number }; messageId: string | undefined; replaced: readonly string[] },
  ): Promise<Message> => {
    const jobIds: string[] = [];
    let userMessage: Message;
    const still = () => replies.starting(turn.turnId, turn.attempt);
    const stoppedEarly = () => turn.halted ?? cancelledBeforeStart();
    try {
      await new Promise((resolve) => setImmediate(resolve));
      const missing = image.current().state === "missing" ? await image.status() : undefined;
      if (missing?.state === "missing") throw new AppError("image-input", missing.addressSet === true && missing.baseUrl !== undefined ? notRunning(missing.baseUrl) : IMAGES_UNSET);
      if (!still()) throw stoppedEarly();
      userMessage = store.appendMessage({ ...(messageId === undefined ? {} : { id: messageId }), threadId, role: "user", content }, replaced);
      try {
        const group = count.now > 1 ? randomUUID() : undefined;
        const seed = Math.floor(Math.random() * 2 ** 32);
        for (let index = 0; index < count.now; index++) {
          if (!still()) throw stoppedEarly();
          const tile = group === undefined ? {} : { group: { id: group, index, of: count.now }, seed: (seed + index) % 2 ** 32 };
          jobIds.push((await queueImage(image, { prompt: content, threadId, choice, ...tile })).jobId);
        }
        if (!replies.started(turn.turnId, turn.attempt, userMessage, choice.preset, { cold: false, drawing: true, jobs: jobIds })) throw stoppedEarly();
      } catch (e) {
        for (const id of jobIds) image.cancel(id);
        await Promise.all(jobIds.map((id) => image.wait(id).catch(() => undefined)));
        // why: a cancel or a thread delete may have taken the card already
        for (const id of jobIds) { try { store.deleteMessage(threadId, id); } catch {} }
        store.deleteMessage(threadId, userMessage.id);
        push(...threadChanged(store, threadId));
        throw e;
      }
    } catch (e) {
      replies.refused(turn.turnId, turn.attempt, refusalOf(e));
      const stoppedAt = replies.stoppedAt(turn.turnId);
      end();
      refused(turn, e, stoppedAt);
      throw e;
    }
    if (count.now !== count.saved) {
      try { store.setImageCount(threadId, count.now); } catch (e) { log(`turn ${turn.turnId}: image count not kept: ${(e as Error).message}`); }
    }
    push(...threadChanged(store, threadId));
    said({ turnId: turn.turnId, threadId, event: { type: "start", model: choice.preset, userMessage, image: true } });
    replies.notify();
    const stop = () => { for (const id of jobIds) image.cancel(id); };
    if (turn.controller.signal.aborted) stop();
    else turn.controller.signal.addEventListener("abort", stop, { once: true });
    void Promise.all(jobIds.map((id) => image.wait(id).catch(() => undefined))).then(() => {
      turn.controller.signal.removeEventListener("abort", stop);
      const [first] = jobIds as [string, ...string[]];
      const card = store.getMessage(first);
      if (turn.dropReply) {
        for (const id of jobIds) {
          if (store.getMessage(id) === undefined) continue;
          try { store.deleteMessage(threadId, id); } catch (e) { log(`turn ${turn.turnId}: image card not removed: ${(e as Error).message}`); }
        }
      }
      const last: TurnEnd = card === undefined || turn.dropReply
        ? { type: "error", code: "cancelled", message: "cancelled: its question was deleted" }
        : { type: "done", message: card, stopReason: "stop" };
      const now = Date.now();
      const event: TurnEnd = { ...last, ended: last.type === "done" ? { reason: "done", at: now } : { reason: "stopped", at: replies.stoppedAt(turn.turnId) ?? now } };
      replies.ended(turn.turnId, last.type === "done" ? { how: "done", replyId: last.message.id } : { how: "stopped", by: { who: "person" } }, now, last.type === "done" ? [last.message] : []);
      said({ turnId: turn.turnId, threadId, event });
      push(...threadChanged(store, threadId));
      replies.notify();
    }).finally(end);
    return userMessage;
  };

  return drawTurn;
}
