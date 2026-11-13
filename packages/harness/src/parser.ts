import type { ToolDefinition } from "./prompt.ts";
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
// \r\n too: a model may answer with Windows line endings.
const CALL_FENCE_HEADER = `${literal(FENCE)}(?:${CALL_FENCE_LANGUAGES.join("|")})[ \\t]*\\r?\\n`;
const CALL_FENCE = new RegExp(`${CALL_FENCE_HEADER}([\\s\\S]*?)${literal(FENCE)}`, "gi");
const CALL_FENCE_OPEN = new RegExp(CALL_FENCE_HEADER, "i");

/** {name, arguments|parameters}: the shape that makes a fenced JSON block a call. */
export function isCallShape(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value) && typeof (value as { name?: unknown }).name === "string"
    && ("arguments" in value || "parameters" in value);
}

/**
 * Where a call fence opens that the cut left unfinished, or undefined. Fences are found as
 * parseTextCalls finds them, by the same expression: after the last complete call fence, a
 * call fence header with no closing fence (the parser cannot close it, or it would have
 * matched), or a trailing fence cut inside its header. A body that is already complete JSON
 * of another shape is answer text, as the parser would treat it once closed.
 */
function unfinishedCallFence(visible: string): number | undefined {
  let from = 0;
  for (const match of visible.matchAll(CALL_FENCE)) from = match.index + match[0].length;
  const rest = visible.slice(from);
  const open = CALL_FENCE_OPEN.exec(rest);
  if (open) {
    let value: unknown;
    try { value = JSON.parse(rest.slice(open.index + open[0].length).trim()); } catch { return from + open.index; }
    return isCallShape(value) ? from + open.index : undefined;
  }
  const at = rest.lastIndexOf(FENCE);
  if (at < 0) return undefined;
  const header = rest.slice(at + FENCE.length).toLowerCase();
  const cutInHeader = CALL_FENCE_LANGUAGES.some(language => header.startsWith(language) ? /^[ \t]*\r?$/.test(header.slice(language.length)) : language.startsWith(header));
  return cutInHeader ? from + at : undefined;
}

/**
 * The visible answer part of a reply cut off mid-stream: what parseTextCalls keeps of it,
 * less the call syntax the cut left unfinished. That is a trailing start of the opening tag
 * (`<`, `<tool`, `<tool_call` with no `>`) and everything from a call fence that never
 * closed (see unfinishedCallFence). An unclosed opening tag and everything after it the
 * parser drops already.
 */
export function partialAnswer(text: string): string {
  let visible = outsideThinking(text);
  const fence = unfinishedCallFence(visible);
  if (fence !== undefined) visible = visible.slice(0, fence);
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
  if (!isCallShape(value)) return { calls, errors, items, content: content.trim() };
  calls.push(value); items.push({ call: value });
  return { calls, errors, items, content: content.replace(fence, "").trim() };
}

/**
 * The JSON shapes, [name key, arguments key], a model writes a call in when it puts the call
 * in its reply text instead of the runtime's tool_calls or the text-mode syntax. The last two
 * are ReAct/LangChain-style agent formats; Gemma 4 wrote `action` (2026-11-11). `{function:
 * {name, arguments}}` is accepted around the first.
 */
const LOOSE_SHAPES = [["name", "arguments"], ["name", "parameters"], ["action", "action_input"], ["tool", "tool_input"]] as const;
const WHOLE_FENCE = new RegExp(`^${literal(FENCE)}[\\w-]*[ \\t]*\\r?\\n([\\s\\S]*?)${literal(FENCE)}$`);
type LooseCall = { name: string; arguments: Record<string, unknown> };
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

type Property = { type?: string; minimum?: number; minItems?: number; items?: Property };
/** Whether one value fits one property: strings not empty, integers at their minimum, arrays of fitting items. */
function fitsProperty(property: Property | undefined, value: unknown): boolean {
  if (property?.type === "string") return typeof value === "string" && value.trim() !== "";
  if (property?.type === "integer") return typeof value === "number" && Number.isInteger(value) && value >= (property.minimum ?? -Infinity);
  if (property?.type === "array") return Array.isArray(value) && value.length >= (property.minItems ?? 0) && value.every(item => fitsProperty(property.items, item));
  return false;
}

/** Whether `input` fits the tool's offered schema: required fields present, no others, types right, strings not empty. */
function fitsDefinition(definition: ToolDefinition, input: Record<string, unknown>): boolean {
  const { properties, required } = definition.function.parameters;
  if (!required.every(key => key in input)) return false;
  return Object.entries(input).every(([key, value]) => fitsProperty(properties[key] as Property | undefined, value));
}

/** Whether a property takes text: a string, or a list of strings (one bare string is then a list of one). */
const takesText = (property: Property | undefined) => property?.type === "string" || (property?.type === "array" && property.items?.type === "string");

/** One parsed JSON value as a call to an offered tool, or undefined. */
function callFrom(value: unknown, offered: readonly ToolDefinition[]): LooseCall | undefined {
  if (!isObject(value)) return undefined;
  const keys = Object.keys(value);
  const wrapped = keys.length === 1 && keys[0] === "function";
  const object = wrapped ? value.function : value;
  if (!isObject(object)) return undefined;
  const shape = (wrapped ? LOOSE_SHAPES.slice(0, 1) : LOOSE_SHAPES).find(([name, args]) => Object.keys(object).length === 2 && name in object && args in object);
  if (!shape || typeof object[shape[0]] !== "string") return undefined;
  let args = object[shape[1]];
  if (typeof args === "string") { try { const parsed: unknown = JSON.parse(args); if (isObject(parsed)) args = parsed; } catch { /* a bare string */ } }
  let call: ToolCall;
  try { call = repairCall({ name: object[shape[0]], arguments: typeof args === "string" ? {} : args }); } catch { return undefined; }
  const definition = offered.find(d => d.function.name === call.name);
  if (!definition) return undefined;
  if (typeof args === "string") {
    // A bare string is the tool's one required text field (a list of one for a list), or not a call.
    const { required, properties } = definition.function.parameters;
    const property = properties[required[0]!] as Property | undefined;
    if (required.length !== 1 || !takesText(property)) return undefined;
    call.input = { [required[0]!]: property?.type === "array" ? [args] : args };
  }
  return fitsDefinition(definition, call.input) ? { name: call.name, arguments: call.input } : undefined;
}

/**
 * A reply whose whole visible text (outside thinking, trimmed, optionally inside one code fence)
 * is one JSON object naming a tool offered this turn, with arguments that fit its definition:
 * that call, in the `{name, arguments}` form repairCall reads. Anything else (other text beside
 * it, two objects, an unknown tool, arguments that do not fit, more than HOLD_LIMIT characters)
 * is not a call.
 */
export function looseCall(text: string, offered: readonly ToolDefinition[]): LooseCall | undefined {
  const visible = outsideThinking(text).trim();
  if (visible.length > HOLD_LIMIT) return undefined;
  const body = (WHOLE_FENCE.exec(visible)?.[1] ?? visible).trim();
  if (!body.startsWith("{")) return undefined;
  try { return callFrom(JSON.parse(body), offered); } catch { return undefined; }
}

/** Held text longer than this is shown, and is then never a call (createCallHold, looseCall). */
export const HOLD_LIMIT = 8000;

export interface CallHold {
  /** Reads the reply's next piece: whether the reply so far could still be a looseCall. Once false, false for good. */
  push(text: string): boolean;
  /** Characters read so far. Each is read once, so holding costs time linear in the reply. */
  readonly scanned: number;
}

const isSpace = (c: string) => c === " " || c === "\t" || c === "\n" || c === "\r";

/**
 * Watches a reply as it streams, for the moment it can no longer be a looseCall, so text held
 * back in case it is a call is shown at once. It can be one while it is white space, at most one
 * fence line, and one JSON object whose first key is a call's, whose name is a tool offered this
 * turn, whose second key is the first's partner and which has no third; once that object closes
 * it must be a call with at most a closing fence after it. More than HOLD_LIMIT characters never is.
 */
export function createCallHold(offered: readonly ToolDefinition[]): CallHold {
  let alive = offered.length > 0;
  let scanned = 0;
  let phase: "lead" | "ticks" | "header" | "open" | "object" | "after" = "lead";
  let ticks = 0; // backticks of the opening fence, then of the closing one
  let fenced = false;
  let header: "word" | "space" | "cr" = "word";
  let closingDone = false;
  let text = ""; // the object, parsed once when it closes
  let depth = 0;
  let inString = false;
  let escaped = false;
  // The call's own keys live at depth 1, or at depth 2 inside {"function": {...}}.
  let keyDepth = 1;
  let shapes: readonly (readonly [string, string])[] = LOOSE_SHAPES;
  let keys: string[] = [];
  let keyNext = false;
  let valueNext = false;
  let wrapClosed = false;
  let capture: "key" | "name" | undefined;
  let captured = "";

  const open = (c: string) => {
    if (c !== "{") return false;
    phase = "object"; text = c; depth = 1; keyNext = true;
    return true;
  };
  const capturedString = (kind: "key" | "name") => {
    let value: string;
    try { value = JSON.parse(`"${captured}"`) as string; } catch { return false; }
    if (kind === "name") return offered.some(d => d.function.name === repairName(value));
    const allowed = keys.length === 0
      ? [...shapes.flat(), ...(keyDepth === 1 ? ["function"] : [])]
      : shapes.flatMap(([name, args]) => name === keys[0] ? [args] : args === keys[0] ? [name] : []);
    keys.push(value);
    return allowed.includes(value);
  };
  const closed = () => {
    let value: unknown;
    try { value = JSON.parse(text); } catch { return false; }
    phase = "after"; ticks = 0;
    return callFrom(value, offered) !== undefined;
  };
  const inObject = (c: string): boolean => {
    text += c;
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') {
        inString = false;
        const kind = capture;
        capture = undefined;
        return kind ? capturedString(kind) : true;
      }
      if (capture) captured += c;
      return true;
    }
    if (isSpace(c)) return true;
    // After {"function": {...}} only its closing brace may come.
    if (wrapClosed) return c === "}" && closed();
    const level = depth === keyDepth;
    if (level && keyNext) {
      // A call's object opens with a key, as does each part after a comma: `{}`, `{\frac` and `{{ name }}` are not calls.
      if (c !== '"') return false;
      keyNext = false; inString = true; capture = "key"; captured = "";
      return true;
    }
    if (level && valueNext) {
      valueNext = false;
      const key = keys.at(-1);
      if (shapes.some(([name]) => name === key)) {
        if (c !== '"') return false;
        inString = true; capture = "name"; captured = "";
        return true;
      }
      if (key === "function") {
        if (c !== "{") return false;
        depth = 2; keyDepth = 2; shapes = LOOSE_SHAPES.slice(0, 1); keys = []; keyNext = true;
        return true;
      }
    }
    if (c === '"') inString = true;
    else if (c === ":" && level) valueNext = true;
    else if (c === "," && level) { if (keys.length >= 2) return false; keyNext = true; }
    else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") {
      if (--depth === 0) return closed();
      if (keyDepth === 2 && depth === 1) wrapClosed = true;
    }
    return true;
  };
  const step = (c: string): boolean => {
    switch (phase) {
      case "lead":
        if (isSpace(c)) return true;
        if (c === FENCE[0]) { phase = "ticks"; ticks = 1; return true; }
        return open(c);
      case "ticks":
        if (c !== FENCE[0]) return false;
        if (++ticks === FENCE.length) { phase = "header"; fenced = true; }
        return true;
      case "header":
        // The fence's info line: a word, spaces, a carriage return, then the line ends.
        if (c === "\n") { phase = "open"; return true; }
        if (header === "cr") return false;
        if (c === "\r") { header = "cr"; return true; }
        if (c === " " || c === "\t") { header = "space"; return true; }
        return header === "word" && /[\w-]/.test(c);
      case "open":
        return isSpace(c) || open(c);
      case "object":
        return inObject(c);
      case "after":
        // Only white space, and a fenced call's closing fence, may follow the call.
        if (isSpace(c)) { closingDone = ticks > 0; return true; }
        return fenced && c === FENCE[0] && !closingDone && ++ticks <= FENCE.length;
    }
  };
  return {
    push(piece) {
      for (let i = 0; alive && i < piece.length; i++) alive = ++scanned <= HOLD_LIMIT && step(piece[i]!);
      return alive;
    },
    get scanned() { return scanned; },
  };
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
  const name = repairName(value.name);
  // The image tool takes a list of prompts; a model that writes one prompt (the tool's older form,
  // or a habit) means a list of one.
  if (name === "image") {
    if (input.prompts === undefined && typeof input.prompt === "string") { input.prompts = [input.prompt]; delete input.prompt; }
    else if (typeof input.prompts === "string") input.prompts = [input.prompts];
  }
  return { name, input };
}

/** The tool a model's name for it means: models trained on other harnesses say bash for shell. */
function repairName(name: string): string {
  return name === "bash" ? "shell" : name;
}
