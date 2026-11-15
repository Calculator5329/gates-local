// Pictures in a chat: the image jobs a thread queued (its turns' image tool, image.generate with
// its threadId), and an Image mode turn, whose words go to the image module instead of a model.
import { randomUUID } from "node:crypto";
import type { ImageChoice, Message, Params } from "@gates-local/contracts";
import { IMAGES_UNSET, notRunning, type ImageModule } from "../image/module.ts";
import { AppError, cancelledBeforeStart, refusalOf, threadGoing } from "./errors.ts";
import type { AppContext, Taken, Turn, TurnEnd } from "./turn.ts";

export interface ThreadImages {
  /** Queues the job and, with a threadId, keeps it for threads.delete. Refuses a thread being deleted. */
  queueImage(image: ImageModule, params: Params<"image.generate">): Promise<{ jobId: string }>;
  /** The turn's image tool (see below). */
  queueImageFor(threadId: string, turnSignal: AbortSignal, choice: ImageChoice): (prompt: string) => Promise<{ jobId: string }>;
  /** Cancels every image job queued for this thread that has not settled, and waits for each to end. */
  cancelThreadImages(threadId: string): Promise<void>;
}

export function createThreadImages({ deps, deleting }: Pick<AppContext, "deps" | "deleting">): ThreadImages {
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

  /** Cancels every image job queued for this thread that has not settled, and waits for each to end. */
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

export interface DrawTurnDeps extends Pick<AppContext, "deps" | "store" | "log" | "push" | "reserve" | "replies"> {
  readonly queueImage: ThreadImages["queueImage"];
  /** Keeps the admission on the turn (admit.ts). */
  readonly admitting: (turn: Turn, admission: Promise<Message>, replacedFiles?: readonly string[]) => void;
  /** The one error event of a turn that ended before its start (admit.ts). */
  readonly refused: (turn: Turn, e: unknown, stoppedAt: number | undefined) => void;
}

/** `taken`: the start the picker took for a waiting message. `direct`: gives a window's own send its record, once its work is reserved. */
export type DrawTurn = (threadId: string, content: string, choice: ImageChoice, count: { now: number; saved: number }, messageId: string | undefined, replaced: readonly string[], attached: boolean, replacedFiles: readonly string[], taken: Taken | undefined, direct: (turn: Turn) => void) => { turnId: string };

export function createDrawTurn({ deps, store, log, push, reserve, replies, queueImage, admitting, refused }: DrawTurnDeps): DrawTurn {
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
  const drawTurn: DrawTurn = (threadId, content, choice, count, messageId, replaced, attached, replacedFiles, taken, direct) => {
    const image = deps.image;
    if (attached) throw new AppError("image-input", "Image mode makes a picture from words alone. Remove the attachments, or turn Image off to ask a chat model about them.");
    if (image === undefined) throw new AppError("image-input", "Image generation is not available in this build.");
    // An Image mode turn never counts as a chat model in GPU memory: the job's own GPU claim covers it.
    const { turn, end } = reserve(threadId, choice.preset, taken);
    direct(turn);
    admitting(turn, queueDrawing(image, turn, end, { threadId, content, choice, count, messageId, replaced }), replacedFiles);
    return { turnId: turn.turnId };
  };

  /** An Image mode turn chat.send answered: its question and its jobs, then its start; a refusal is its error event. */
  const queueDrawing = async (
    image: ImageModule,
    turn: Turn,
    end: () => void,
    { threadId, content, choice, count, messageId, replaced }: { threadId: string; content: string; choice: ImageChoice; count: { now: number; saved: number }; messageId: string | undefined; replaced: readonly string[] },
  ): Promise<Message> => {
    const jobIds: string[] = [];
    let userMessage: Message;
    /** The one check before anything of this start is written: its record is still starting, for this start. */
    const still = () => replies.starting(turn.turnId, turn.attempt);
    const stoppedEarly = () => turn.halted ?? cancelledBeforeStart();
    try {
      // after the answer has gone out
      await new Promise((resolve) => setImmediate(resolve));
      // No ComfyUI answered last time and the app has none to start: ask once more, and refuse before
      // any card or question is kept, so the words go back to the composer with one line of why.
      const missing = image.current().state === "missing" ? await image.status() : undefined;
      if (missing?.state === "missing") throw new AppError("image-input", missing.addressSet === true && missing.baseUrl !== undefined ? notRunning(missing.baseUrl) : IMAGES_UNSET);
      if (!still()) throw stoppedEarly();
      userMessage = store.appendMessage({ ...(messageId === undefined ? {} : { id: messageId }), threadId, role: "user", content }, replaced);
      try {
        const group = count.now > 1 ? randomUUID() : undefined;
        const seed = Math.floor(Math.random() * 2 ** 32);
        for (let index = 0; index < count.now; index++) {
          // the question is in, but not kept until every picture is queued: a start cut here undoes it below
          if (!still()) throw stoppedEarly();
          const tile = group === undefined ? {} : { group: { id: group, index, of: count.now }, seed: (seed + index) % 2 ** 32 };
          jobIds.push((await queueImage(image, { prompt: content, threadId, choice, ...tile })).jobId);
        }
        // The start is kept from here: its record becomes a reply, or (it moved on meanwhile) the start is undone.
        if (!replies.started(turn.turnId, turn.attempt, userMessage, choice.preset, { cold: false, drawing: true })) throw stoppedEarly();
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
      // its record hears why before the work leaves; one a Stop or a halt already moved stays as it is
      replies.refused(turn.turnId, turn.attempt, refusalOf(e));
      const stoppedAt = replies.stoppedAt(turn.turnId);
      end();
      refused(turn, e, stoppedAt);
      throw e;
    }
    // The thread makes this many from now on, as it keeps the choice it sent.
    if (count.now !== count.saved) {
      try { store.setImageCount(threadId, count.now); } catch (e) { log(`turn ${turn.turnId}: image count not kept: ${(e as Error).message}`); }
    }
    push("threads.changed", { threadId });
    push("chat.event", { turnId: turn.turnId, threadId, event: { type: "start", model: choice.preset, userMessage, image: true } });
    // after the start: the list every window shows no longer has this message
    replies.notify();
    const stop = () => { for (const id of jobIds) image.cancel(id); };
    if (turn.controller.signal.aborted) stop();
    else turn.controller.signal.addEventListener("abort", stop, { once: true });
    void Promise.all(jobIds.map((id) => image.wait(id).catch(() => undefined))).then(() => {
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
      const now = Date.now();
      const event: TurnEnd = { ...last, ended: last.type === "done" ? { reason: "done", at: now } : { reason: "stopped", at: replies.stoppedAt(turn.turnId) ?? now } };
      // The record ends with its last event; the windows hear what became of the messages behind it after that event.
      replies.ended(turn.turnId, last.type === "done" ? { how: "done", replyId: last.message.id } : { how: "stopped", by: { who: "person" } }, now);
      push("chat.event", { turnId: turn.turnId, threadId, event });
      push("threads.changed", { threadId });
      replies.notify();
    }).finally(end);
    return userMessage;
  };

  return drawTurn;
}
