import { randomUUID } from "node:crypto";
import { parseTextCalls, repairCall } from "./parser.ts";
import type { LoopEvent, ModelEvent, ModelMessage, ModelStream, ToolCall, ToolResult, ToolStep } from "./types.ts";

export function trimOutput(output: string): string {
  return output.length <= 10000 ? output : `${output.slice(0, 5000)}\n[${output.length - 10000} characters elided]\n${output.slice(-5000)}`;
}

export interface LoopInput {
  messages: readonly ModelMessage[];
  stream: ModelStream;
  execute: (call: ToolCall, signal: AbortSignal) => Promise<ToolResult>;
  signal: AbortSignal;
  native: boolean;
  maxTurns?: number;
}

/** Collect one whole model response before running any tool; length stops are never executable. */
export async function* runLoop(input: LoopInput): AsyncGenerator<LoopEvent> {
  const messages = [...input.messages];
  const tools: ToolStep[] = [];
  const images: string[] = [];
  let badCalls = 0;
  let thinking = "";
  const finish = (content: string, stopReason = "stop"): Extract<LoopEvent, { type: "complete" }> => ({ type: "complete", content, stopReason, tools, images, ...(thinking ? { thinking } : {}) });
  for (let turn = 0; turn < (input.maxTurns ?? 24); turn++) {
    input.signal.throwIfAborted();
    let complete: Extract<ModelEvent, { type: "complete" }> | undefined;
    for await (const event of input.stream(messages)) {
      input.signal.throwIfAborted();
      if (event.type === "complete") complete = event;
      // Text-mode call syntax must not leak into the answer. Emit its visible answer after parsing.
      else if (event.type === "thinking" || input.native) yield event;
    }
    if (!complete) throw new Error("The model stream ended without a done line");
    thinking += complete.thinking ?? "";
    const parsed = input.native ? { items: complete.calls.map(call => ({ call })), content: complete.content } : parseTextCalls(complete.content);
    const pending: { call?: ToolCall; error?: string; name: string }[] = parsed.items.map(item => {
      if ("error" in item) return { error: item.error, name: "invalid" };
      try { const call = repairCall(item.call); return { call, name: call.name }; }
      catch (e) { return { error: (e as Error).message, name: "invalid" }; }
    });
    if (!input.native && parsed.content) yield { type: "delta", text: parsed.content };
    if (complete.stopReason === "length") {
      for (const item of pending) {
        const step: ToolStep = { callId: randomUUID(), name: item.name, state: "error", summary: "Tool call was cut short", detail: "Output length limit reached; this call was not run." };
        tools.push(step); yield { type: "tool", step };
      }
      yield { ...finish(parsed.content || "The reply reached its length limit. No pending tools were run.", "length"), stats: complete.stats };
      return;
    }
    if (pending.length === 0) {
      yield { ...finish(parsed.content), stats: complete.stats };
      return;
    }
    messages.push({ role: "assistant", content: complete.content,
      ...(input.native ? { tool_calls: pending.flatMap(p => p.call ? [{ function: { name: p.call.name, arguments: p.call.input } }] : []) } : {}) });
    for (const item of pending) {
      input.signal.throwIfAborted();
      const callId = randomUUID();
      const started = Date.now();
      const detail = item.call ? JSON.stringify(item.call) : item.error ?? "Invalid tool call";
      let output: string;
      let step: ToolStep;
      if (!item.call) {
        badCalls++;
        output = item.error ?? "Invalid tool call";
        step = { callId, name: item.name, state: "error", summary: "Could not read the tool call", detail: `${detail}\n${output}` };
      } else {
        const running: ToolStep = { callId, name: item.name, state: "running", summary: runningSummary(item.name), detail };
        yield { type: "tool", step: running };
        try {
          const result = await input.execute(item.call, input.signal);
          input.signal.throwIfAborted();
          badCalls = 0;
          output = trimOutput(result.output);
          if (result.imagePath) images.push(result.imagePath);
          step = { ...running, state: "done", summary: result.summary, detail: `${detail}\n${output}`, durationMs: Date.now() - started };
        } catch (e) {
          if (input.signal.aborted) {
            const cancelled: ToolStep = { ...running, state: "error", summary: "Tool was cancelled", durationMs: Date.now() - started };
            tools.push(cancelled); yield { type: "tool", step: cancelled };
            input.signal.throwIfAborted();
          }
          // Invalid arguments count toward the format budget too; execution failures are observations.
          if (e instanceof TypeError) badCalls++;
          else badCalls = 0;
          output = trimOutput((e as Error).message);
          step = { ...running, state: "error", summary: "Tool could not finish", detail: `${detail}\n${output}`, durationMs: Date.now() - started };
        }
      }
      tools.push(step); yield { type: "tool", step };
      messages.push(input.native ? { role: "tool", tool_name: item.name, content: output } : { role: "user", content: `Tool result (${item.name}):\n${output}` });
      if (badCalls >= 3) {
        const message = "Stopped after three invalid tool calls in a row. Try rephrasing your request.";
        yield { type: "delta", text: message };
        yield finish(message); return;
      }
    }
  }
  const message = "Stopped after the tool turn limit. Ask a follow-up to continue.";
  yield { type: "delta", text: message };
  yield finish(message);
}

function runningSummary(name: string): string {
  if (name === "read") return "Reading your library";
  if (name === "image") return "Making an image";
  if (name === "sql") return "Reading database rows";
  return "Searching your library";
}
