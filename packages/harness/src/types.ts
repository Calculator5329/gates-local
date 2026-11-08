export interface LibraryEntry {
  id: string;
  kind: "folder" | "file" | "sqlite";
  label: string;
  path: string;
  snapshotPath?: string;
}
export interface ToolCall { name: string; input: Record<string, unknown>; }
export interface ToolResult { output: string; summary: string; }
export interface ToolStep {
  callId: string;
  name: string;
  state: "running" | "done" | "error";
  summary: string;
  detail?: string;
  durationMs?: number;
}
export interface ModelMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  tool_name?: string;
  tool_calls?: readonly { function: { name: string; arguments: Record<string, unknown> } }[];
}
/** Ollama's counts and times for the last model call; evalDurationMs is decode only. */
export type TurnStats = { promptTokens?: number; completionTokens?: number; durationMs?: number; evalDurationMs?: number; promptEvalDurationMs?: number };

export type ModelEvent =
  | { type: "delta" | "thinking"; text: string }
  | { type: "complete"; content: string; calls: readonly unknown[]; stopReason: string; thinking?: string; stats?: TurnStats };
export type LoopEvent = Exclude<ModelEvent, { type: "complete" }>
  | { type: "tool"; step: ToolStep }
  | { type: "complete"; content: string; thinking?: string; stopReason: string; tools: ToolStep[]; stats?: TurnStats };
/** `tools: false` is the final-answer request after a budget ran out: send no tool definitions. */
export type ModelStream = (messages: readonly ModelMessage[], options?: { tools: boolean }) => AsyncIterable<ModelEvent>;
