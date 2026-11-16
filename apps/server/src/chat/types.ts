export type Role = "user" | "assistant" | "system";

export interface MessageStats {
  promptTokens?: number;
  completionTokens?: number;
  durationMs?: number;
  numCtx?: number;
  // external: Ollama's eval_duration covers decode only
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
  tools?: import("@gates-local/harness").ToolStep[];
  images?: string[];
  contextNotice?: string;
}

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

// external: Ollama's done_reason is length when num_predict or num_ctx cut the reply
export type StopReason = "stop" | "length" | (string & {});

export type ChatEvent =
  | { type: "delta"; text: string }
  | { type: "thinking"; text: string }
  | { type: "done"; message: Message; stopReason: StopReason }
  | { type: "error"; code: ChatErrorCode; message: string };
