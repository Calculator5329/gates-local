// The work of one start as the app holds it from reserve to its end, how it ended, and the
// state the app's jobs share (app.ts builds it once and hands it to each).
import type { AttachedFile, BlockingTurn, FitOffer, FitReport, ImageChoice, ImageCount, Message, ToolStep, TurnEnded } from "@gates-local/contracts";
import type { fileLifecycle } from "../chat/files.ts";
import type { imageLifecycle } from "../chat/image-lifecycle.ts";
import type { Replies } from "../chat/replies.ts";
import type { End } from "../chat/reply.ts";
import type { ReplyRecord, TurnClock } from "../chat/times.ts";
import type { ChatEvent } from "../chat/types.ts";
import type { FitTableSource } from "../fit/table.ts";
import type { ModelCatalog } from "../runtime/models.ts";
import type { ThreadStore } from "../threads/store.ts";
import type { AppError } from "./errors.ts";
import type { Push } from "./push.ts";
import type { AppDeps } from "./types.ts";

export const HALTED = Symbol("halted");

export interface TurnFailure {
  readonly type: "error";
  readonly code: string;
  readonly message: string;
  readonly ended?: TurnEnded;
  readonly partial?: Message;
  readonly question?: Message;
  readonly neededBy?: string;
  readonly blocking?: readonly BlockingTurn[];
  readonly fit?: FitReport;
  readonly offer?: FitOffer;
}
export type TurnEnd = { readonly type: "done"; readonly message: Message; readonly stopReason: string; readonly ended?: TurnEnded } | TurnFailure;
export type TurnEvent =
  | { readonly type: "start"; readonly model: string; readonly userMessage: Message; readonly image?: true }
  | { readonly type: "delta" | "thinking"; readonly text: string }
  | { readonly type: "tool"; readonly step: ToolStep }
  | { readonly type: "reply"; readonly reply: ReplyRecord }
  | TurnEnd;
export interface TurnSaid {
  readonly turnId: string;
  readonly threadId: string;
  readonly replyId?: string;
  readonly event: TurnEvent;
}
export type StreamDone = Extract<ChatEvent, { type: "done" }>;
/** A halt's one terminal event: its error's code, message and, for preempted, the model that needed the GPU. */
export const haltedEnd = (reason: AppError): TurnFailure => ({ type: "error", code: reason.code, message: reason.message, ...(reason.neededBy === undefined ? {} : { neededBy: reason.neededBy }) });

/**
 * How `turn` ended with `event`, decided here once so no client guesses from codes:
 * a halt made way for something; a Stop, or deleting its question, stopped it; else done or failed.
 * A failure of its own that lands after a Stop is said as one.
 */
export const ENDED_EARLY: TurnFailure = { type: "error", code: "internal", message: "the reply ended without finishing" };

/** Failures a second attempt cannot change: a setting, a missing model, a cancel. */
const NO_SECOND_TRY = new Set(["num-ctx-invalid", "context-too-small", "cancelled", "model-not-found"]);

/**
 * A reply that failed on its own runs once more: never one the person stopped, a
 * halt ended or a delete dropped, and never one whose calls already ran, since a second attempt
 * would run them again (a shell command, a queued picture).
 */
export const runsAgain = (turn: Turn, failed: TurnFailure, stoppedAt: number | undefined): boolean =>
  !NO_SECOND_TRY.has(failed.code) && turn.halted === undefined && stoppedAt === undefined && !turn.dropReply
  && !turn.controller.signal.aborted && turn.steps.size === 0;

/** `stoppedAt`: when a Stop cut this work, from its record (replies.stoppedAt). */
export const endedOf = (turn: Turn, event: TurnEnd, now: number, stoppedAt: number | undefined): TurnEnded => {
  if (event.type === "done") return { reason: "done", at: now };
  if (turn.halted !== undefined) return { reason: "preempted", at: now };
  if (event.code === "cancelled" && (turn.dropReply || stoppedAt !== undefined)) return { reason: "stopped", at: stoppedAt ?? now };
  return { reason: "failed", at: now };
};

/** The same end, as the reply's record takes it: who stopped it, or why it failed. */
export const endOf = (turn: Turn, event: TurnEnd, ended: TurnEnded): End => {
  if (event.type === "done") return { how: "done", replyId: event.message.id };
  if (ended.reason === "stopped") return { how: "stopped", by: { who: "person" } };
  if (ended.reason !== "preempted") return { how: "failed", code: event.code, message: event.message };
  const halted = turn.halted;
  if (halted?.code === "preempted") return { how: "stopped", by: { who: "preempted", ...(halted.neededBy === undefined ? {} : { neededBy: halted.neededBy }) } };
  return { how: "stopped", by: { who: halted?.code === "runtime-changed" ? "runtime" : "closing" } };
};

/** The start the picker took a waiting message for: its turn, and which start of the message it is. */
export interface Taken {
  readonly turnId: string;
  readonly attempt: number;
}

export interface StartParams {
  readonly threadId: string;
  readonly content: string;
  readonly model: string;
  readonly numCtx: number;
  readonly messageId?: string;
  readonly retryOf?: string;
  readonly images?: readonly string[];
  readonly files?: readonly AttachedFile[];
  readonly think?: boolean;
  readonly tools?: boolean;
  readonly draw?: ImageChoice;
  readonly drawCount?: ImageCount;
  readonly stopOthers?: boolean;
  readonly stopTurns?: readonly string[];
  readonly askFirst?: boolean;
}

export interface StartAnswer {
  readonly turnId: string;
  readonly userMessage?: Message;
  readonly replayed?: boolean;
}

/**
 * The work of one start, from the moment it is taken until it has given back everything it took:
 * what it holds (its abort, its model's memory, its words so far), never which stage its reply
 * is in. The stage is its record's (chat/reply.ts), and this work asks the record before it writes.
 */
export interface Turn {
  readonly turnId: string;
  /** Which start of its message this is: the record checks it before this work may save. */
  readonly attempt: number;
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
   * Its model holds (or is loading into) GPU memory, so a later load plans around it.
   * Set inside the load gate when its fit passes, before the user message is saved.
   */
  inMemory: boolean;
  /** Its saved question once it starts; rejects with its refusal (App.started). */
  admission?: Promise<Message>;
  /** The reply's row on disk while it streams. threads.get hides it: this reply reaches clients as its live turn. */
  draftId: string | undefined;
  /** Its thread or the question it answers is being deleted: the reply is dropped, not saved. */
  dropReply: boolean;
  /** Its times from reserve(), saved on the reply. */
  readonly clock: TurnClock;
  text: string;
  thinking: string;
  readonly steps: Map<string, ToolStep>;
}

/** What createApp builds once and every job of the app reads: its deps, the turns, the queue and the pushes. */
export interface AppContext {
  readonly deps: AppDeps;
  readonly store: ThreadStore;
  readonly runtime: AppDeps["runtime"];
  readonly catalog: ModelCatalog;
  readonly log: (line: string) => void;
  /** deps.push, logging a failure. */
  readonly push: Push;
  readonly said: (said: TurnSaid) => void;
  /** Turns from their reserve to their end, by turn id. */
  readonly turns: Map<string, Turn>;
  /** The same turns by thread: one at a time in each. */
  readonly byThread: Map<string, Turn>;
  /** shutdown() has begun: no new turns. */
  readonly closing: () => boolean;
  /** Threads whose threads.delete is running: marked before its first await, cleared when it ends. */
  readonly deleting: Set<string>;
  /** Pasted images' copies (chat/image-lifecycle.ts), with a data folder. */
  readonly imageFiles: ReturnType<typeof imageLifecycle> | undefined;
  /** The start-up sweep of pasted images; a send and a delete wait for it. */
  readonly imageReady: Promise<unknown>;
  /** Attached files' copies (chat/files.ts), with a data folder. */
  readonly attachedFiles: ReturnType<typeof fileLifecycle> | undefined;
  readonly draftEveryMs: number;
  /** Every message's record, and the one place its stage changes. */
  readonly replies: Replies;
  readonly fitTable: FitTableSource;
  /** The turn's reply record as it is now, to every window. */
  readonly pushReply: (turn: Turn) => void;
  /** The start's answer has gone out for this turn: from here a load of its own model that it waits behind is said as "loading". */
  readonly answered: (turn: Turn) => void;
  /** The measured speeds, after a finished reply is saved or replies are deleted. */
  readonly pushSpeeds: () => void;
  /** Claims the thread synchronously so a second send cannot slip in during the fit check. `taken`: the start the picker took. */
  readonly reserve: (threadId: string, model: string, taken: Taken) => { turn: Turn; end: () => void };
  /** Look at the queue once the current work settles. */
  readonly pump: () => void;
}
