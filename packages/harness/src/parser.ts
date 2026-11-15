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
const LF_OR_CRLF = "\\r?\\n";
const CALL_FENCE_HEADER = `${literal(FENCE)}(?:${CALL_FENCE_LANGUAGES.join("|")})[ \\t]*${LF_OR_CRLF}`;
const CALL_FENCE = new RegExp(`${CALL_FENCE_HEADER}([\\s\\S]*?)${literal(FENCE)}`, "gi");
const CALL_FENCE_OPEN = new RegExp(CALL_FENCE_HEADER, "i");

/** {name, arguments|parameters}: the shape that makes a fenced JSON block a call. */
export function isCallShape(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value) && typeof (value as { name?: unknown }).name === "string"
    && ("arguments" in value || "parameters" in value);
}

function startOfUnfinishedCallFence(visible: string): number | undefined {
  let from = 0;
  for (const match of visible.matchAll(CALL_FENCE)) from = match.index + match[0].length;
  const rest = visible.slice(from);
  const open = CALL_FENCE_OPEN.exec(rest);
  if (open) {
    const start = from + open.index;
    let value: unknown;
    try { value = JSON.parse(rest.slice(open.index + open[0].length).trim()); } catch { return start; }
    // why: complete JSON of another shape is answer text, as the parser treats it once closed.
    return isCallShape(value) ? start : undefined;
  }
  const lastFence = rest.lastIndexOf(FENCE);
  if (lastFence < 0) return undefined;
  const header = rest.slice(lastFence + FENCE.length).toLowerCase();
  const cutInHeader = CALL_FENCE_LANGUAGES.some(language => header.startsWith(language) ? /^[ \t]*\r?$/.test(header.slice(language.length)) : language.startsWith(header));
  return cutInHeader ? from + lastFence : undefined;
}

/**
 * The visible answer part of a reply cut off mid-stream: what parseTextCalls keeps of it,
 * less the call syntax the cut left unfinished. That is a trailing start of the opening tag
 * (`<`, `<tool`, `<tool_call` with no `>`) and everything from a call fence that never
 * closed, found by the expression parseTextCalls finds fences with. An unclosed opening tag
 * and everything after it the parser drops already.
 */
export function partialAnswer(text: string): string {
  let visible = outsideThinking(text);
  const fence = startOfUnfinishedCallFence(visible);
  if (fence !== undefined) visible = visible.slice(0, fence);
  const tail = visible.toLowerCase();
  for (let n = Math.min(CALL_OPEN.length - 1, tail.length); n > 0; n--) {
    if (CALL_OPEN.startsWith(tail.slice(-n))) { visible = visible.slice(0, -n); break; }
  }
  return parseTextCalls(visible).content;
}

const THINK_TAG = /<\/?think>/i;
const THINK_TAGS = ["<think>", "</think>"] as const;
function partialEnd(text: string, words: readonly string[]): number {
  const tail = text.slice(-Math.max(...words.map(w => w.length))).toLowerCase();
  for (let n = tail.length; n > 0; n--) if (words.some(w => n < w.length && w.startsWith(tail.slice(-n)))) return n;
  return 0;
}

/**
 * `push` reads the reply's next piece. `visible` is the new text outside thinking (what looseCall
 * reads); `shown` is the new text that can go on screen now: it can no longer be call syntax.
 */
export interface TextView {
  push(text: string): { visible: string; shown: string };
}

/**
 * A text-mode reply as it streams. Text is shown while it cannot be a call: everything up to a
 * `<tool_call>` tag or a call fence's header line (CALL_FENCE_LANGUAGES), outside thinking. From
 * there on nothing more is shown until the reply is whole and parsed. A start of a tag or a
 * fence at the end of a piece, and white space, wait for what follows them. So what is shown is
 * always the start of parseTextCalls' content for the whole reply.
 */
export function createTextView(): TextView {
  // why: raw keeps only the end of the reply that might still be a think tag.
  let raw = "";
  let depth = 0;
  let visible = "";
  let blocked = false;
  let started = false;
  let space = "";
  const outside = (text: string): string => {
    raw += text;
    let out = "";
    for (let tag = THINK_TAG.exec(raw); tag; tag = THINK_TAG.exec(raw)) {
      if (depth === 0) out += raw.slice(0, tag.index);
      depth = tag[0][1] === "/" ? Math.max(0, depth - 1) : depth + 1;
      raw = raw.slice(tag.index + tag[0].length);
    }
    const keep = partialEnd(raw, THINK_TAGS);
    if (depth === 0) out += raw.slice(0, raw.length - keep);
    raw = raw.slice(raw.length - keep);
    return out;
  };
  // why: judge takes what can no longer be call syntax, and stops for good where a call starts.
  const judge = (): string => {
    let out = "";
    while (!blocked) {
      const call = visible.toLowerCase().indexOf(CALL_OPEN);
      const fence = visible.indexOf(FENCE);
      if (call < 0 && fence < 0) {
        const keep = Math.max(partialEnd(visible, [CALL_OPEN]), /`{1,2}$/.exec(visible)?.[0].length ?? 0);
        out += visible.slice(0, visible.length - keep);
        visible = visible.slice(visible.length - keep);
        break;
      }
      if (call >= 0 && (fence < 0 || call < fence)) { out += visible.slice(0, call); blocked = true; break; }
      const end = visible.indexOf("\n", fence);
      if (end < 0) { out += visible.slice(0, fence); visible = visible.slice(fence); break; }
      const line = visible.slice(fence, end + 1);
      if (CALL_FENCE_OPEN.test(line) || line.toLowerCase().includes(CALL_OPEN)) { out += visible.slice(0, fence); blocked = true; break; }
      out += visible.slice(0, end + 1);
      visible = visible.slice(end + 1);
    }
    if (blocked) visible = "";
    return out;
  };
  return {
    push(text) {
      const seen = outside(text);
      if (blocked) return { visible: seen, shown: "" };
      visible += seen;
      let out = judge();
      if (!started) { out = out.trimStart(); started = out !== ""; }
      const body = out.trimEnd();
      if (!body) { space += out; return { visible: seen, shown: "" }; }
      const shown = space + body;
      space = out.slice(body.length);
      return { visible: seen, shown };
    },
  };
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
  // external: Gemma-style models write their call in a fence instead of the tags.
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

type LooseShape = readonly [nameKey: string, argumentsKey: string];
// external: the last two shapes are what ReAct and LangChain agents write; Gemma 4 wrote `action` (2026-11-11).
const LOOSE_SHAPES = [["name", "arguments"], ["name", "parameters"], ["action", "action_input"], ["tool", "tool_input"]] as const satisfies readonly LooseShape[];
// why: {function: {...}} is accepted around the first shape only.
const WRAPPED_SHAPES = LOOSE_SHAPES.slice(0, 1);
const WHOLE_FENCE = new RegExp(`^${literal(FENCE)}[\\w-]*[ \\t]*${LF_OR_CRLF}([\\s\\S]*?)${literal(FENCE)}$`);
type LooseCall = { name: string; arguments: Record<string, unknown> };
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const parseObject = (text: string): Record<string, unknown> | undefined => {
  try { const parsed: unknown = JSON.parse(text); return isObject(parsed) ? parsed : undefined; } catch { return undefined; }
};

type Property = { type?: string; minimum?: number; minItems?: number; items?: Property };
function fitsProperty(property: Property | undefined, value: unknown): boolean {
  if (property?.type === "string") return typeof value === "string" && value.trim() !== "";
  if (property?.type === "number") return typeof value === "number" && Number.isFinite(value);
  if (property?.type === "integer") return typeof value === "number" && Number.isInteger(value) && value >= (property.minimum ?? -Infinity);
  if (property?.type === "array") return Array.isArray(value) && value.length >= (property.minItems ?? 0) && value.every(item => fitsProperty(property.items, item));
  return false;
}

function fitsDefinition(definition: ToolDefinition, input: Record<string, unknown>): boolean {
  const { properties, required } = definition.function.parameters;
  if (!required.every(key => key in input)) return false;
  return Object.entries(input).every(([key, value]) => fitsProperty(properties[key] as Property | undefined, value));
}

const takesText = (property: Property | undefined) => property?.type === "string" || (property?.type === "array" && property.items?.type === "string");

function callFrom(value: unknown, offered: readonly ToolDefinition[]): LooseCall | undefined {
  if (!isObject(value)) return undefined;
  const keys = Object.keys(value);
  const wrapped = keys.length === 1 && keys[0] === "function";
  const object = wrapped ? value.function : value;
  if (!isObject(object)) return undefined;
  const shape = (wrapped ? WRAPPED_SHAPES : LOOSE_SHAPES).find(([name, args]) => Object.keys(object).length === 2 && name in object && args in object);
  if (!shape || typeof object[shape[0]] !== "string") return undefined;
  let args = object[shape[1]];
  if (typeof args === "string") args = parseObject(args) ?? args;
  const bareString = typeof args === "string" ? args : undefined;
  let call: ToolCall;
  try { call = repairCall({ name: object[shape[0]], arguments: bareString === undefined ? args : {} }); } catch { return undefined; }
  const definition = offered.find(d => d.function.name === call.name);
  if (!definition) return undefined;
  if (bareString !== undefined) {
    const { required, properties } = definition.function.parameters;
    const property = properties[required[0]!] as Property | undefined;
    // why: a bare string is the tool's one required text field (a list of one), or not a call.
    if (required.length !== 1 || !takesText(property)) return undefined;
    call.input = { [required[0]!]: property?.type === "array" ? [bareString] : bareString };
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

/**
 * `push` reads the reply's next piece: whether the reply so far could still be a looseCall. Once
 * false, false for good. `scanned` is the characters read so far; each is read once, so holding
 * costs time linear in the reply.
 */
export interface CallHold {
  push(text: string): boolean;
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
  // why: ticks counts the opening fence's backticks, then starts again for the closing one's.
  let ticks = 0;
  let fenced = false;
  let header: "word" | "space" | "cr" = "word";
  let closingDone = false;
  let objectText = "";
  let depth = 0;
  let inString = false;
  let escaped = false;
  // why: the call's own keys live at depth 1, or at depth 2 inside {"function": {...}}.
  let keyDepth = 1;
  let shapes: readonly LooseShape[] = LOOSE_SHAPES;
  let keys: string[] = [];
  let keyNext = false;
  let valueNext = false;
  let functionWrapClosed = false;
  let capture: "key" | "name" | undefined;
  let captured = "";

  const open = (c: string) => {
    if (c !== "{") return false;
    phase = "object"; objectText = c; depth = 1; keyNext = true;
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
    try { value = JSON.parse(objectText); } catch { return false; }
    phase = "after"; ticks = 0;
    return callFrom(value, offered) !== undefined;
  };
  const inObject = (c: string): boolean => {
    objectText += c;
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
    if (functionWrapClosed) return c === "}" && closed();
    const level = depth === keyDepth;
    if (level && keyNext) {
      // why: a call's object opens with a key, so {}, {\frac and {{ name }} are not calls.
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
        depth = 2; keyDepth = 2; shapes = WRAPPED_SHAPES; keys = []; keyNext = true;
        return true;
      }
    }
    if (c === '"') inString = true;
    else if (c === ":" && level) valueNext = true;
    else if (c === "," && level) { if (keys.length >= 2) return false; keyNext = true; }
    else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") {
      if (--depth === 0) return closed();
      if (keyDepth === 2 && depth === 1) functionWrapClosed = true;
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
  // why: a model that writes one prompt, the image tool's older form, means a list of one.
  if (name === "image") {
    if (input.prompts === undefined && typeof input.prompt === "string") { input.prompts = [input.prompt]; delete input.prompt; }
    else if (typeof input.prompts === "string") input.prompts = [input.prompts];
  }
  return { name, input };
}

function repairName(name: string): string {
  // why: models trained on other harnesses say bash for shell.
  return name === "bash" ? "shell" : name;
}
