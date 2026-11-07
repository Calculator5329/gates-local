// Shared shapes for the thread store. Plain TypeScript; packages/contracts
// mirrors Thread and Message as Effect Schemas for the wire.

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
}

export interface Message {
  id: string;
  threadId: string;
  role: Role;
  content: string;
  thinking?: string;
  model?: string;
  createdAt: number;
  stats?: MessageStats;
}

export interface ThreadWithMessages {
  thread: Thread;
  messages: Message[];
}

/** What appendMessage accepts: a Message whose id and createdAt are optional. */
export interface NewMessage {
  id?: string;
  threadId: string;
  role: Role;
  content: string;
  thinking?: string;
  model?: string;
  createdAt?: number;
  stats?: MessageStats;
}
