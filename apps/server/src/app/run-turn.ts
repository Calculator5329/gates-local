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
import { ENDED_EARLY, HALTED, endOf, endedOf, haltedEnd, runsAgain, type AppContext, type StreamDone, type Turn, type TurnEnd, type TurnEvent, type TurnFailure } from "./turn.ts";

// external: Ollama's /api/show lists a model's capabilities, "thinking" among them
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

export interface TurnRunnerDeps extends Pick<AppContext, "deps" | "store" | "log" | "push" | "said" | "pushReply" | "draftEveryMs" | "replies" | "pushSpeeds"> {
  readonly queueImageFor: ThreadImages["queueImageFor"];
}

export function createTurnRunner({ deps, store, log, push, said, pushReply, draftEveryMs, replies, pushSpeeds, queueImageFor }: TurnRunnerDeps): RunTurn {
  const runTurn = async (turn: Turn, end: () => void, baseUrl: string, model: string, numCtx: number, messages: TurnMessage[], load?: TurnLoad, options: TurnOptions = {}) => {
    const { turnId, threadId, controller } = turn;
    let counted = false;
    const question = () => replies.question(turnId);
    const emit = (event: Exclude<TurnEvent, TurnEnd | { type: "reply" | "start" }>) => {
      if (question() === undefined) return;
      if (event.type === "delta" || event.type === "thinking") {
        load?.firstToken();
        const line = sendTimesLine(turnId);
        if (line !== undefined) log(line);
      }
      const stage = replies.heard(turnId, event);
      const changed = stage !== undefined && turn.clock.see(event, Date.now(), turn.thinking, stage);
      const part: Exclude<WordsPart, { type: "again" }> = event.type === "tool" ? event
        : event.type === "delta" ? { type: "text", from: turn.text.length, text: event.text } : { type: "thinking", from: turn.thinking.length, text: event.text };
      if (event.type === "delta") turn.text += event.text;
      if (event.type === "thinking") turn.thinking += event.text;
      if (event.type === "tool") turn.steps.set(event.step.callId, event.step);
      const replyId = replies.of(turnId)?.id;
      said({ turnId, threadId, ...(replyId === undefined ? {} : { replyId }), event });
      if (replyId !== undefined && (part.type === "tool" || part.text !== "")) push("reply.words", { id: replyId, part });
      if (changed) pushReply(turn);
      keepDraft();
    };
    const nothingYet = () => turn.text === "" && turn.thinking === "" && turn.steps.size === 0;
    const replacingDraft = () => (turn.draftId === undefined ? [] : [turn.draftId]);
    const unfinishedRow = (halted = false): NewMessage => {
      const tools = [...turn.steps.values()].map((t) => t.state === "running" ? { ...t, state: "error" as const, ...(halted ? { stopped: true as const } : {}) } : t);
      return { threadId, role: "assistant", content: turn.text, interrupted: true, ...(turn.thinking === "" ? {} : { thinking: turn.thinking }), ...(tools.length === 0 ? {} : { tools }), model, stats: { numCtx } };
    };
    let drafted = false;
    let draftTimer: ReturnType<typeof setTimeout> | undefined;
    const writeDraft = () => {
      draftTimer = undefined;
      if (question() === undefined || turn.dropReply) return;
      try {
        turn.draftId = store.appendMessage(unfinishedRow(), replacingDraft()).id;
      } catch (e) {
        log(`turn ${turnId}: reply in progress not written: ${(e as Error).message}`);
      }
    };
    const keepDraft = () => {
      if (nothingYet()) return;
      if (drafted) draftTimer ??= setTimeout(writeDraft, draftEveryMs);
      else {
        drafted = true;
        writeDraft();
      }
    };
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
    const saveFinished = (done: StreamDone, now: number, asked: Message): TurnEnd => {
      try {
        return { ...done, message: store.appendMessage({ ...done.message, times: turn.clock.end({ reason: "done", at: now }, turn.thinking) }, replacingDraft()) };
      } catch (e) {
        const code = (e as { code?: unknown }).code;
        return saveUnfinished({ type: "error", code: typeof code === "string" ? code : "internal", message: `the final save failed: ${(e as Error).message}` }, { reason: "failed", at: now }, asked);
      }
    };
    // why: nothing is awaited between the not-ended check and the record's end
    const finish = (outcome: StreamDone | TurnFailure) => {
      const asked = question();
      if (asked === undefined) return;
      clearTimeout(draftTimer);
      const dropped = outcome.type === "done" && turn.dropReply ? { type: "error" as const, code: "cancelled" as const, message: "cancelled: its question was deleted" } : outcome;
      const now = Date.now();
      const stoppedAt = replies.stoppedAt(turnId);
      const saved = dropped.type === "done" ? saveFinished(dropped, now, asked) : saveUnfinished(dropped, endedOf(turn, dropped, now, stoppedAt), asked);
      const ended = endedOf(turn, saved, now, stoppedAt);
      const event: TurnEnd = { ...saved, ended };
      const rows = event.type === "done" ? [event.message] : event.partial !== undefined ? [event.partial] : event.question !== undefined ? [event.question] : [];
      const wrote = event.type === "done" || event.partial !== undefined;
      replies.ended(turnId, endOf(turn, event, ended), now, rows, wrote ? store.numbers.chat(threadId) : undefined);
      said({ turnId, threadId, event });
      if (event.type === "done") pushSpeeds();
      replies.notify();
      // why: after the rows' change, so a window that took their number reads nothing for this push
      if (wrote) push(...threadChanged(store, threadId));
    };
    const untilHalted = <T>(work: Promise<T>): Promise<T | typeof HALTED> => {
      work.catch(() => undefined);
      return Promise.race([work, turn.onHalt]);
    };
    try {
      const wantsTools = options.tools ?? deps.toolsEnabled?.() ?? false;
      const sources = wantsTools ? [...deps.sources?.entries() ?? [], ...options.files ?? []] : [];
      const toolChoice = wantsTools && deps.image !== undefined ? deps.imageTool?.() : undefined;
      const imageChoice = toolChoice === undefined ? undefined : store.imageChoiceOf(threadId) ?? toolChoice;
      const image = imageChoice !== undefined;
      const shell = wantsTools && deps.shellStatus && process.platform !== "win32" ? await untilHalted(deps.shellStatus()) : undefined;
      if (shell === HALTED || turn.halted) { finish(haltedEnd(turn.halted!)); return; }
      const useTools = (wantsTools && (sources.length > 0 || shell?.state === "ready")) || image;
      // external: Ollama refuses think: true for a model that cannot think
      const think = await untilHalted(thinkFlag(baseUrl, model, options.think ?? deps.think, controller.signal));
      if (think === HALTED || turn.halted) {
        finish(haltedEnd(turn.halted!));
        return;
      }
      let systemPrompt = options.settings?.systemPrompt;
      if (systemPrompt === undefined && deps.settings !== undefined) {
        const show = await untilHalted(fetchShow(baseUrl, model, controller.signal));
        if (show === HALTED || turn.halted) { finish(haltedEnd(turn.halted!)); return; }
        systemPrompt = show.system ?? "";
      }
      const offLine = image || deps.image === undefined ? undefined : deps.imageOff?.(wantsTools);
      // why: the turn that first asks for a page can't be told apart, so it rides on every turn
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
        ...(deps.usage ? { onUsage: (figures: UsageFigures) => {
          if (figures.promptTokens === undefined && figures.completionTokens === undefined) return;
          deps.usage!.record(model, figures, !counted);
          counted = true;
        } } : {}),
      };
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
          const cleanup = iterator.return(undefined).catch(() => undefined);
          if (!dropped) await cleanup;
        }
        // why: the loop leaves only by a failure; `?? ENDED_EARLY` is for the type checker
        if (failed === undefined || attempt > 1 || !runsAgain(turn, failed, replies.stoppedAt(turnId))) {
          finish(failed ?? ENDED_EARLY);
          return;
        }
        log(`turn ${turnId}: the reply failed (${failed.code}: ${failed.message}); running it once more`);
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
