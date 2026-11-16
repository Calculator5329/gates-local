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
export const haltedEnd = (reason: AppError): TurnFailure => ({ type: "error", code: reason.code, message: reason.message, ...(reason.neededBy === undefined ? {} : { neededBy: reason.neededBy }) });

export const ENDED_EARLY: TurnFailure = { type: "error", code: "internal", message: "the reply ended without finishing" };

const NO_SECOND_TRY = new Set(["num-ctx-invalid", "context-too-small", "cancelled", "model-not-found"]);

export const runsAgain = (turn: Turn, failed: TurnFailure, stoppedAt: number | undefined): boolean =>
  !NO_SECOND_TRY.has(failed.code) && turn.halted === undefined && stoppedAt === undefined && !turn.dropReply
  && !turn.controller.signal.aborted && turn.steps.size === 0;

export const endedOf = (turn: Turn, event: TurnEnd, now: number, stoppedAt: number | undefined): TurnEnded => {
  if (event.type === "done") return { reason: "done", at: now };
  if (turn.halted !== undefined) return { reason: "preempted", at: now };
  if (event.code === "cancelled" && (turn.dropReply || stoppedAt !== undefined)) return { reason: "stopped", at: stoppedAt ?? now };
  return { reason: "failed", at: now };
};

export const endOf = (turn: Turn, event: TurnEnd, ended: TurnEnded): End => {
  if (event.type === "done") return { how: "done", replyId: event.message.id };
  if (ended.reason === "stopped") return { how: "stopped", by: { who: "person" } };
  if (ended.reason !== "preempted") return { how: "failed", code: event.code, message: event.message };
  const halted = turn.halted;
  if (halted?.code === "preempted") return { how: "stopped", by: { who: "preempted", ...(halted.neededBy === undefined ? {} : { neededBy: halted.neededBy }) } };
  return { how: "stopped", by: { who: halted?.code === "runtime-changed" ? "runtime" : "closing" } };
};

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

// why: the stage has one owner, the record (chat/reply.ts), asked before each write
export interface Turn {
  readonly turnId: string;
  readonly attempt: number;
  readonly threadId: string;
  readonly model: string;
  readonly controller: AbortController;
  readonly ended: Promise<void>;
  halted: AppError | undefined;
  readonly onHalt: Promise<typeof HALTED>;
  halt(reason: AppError): void;
  inMemory: boolean;
  admission?: Promise<Message>;
  draftId: string | undefined;
  dropReply: boolean;
  readonly clock: TurnClock;
  text: string;
  thinking: string;
  readonly steps: Map<string, ToolStep>;
}

export interface AppContext {
  readonly deps: AppDeps;
  readonly store: ThreadStore;
  readonly runtime: AppDeps["runtime"];
  readonly catalog: ModelCatalog;
  readonly log: (line: string) => void;
  readonly push: Push;
  readonly said: (said: TurnSaid) => void;
  readonly turns: Map<string, Turn>;
  readonly byThread: Map<string, Turn>;
  readonly closing: () => boolean;
  readonly deleting: Set<string>;
  readonly imageFiles: ReturnType<typeof imageLifecycle> | undefined;
  readonly imageReady: Promise<unknown>;
  readonly attachedFiles: ReturnType<typeof fileLifecycle> | undefined;
  readonly draftEveryMs: number;
  // why: the record is the one place a message's stage changes
  readonly replies: Replies;
  readonly fitTable: FitTableSource;
  readonly pushReply: (turn: Turn) => void;
  readonly answered: (turn: Turn) => void;
  readonly pushSpeeds: () => void;
  readonly reserve: (threadId: string, model: string, taken: Taken) => { turn: Turn; end: () => void };
  readonly pump: () => void;
}
