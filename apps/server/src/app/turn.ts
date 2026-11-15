// A turn as the app holds it from chat.send's reserve to its end, how it ended, and the
// state the app's jobs share (app.ts builds it once and hands it to each).
import type { Message, Params, Payload, ToolStep, TurnEnded } from "@gates-local/contracts";
import type { fileLifecycle } from "../chat/files.ts";
import type { imageLifecycle } from "../chat/image-lifecycle.ts";
import type { Queue } from "../chat/queue.ts";
import type { Replies } from "../chat/replies.ts";
import type { TurnClock } from "../chat/times.ts";
import type { ChatEvent } from "../chat/types.ts";
import type { FitTableSource } from "../fit/table.ts";
import type { ModelCatalog } from "../runtime/models.ts";
import type { ThreadStore } from "../threads/store.ts";
import type { AppError } from "./errors.ts";
import type { Push } from "./push.ts";
import type { AppDeps } from "./types.ts";

export const HALTED = Symbol("halted");

export type WireEvent = Payload<"chat.event">["event"];
export type TurnEnd = Extract<WireEvent, { type: "done" | "error" }>;
export type TurnFailure = Extract<WireEvent, { type: "error" }>;
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
export const runsAgain = (turn: Turn, failed: TurnFailure): boolean =>
  !NO_SECOND_TRY.has(failed.code) && turn.halted === undefined && turn.stoppedAt === undefined && !turn.dropReply
  && !turn.controller.signal.aborted && turn.steps.size === 0;

export const endedOf = (turn: Turn, event: TurnEnd, now: number): TurnEnded => {
  if (event.type === "done") return { reason: "done", at: now };
  if (turn.halted !== undefined) return { reason: "preempted", at: now };
  if (event.code === "cancelled" && (turn.dropReply || turn.stoppedAt !== undefined)) return { reason: "stopped", at: turn.stoppedAt ?? now };
  return { reason: "failed", at: now };
};

export interface Turn {
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
  /** What chat.send asked: a Stop before its question is saved is answered with these words, on hold. */
  asked?: Pick<Params<"chat.send">, "content" | "messageId" | "images" | "files" | "think"> & { readonly numCtx?: number };
  start?: Extract<WireEvent, { type: "start" }>;
  /** The reply's row on disk while it streams. threads.get hides it: this reply reaches clients as its live turn. */
  draftId: string | undefined;
  /** Its thread or the question it answers is being deleted: the reply is dropped, not saved. */
  dropReply: boolean;
  /** When chat.cancel first came for it: a Stop's end is then, not when the stream wound down. */
  stoppedAt?: number;
  /** Its times from reserve(), saved on the reply. */
  readonly clock: TurnClock;
  /** chat.send has answered for it: its record may be pushed before its start. */
  answered?: boolean;
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
  /** deps.push, logging a failure; a chat.event also moves the queue. */
  readonly push: Push;
  /** Turns from chat.send's reserve to their end, by turn id. */
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
  readonly queue: Queue;
  /** Each waiting message as one record, and the answer to every call that names one. */
  readonly replies: Replies;
  readonly fitTable: FitTableSource;
  /** The turn's reply record as it is now, to every window. */
  readonly pushReply: (turn: Turn) => void;
  /** A turn that waits while its own model loads says "loading", not "waiting". */
  readonly waitsOnLoad: (turn: Turn) => void;
  /** The measured speeds, after a finished reply is saved or replies are deleted. */
  readonly pushSpeeds: () => void;
  /** Claims the thread synchronously so a second send cannot slip in during the fit check. */
  readonly reserve: (threadId: string, model: string) => { turn: Turn; end: () => void };
  /** Look at the queue once the current work settles. */
  readonly pump: () => void;
}
