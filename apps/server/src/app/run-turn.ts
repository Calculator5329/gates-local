// Running a reply: an admitted turn's stream from its first word to its one terminal event,
// the reply kept on disk while it streams, one more attempt after a failure of its own, and
// what is saved however it ends.
import type { Message, TurnEnded, WordsPart } from "@gates-local/contracts";
import type { LibraryEntry } from "@gates-local/harness";
import { PAGE_RULE } from "../chat/pages.ts";
import { sendTimesLine } from "../chat/send-times.ts";
import { streamTurn, type UsageFigures } from "../chat/stream.ts";
import { streamToolTurn } from "../chat/tools.ts";
import type { TurnMessage } from "../chat/types.ts";
import { fetchShow } from "../fit/ollama.ts";
import type { TurnLoad } from "../runtime/load.ts";
import type { TurnSettings } from "../settings/turn.ts";
import { threadChanged } from "../threads/sync.ts";
import type { NewMessage } from "../threads/types.ts";
import type { ThreadImages } from "./drawing.ts";
import { ENDED_EARLY, HALTED, endOf, endedOf, haltedEnd, runsAgain, type AppContext, type StreamDone, type Turn, type TurnEnd, type TurnFailure, type WireEvent } from "./turn.ts";

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

export type TurnOptions = { tools?: boolean; think?: boolean; settings?: TurnSettings; files?: readonly LibraryEntry[] };
export type RunTurn = (turn: Turn, end: () => void, baseUrl: string, model: string, numCtx: number, messages: TurnMessage[], load?: TurnLoad, options?: TurnOptions) => Promise<void>;

export interface TurnRunnerDeps extends Pick<AppContext, "deps" | "store" | "log" | "push" | "pushReply" | "draftEveryMs" | "replies" | "pushSpeeds"> {
  readonly queueImageFor: ThreadImages["queueImageFor"];
}

export function createTurnRunner({ deps, store, log, push, pushReply, draftEveryMs, replies, pushSpeeds, queueImageFor }: TurnRunnerDeps): RunTurn {
  const runTurn = async (turn: Turn, end: () => void, baseUrl: string, model: string, numCtx: number, messages: TurnMessage[], load?: TurnLoad, options: TurnOptions = {}) => {
    const { turnId, threadId, controller } = turn;
    let counted = false;
    /** The saved question this work answers, while its record says the reply has not ended. */
    const question = () => replies.question(turnId);
    const emit = (event: Exclude<WireEvent, TurnEnd | { type: "reply" | "start" }>) => {
      if (question() === undefined) return;
      // Only text means the model answered; an error, cancel or end goes through end() below.
      if (event.type === "delta" || event.type === "thinking") {
        load?.firstToken();
        const line = sendTimesLine(turnId);
        if (line !== undefined) log(line);
      }
      // the record takes the event first; the clock is told the stage the record now shows
      const stage = replies.heard(turnId, event);
      const changed = stage !== undefined && turn.clock.see(event, Date.now(), turn.thinking, stage);
      const part: Exclude<WordsPart, { type: "again" }> = event.type === "tool" ? event
        : event.type === "delta" ? { type: "text", from: turn.text.length, text: event.text } : { type: "thinking", from: turn.thinking.length, text: event.text };
      if (event.type === "delta") turn.text += event.text;
      if (event.type === "thinking") turn.thinking += event.text;
      if (event.type === "tool") turn.steps.set(event.step.callId, event.step);
      const replyId = replies.of(turnId)?.id;
      push("chat.event", { turnId, threadId, ...(replyId === undefined ? {} : { replyId }), event });
      if (replyId !== undefined && (part.type === "tool" || part.text !== "")) push("reply.words", { id: replyId, part });
      // the record after the event that changed it: a window has the words before the stage that names them
      if (changed) pushReply(turn);
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
      if (question() === undefined || turn.dropReply) return;
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
    const saveUnfinished = (failure: TurnFailure, ended: TurnEnded, asked: Message): TurnFailure => {
      const why = { code: failure.code, message: failure.message, ...(failure.neededBy === undefined ? {} : { neededBy: failure.neededBy }) };
      const times = turn.clock.end(ended, turn.thinking, why);
      try {
        if (turn.dropReply) {
          if (turn.draftId !== undefined) store.deleteMessage(threadId, turn.draftId);
          return failure;
        }
        if (nothingYet()) {
          store.stampTimes(threadId, asked.id, times);
          return { ...failure, question: { ...asked, times } };
        }
        return { ...failure, partial: store.appendMessage({ ...unfinishedRow(turn.halted !== undefined), times }, replacingDraft()) };
      } catch (e) {
        log(`turn ${turnId}: stopped reply not saved: ${(e as Error).message}`);
        return failure;
      }
    };
    /** The finished reply, saved complete. A store that refuses it keeps the words as an unfinished reply and ends the turn with that error. */
    const saveFinished = (done: StreamDone, now: number, asked: Message): TurnEnd => {
      try {
        return { ...done, message: store.appendMessage({ ...done.message, times: turn.clock.end({ reason: "done", at: now }, turn.thinking) }, replacingDraft()) };
      } catch (e) {
        const code = (e as { code?: unknown }).code;
        return saveUnfinished({ type: "error", code: typeof code === "string" ? code : "internal", message: `the final save failed: ${(e as Error).message}` }, { reason: "failed", at: now }, asked);
      }
    };
    /**
     * Every way a turn ends comes here: it decides what is saved, sends the one terminal event and
     * ends the record. Once only: the record says whether the reply has ended, and nothing is
     * awaited between that question and the record's end.
     */
    const finish = (outcome: StreamDone | TurnFailure) => {
      const asked = question();
      if (asked === undefined) return;
      clearTimeout(draftTimer);
      // Done wins over a Stop, never over deleting the thread or the question.
      const dropped = outcome.type === "done" && turn.dropReply ? { type: "error" as const, code: "cancelled" as const, message: "cancelled: its question was deleted" } : outcome;
      const now = Date.now();
      const stoppedAt = replies.stoppedAt(turnId);
      const saved = dropped.type === "done" ? saveFinished(dropped, now, asked) : saveUnfinished(dropped, endedOf(turn, dropped, now, stoppedAt), asked);
      const ended = endedOf(turn, saved, now, stoppedAt);
      const event: TurnEnd = { ...saved, ended };
      // The record ends with its last event: a window that reads now is told of no reply on its way.
      const rows = event.type === "done" ? [event.message] : event.partial !== undefined ? [event.partial] : event.question !== undefined ? [event.question] : [];
      replies.ended(turnId, endOf(turn, event, ended), now, rows);
      push("chat.event", { turnId, threadId, event });
      if (event.type === "done" || event.partial !== undefined) push(...threadChanged(store, threadId));
      if (event.type === "done") pushSpeeds();
      // after its last event: the windows hear what became of the messages that waited behind it
      replies.notify();
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
      // Run commands needs no Library: on Linux a ready shell is offered on its own (Windows has no shell tool).
      const shell = wantsTools && deps.shellStatus && process.platform !== "win32" ? await untilHalted(deps.shellStatus()) : undefined;
      if (shell === HALTED || turn.halted) { finish(haltedEnd(turn.halted!)); return; }
      const useTools = (wantsTools && (sources.length > 0 || shell?.state === "ready")) || image;
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
      // The page rule rides on every chat turn (chat/pages.ts): the turn that first asks for one cannot be told apart.
      // It joins a system message the app already sends; with no prompt read, the model's own still applies.
      const system = systemPrompt === undefined && offLine === undefined ? undefined
        : [systemPrompt, offLine, PAGE_RULE].filter(line => line !== undefined && line !== "").join("\n\n");
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
      // A reply that fails on its own runs once more: the person sees the second
      // attempt start over in the same place, and only its failure is said.
      for (let attempt = 1; ; attempt++) {
        const events = useTools ? streamToolTurn({ ...input, sources, image, ...(shell ? { shell } : {}), ...(imageChoice ? { queueImage: queueImageFor(threadId, controller.signal, imageChoice) } : {}) }) : streamTurn(input);
        const iterator = events[Symbol.asyncIterator]();
        let dropped = false;
        let failed: TurnFailure | undefined;
        try {
          for (;;) {
            const step = await untilHalted(iterator.next());
            if (step === HALTED || turn.halted) {
              dropped = step === HALTED;
              finish(haltedEnd(turn.halted!));
              return;
            }
            const event = step.done === true ? ENDED_EARLY : step.value;
            // A Stop that lands with the done line keeps the finished reply: the done event wins.
            if (event.type === "done") {
              finish(event);
              return;
            }
            if (event.type === "error") {
              failed = event;
              break;
            }
            emit(event);
          }
        } finally {
          // The generator's own cleanup (its finally: the socket, a queued image's take-back) runs on
          // every exit. A step a halt dropped is still pending, so that cleanup runs when it settles.
          const cleanup = iterator.return(undefined).catch(() => undefined);
          if (!dropped) await cleanup;
        }
        // the loop above leaves only by a failure; `?? ENDED_EARLY` is for the type checker
        if (failed === undefined || attempt > 1 || !runsAgain(turn, failed, replies.stoppedAt(turnId))) {
          finish(failed ?? ENDED_EARLY);
          return;
        }
        log(`turn ${turnId}: the reply failed (${failed.code}: ${failed.message}); running it once more`);
        // the second attempt starts over: no words of the first stay, on screen or on disk
        clearTimeout(draftTimer);
        draftTimer = undefined;
        drafted = false;
        if (turn.draftId !== undefined) {
          try {
            store.deleteMessage(threadId, turn.draftId);
          } catch (e) {
            log(`turn ${turnId}: first attempt's words not removed: ${(e as Error).message}`);
          }
          turn.draftId = undefined;
        }
        turn.text = "";
        turn.thinking = "";
        turn.steps.clear();
        // the record runs it again, and what waits behind it holds until the second attempt ends
        const stage = replies.retrying(turnId);
        if (stage === undefined) {
          finish(failed);
          return;
        }
        turn.clock.retry(Date.now(), stage);
        const again = replies.of(turnId)?.id;
        if (again !== undefined) push("reply.words", { id: again, part: { type: "again" } });
        pushReply(turn);
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
  return runTurn;
}
