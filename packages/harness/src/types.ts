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
  /** With "error": the turn's cancel cut the call short, it did not fail (contracts ToolStep.stopped). */
  stopped?: true;
  summary: string;
  detail?: string;
  durationMs?: number;
  /** Server-owned provenance from the tool's successful output only. */
  links?: readonly string[];
}
export interface ModelMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  images?: readonly string[];
  imageTokens?: readonly number[];
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
/**
 * `tools: false` is the final-answer request after a budget ran out: send no tool definitions.
 * `signal` covers this one request (the turn's cancel, the tool-phase deadline, the stall guard):
 * pass it to the HTTP request so an abort closes the connection.
 */
export type ModelStream = (messages: readonly ModelMessage[], options?: { tools: boolean; signal?: AbortSignal }) => AsyncIterable<ModelEvent>;
