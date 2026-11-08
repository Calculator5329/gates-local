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

/** The text-mode call markers. The parser and the cleanup of a cut reply both use these. */
export const CALL_OPEN = "<tool_call>";
export const CALL_CLOSE = "</tool_call>";
export const FENCE = "```";
/** A fence in one of these languages, holding {name, arguments|parameters}, is a call. */
export const CALL_FENCE_LANGUAGES = ["json", "tool_code"] as const;
const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const CALL_BLOCK = new RegExp(`${literal(CALL_OPEN)}([\\s\\S]*?)(?:${literal(CALL_CLOSE)}|$)`, "gi");
const CALL_FENCE = new RegExp(`${literal(FENCE)}(?:${CALL_FENCE_LANGUAGES.join("|")})[ \\t]*\\n([\\s\\S]*?)${literal(FENCE)}`, "gi");

/**
 * The visible answer part of a reply cut off mid-stream: what parseTextCalls keeps of it,
 * less the call syntax the cut left unfinished. That is a trailing start of the opening tag
 * (`<`, `<tool`, `<tool_call` with no `>`) and everything from a call fence that never
 * closed (its language named, or cut before it was). An unclosed opening tag and everything
 * after it the parser drops already.
 */
export function partialAnswer(text: string): string {
  let visible = outsideThinking(text);
  const fences = [...visible.matchAll(new RegExp(literal(FENCE), "g"))];
  if (fences.length % 2 === 1) {
    const at = fences.at(-1)!.index;
    const rest = visible.slice(at + FENCE.length).toLowerCase();
    const opensCall = CALL_FENCE_LANGUAGES.some(language => rest.startsWith(language) ? /^[ \t]*(?:\n|$)/.test(rest.slice(language.length)) : language.startsWith(rest));
    if (opensCall) visible = visible.slice(0, at);
  }
  const tail = visible.toLowerCase();
  for (let n = Math.min(CALL_OPEN.length - 1, tail.length); n > 0; n--) {
    if (CALL_OPEN.startsWith(tail.slice(-n))) { visible = visible.slice(0, -n); break; }
  }
  return parseTextCalls(visible).content;
}

/** Parse complete blocks only, after removing closed and unfinished thoughts. */
export function parseTextCalls(text: string): { calls: unknown[]; errors: string[]; content: string; items: ({ call: unknown } | { error: string })[] } {
  const visible = outsideThinking(text);
  const calls: unknown[] = [];
  const errors: string[] = [];
  const items: ({ call: unknown } | { error: string })[] = [];
  const invalid = (message: string) => { errors.push(message); items.push({ error: message }); };
  const content = visible.replace(CALL_BLOCK, (block: string, json: string) => {
    if (!block.toLowerCase().endsWith(CALL_CLOSE)) invalid("Unfinished tool call");
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
  const fences = [...content.matchAll(CALL_FENCE)];
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
