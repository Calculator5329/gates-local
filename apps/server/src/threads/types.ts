import type { AttachedFile, ImageChoice, ImageCount, ImageEvent, ReplyTimes } from "@gates-local/contracts";

export type Role = "user" | "assistant" | "system";

export const ROLES: readonly Role[] = ["user", "assistant", "system"];

export interface Thread {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  imageChoice?: ImageChoice;
  imageCount?: ImageCount;
}

export interface MessageStats {
  promptTokens?: number;
  completionTokens?: number;
  durationMs?: number;
  numCtx?: number;
  evalDurationMs?: number;
  promptEvalDurationMs?: number;
}

export interface ToolStepRecord {
  callId: string;
  name: string;
  state: "running" | "done" | "error";
  stopped?: true;
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
  tools?: ToolStepRecord[];
  images?: string[];
  files?: AttachedFile[];
  interrupted?: true;
  imageJob?: ImageEvent;
  times?: ReplyTimes;
}

export interface ThreadWithMessages {
  thread: Thread;
  messages: Message[];
}

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
  tools?: ToolStepRecord[];
  images?: string[];
  files?: AttachedFile[];
  interrupted?: true;
  times?: ReplyTimes;
}
