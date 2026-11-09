// Plain shapes for the streamed turn. Message and ChatEvent mirror the
// shared shapes packages/contracts carries as Schemas; the done event adds
// `stopReason` so a length stop is reported, not hidden.

export type Role = "user" | "assistant" | "system";

export interface MessageStats {
  promptTokens?: number;
  completionTokens?: number;
  durationMs?: number;
  numCtx?: number;
  /** Decode time only (Ollama's eval_duration); speed is completionTokens over this. */
  evalDurationMs?: number;
  promptEvalDurationMs?: number;
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
  tools?: import("../../../../packages/harness/src/types.ts").ToolStep[];
  images?: string[];
  contextNotice?: string;
}

/** What the model is sent. Thinking from earlier turns is not resent. */
export interface TurnMessage {
  role: Role;
  content: string;
  images?: readonly string[];
  imageTokens?: readonly number[];
}

export type ChatErrorCode =
  | "num-ctx-invalid"
  | "context-too-small"
  | "cancelled"
  | "connection-failed"
  | "http-error"
  | "model-not-found"
  | "stream-error"
  | "malformed-stream"
  | "stream-ended-early";

/** Ollama's done_reason: "stop" normally, "length" when num_predict or num_ctx cut the reply. */
export type StopReason = "stop" | "length" | (string & {});

export type ChatEvent =
  | { type: "delta"; text: string }
  | { type: "thinking"; text: string }
  | { type: "done"; message: Message; stopReason: StopReason }
  | { type: "error"; code: ChatErrorCode; message: string };
