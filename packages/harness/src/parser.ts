import type { ToolCall } from "./types.ts";

export function outsideThinking(text: string): string {
  let depth = 0;
  let visible = "";
  for (const part of text.split(/(<\/?think>)/i)) {
    if (/^<think>$/i.test(part)) depth++;
    else if (/^<\/think>$/i.test(part)) depth = Math.max(0, depth - 1);
    else if (depth === 0) visible += part;
  }
  return visible;
}

/** Parse complete blocks only, after removing closed and unfinished thoughts. */
export function parseTextCalls(text: string): { calls: unknown[]; errors: string[]; content: string; items: ({ call: unknown } | { error: string })[] } {
  const visible = outsideThinking(text);
  const calls: unknown[] = [];
  const errors: string[] = [];
  const items: ({ call: unknown } | { error: string })[] = [];
  const invalid = (message: string) => { errors.push(message); items.push({ error: message }); };
  const content = visible.replace(/<tool_call>([\s\S]*?)(?:<\/tool_call>|$)/gi, (block: string, json: string) => {
    if (!block.toLowerCase().endsWith("</tool_call>")) invalid("Unfinished tool call");
    else {
      try { const call: unknown = JSON.parse(json.trim()); calls.push(call); items.push({ call }); }
      catch { invalid("Tool call must contain a JSON object with name and arguments"); }
    }
    return "";
  });
  if (items.length > 0) return { calls, errors, items, content: content.trim() };
  // Gemma-style models answer in a fence instead. Exactly one ```json or ```tool_code
  // block holding {name, arguments|parameters} is a call; more than one, or JSON of
  // another shape, is ordinary answer text. A fence that does not parse is a bad call.
  // \r\n too: a model may answer with Windows line endings.
  const fences = [...content.matchAll(/```(?:json|tool_code)[ \t]*\r?\n([\s\S]*?)```/gi)];
  if (fences.length !== 1) return { calls, errors, items, content: content.trim() };
  const [fence, body] = fences[0]!;
  let value: unknown;
  try { value = JSON.parse(body!.trim()); }
  catch {
    invalid("Fenced tool call must contain a JSON object with name and arguments");
    return { calls, errors, items, content: content.replace(fence, "").trim() };
  }
  const shaped = typeof value === "object" && value !== null && !Array.isArray(value) && typeof (value as { name?: unknown }).name === "string"
    && ("arguments" in value || "parameters" in value);
  if (!shaped) return { calls, errors, items, content: content.trim() };
  calls.push(value); items.push({ call: value });
  return { calls, errors, items, content: content.replace(fence, "").trim() };
}

export function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Tool call must be an object");
  return value as Record<string, unknown>;
}

export function repairCall(raw: unknown): ToolCall {
  let value = record(raw);
  if (value.function !== undefined) value = record(value.function);
  if (typeof value.name !== "string" || value.name === "") throw new Error("Tool call needs a name");
  let args = value.arguments ?? value.parameters ?? {};
  if (typeof args === "string") args = JSON.parse(args);
  const input = { ...record(args) };
  for (const key of ["limit", "offset", "timeoutMs"]) {
    const v = input[key];
    if (typeof v === "string" && /^\d+$/.test(v)) input[key] = Number(v);
  }
  return { name: value.name === "bash" ? "shell" : value.name, input };
}
