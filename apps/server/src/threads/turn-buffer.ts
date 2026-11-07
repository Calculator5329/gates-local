// In-memory home for one streaming turn. Token deltas and thinking deltas
// accumulate here; finish() hands back the completed Message for the store to
// persist, discard() drops it on cancel or error. The buffer holds no store
// or database handle, so nothing partial can reach SQLite through it.

import { randomUUID } from "node:crypto";

import { InvalidInputError, TurnBufferClosedError } from "./errors.ts";
import type { Message, MessageStats, Role } from "./types.ts";

export type TurnBufferState = "streaming" | "finished" | "discarded";

export interface TurnBufferOptions {
  threadId: string;
  role?: Role; // default "assistant"
  model?: string;
  now?: () => number;
}

export interface TurnPartial {
  content: string;
  thinking: string;
}

export interface TurnBuffer {
  readonly threadId: string;
  readonly state: TurnBufferState;
  readonly startedAt: number;
  appendDelta(text: string): void;
  appendThinking(text: string): void;
  partial(): TurnPartial;
  /**
   * Ends the turn and returns the completed Message (not yet stored).
   * createdAt is the finish time, so persisted order matches completion
   * order. durationMs defaults to finish minus start when stats omit it.
   */
  finish(stats?: MessageStats): Message;
  /** Drops everything buffered. Idempotent; a no-op after finish(). */
  discard(): void;
}

function text(field: string, value: unknown): string {
  if (typeof value !== "string") throw new InvalidInputError(field, "expected a string");
  return value;
}

export function createTurnBuffer(options: TurnBufferOptions): TurnBuffer {
  if (typeof options.threadId !== "string" || options.threadId.length === 0) {
    throw new InvalidInputError("threadId", "expected a non-empty string");
  }
  const now = options.now ?? Date.now;
  const threadId = options.threadId;
  const role: Role = options.role ?? "assistant";
  const startedAt = now();
  let state: TurnBufferState = "streaming";
  let content: string[] = [];
  let thinking: string[] = [];

  const open = (): void => {
    if (state !== "streaming") throw new TurnBufferClosedError(state);
  };

  return {
    threadId,
    get state() {
      return state;
    },
    startedAt,

    appendDelta(t) {
      open();
      content.push(text("delta", t));
    },

    appendThinking(t) {
      open();
      thinking.push(text("thinking", t));
    },

    partial() {
      return { content: content.join(""), thinking: thinking.join("") };
    },

    finish(stats) {
      open();
      const finishedAt = now();
      const msg: Message = { id: randomUUID(), threadId, role, content: content.join(""), createdAt: finishedAt };
      const think = thinking.join("");
      if (think.length > 0) msg.thinking = think;
      if (options.model !== undefined) msg.model = options.model;
      const s: MessageStats = { ...stats };
      if (s.durationMs === undefined) s.durationMs = Math.max(0, finishedAt - startedAt);
      msg.stats = s;
      state = "finished";
      content = [];
      thinking = [];
      return msg;
    },

    discard() {
      if (state !== "streaming") return;
      state = "discarded";
      content = [];
      thinking = [];
    },
  };
}
