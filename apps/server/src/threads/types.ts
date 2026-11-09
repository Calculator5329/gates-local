// Shared shapes for the thread store. Plain TypeScript; packages/contracts
// mirrors Thread and Message as Effect Schemas for the wire.
import type { ImageEvent } from "@gates-local/contracts";

export type Role = "user" | "assistant" | "system";

export const ROLES: readonly Role[] = ["user", "assistant", "system"];

export interface Thread {
  id: string;
  title: string;
  createdAt: number; // ms since epoch
  updatedAt: number; // ms since epoch
}

export interface MessageStats {
  promptTokens?: number;
  completionTokens?: number;
  durationMs?: number;
  numCtx?: number;
  /** Decode time only (Ollama's eval_duration); speed is completionTokens over this. */
  evalDurationMs?: number;
  promptEvalDurationMs?: number;
}

/** One tool call the assistant made in a turn; mirrors ToolStep in packages/contracts. */
export interface ToolStepRecord {
  callId: string;
  name: string;
  state: "running" | "done" | "error";
  summary: string;
  detail?: string;
  durationMs?: number;
  links?: readonly string[];
}

export const TOOL_STATES: readonly ToolStepRecord["state"][] = ["running", "done", "error"];

export interface Message {
  contextNotice?: string;
  id: string;
  threadId: string;
  role: Role;
  content: string;
  thinking?: string;
  model?: string;
  createdAt: number;
  stats?: MessageStats;
  /** Tool steps of the turn, in call order. */
  tools?: ToolStepRecord[];
  /** Paths of images the turn made, inside the app data dir. */
  images?: string[];
  imageJob?: ImageEvent;
}

export interface ThreadWithMessages {
  thread: Thread;
  messages: Message[];
}

/** What appendMessage accepts: a Message whose id and createdAt are optional. */
export interface NewMessage {
  contextNotice?: string;
  id?: string;
  threadId: string;
  role: Role;
  content: string;
  thinking?: string;
  model?: string;
  createdAt?: number;
  stats?: MessageStats;
  /** Tool steps of the turn, in call order. */
  tools?: ToolStepRecord[];
  /** Paths of images the turn made, inside the app data dir. */
  images?: string[];
}
