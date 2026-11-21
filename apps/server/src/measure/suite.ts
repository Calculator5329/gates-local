import { MEASURE_VERSION, type MeasureCheck, type MeasureTurn, type ModelMeasure, type ShellStatus, type ToolStep } from "@gates-local/contracts";
import { CALL_CLOSE, CALL_OPEN, createTools, type LibraryEntry, type ToolCall, type ToolResult } from "@gates-local/harness";
import { streamToolTurn, windowFullWords, type ToolTurnInput } from "../chat/tools.ts";
import type { TurnMessage } from "../chat/types.ts";
import { BUDGET, CASES, SHOP_ID, pageIn, toolCallOf, type AnswerCase, type MeasureCase, type Turn } from "./cases.ts";
import { partsOf, scoreOf } from "./score.ts";
import { turnOf } from "./chat.ts";

// why: slower than a person reads; 250 words a minute is 5.5 tokens a second, and this is twice it.
export const SLOW_TOKENS_PER_SECOND = 10;
// why: past 10 seconds a person stops waiting on a reply (Nielsen's response-time limits).
export const SLOW_FIRST_WORD_MS = 10_000;
export const SEED = 7;
export const SAMPLING = { temperature: 0, seed: SEED } as const;
const KEPT = 400;
const CALL_KEPT = 300;
const PAGE_KEPT = 30_000;

const clip = (text: string, max: number) => text.length > max ? `${text.slice(0, max)}…` : text;
export const headTail = (text: string) => text.length <= 2 * KEPT ? text
  : `${text.slice(0, KEPT)}\n… ${text.length - 2 * KEPT} characters …\n${text.slice(-KEPT)}`;
const median = (xs: readonly number[]) => {
  const s = xs.toSorted((a, b) => a - b);
  return s.length === 0 ? undefined : s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};

export interface MeasureInput {
  baseUrl: string;
  model: string;
  signal: AbortSignal;
  sources: readonly LibraryEntry[];
  numCtx: number;
  think?: boolean;
  keepAlive?: number;
  shell?: ShellStatus;
  platform?: NodeJS.Platform;
  fetch?: typeof fetch;
  onStep?: (done: number, total: number, tokensPerSecond: number) => void;
  // why: called on every streamed piece from inside the turn loop, so it must never wait
  onTurn?: (index: number, turn: MeasureTurn) => void;
  now?: () => number;
}

// why: the strip's speed while running and the score's are one sum of the runtime's own counts
export const speedOf = (evalCount: number, evalNs: number): number => (evalNs > 0 ? Math.round((evalCount / (evalNs / 1e9)) * 10) / 10 : 0);

type TurnEvent = ReturnType<typeof streamToolTurn> extends AsyncIterable<infer E> ? E : never;

function turnWith(turn: MeasureTurn, event: TurnEvent): MeasureTurn {
  if (event.type === "delta") return { ...turn, answer: turn.answer + event.text };
  if (event.type === "thinking") return { ...turn, thinking: turn.thinking + event.text };
  if (event.type !== "tool") return turn;
  const at = turn.steps.findIndex((s) => s.callId === event.step.callId);
  return { ...turn, steps: at < 0 ? [...turn.steps, event.step] : turn.steps.with(at, event.step) };
}

// why: one step for loading the model, then one per check.
export const STEPS = CASES.length + 1;

export const RUN_BUDGET = CASES.reduce((sum, c) => sum + BUDGET[c.part], 0);
// why: a check may take this many times its own share, so one check cannot eat the run.
export const CEILING = 2;
export const THINK_BUDGET = 1500;

interface Meter { cap: number; think: number; used: number; thought: number; start: number; firstMs?: number; cut: boolean; cutThinking: boolean }
const answered = (m: Meter) => m.used - Math.min(m.thought, m.think);

export async function measureModel(input: MeasureInput): Promise<Omit<ModelMeasure, "model" | "digest">> {
  const fetcher = input.fetch ?? fetch;
  const now = input.now ?? Date.now;
  const windows = (input.platform ?? process.platform) === "win32";
  const noDatabase = !windows && input.shell?.state === "off";
  const sources = noDatabase ? input.sources.filter((s) => s.id !== SHOP_ID) : input.sources;

  const show = await fetcher(new URL("/api/show", input.baseUrl), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: input.model }), signal: input.signal });
  if (!show.ok) throw new Error(`The model's details could not be read (HTTP ${show.status})`);
  const details = (await show.json()) as { capabilities?: unknown; system?: unknown };
  const capabilities = Array.isArray(details.capabilities) ? details.capabilities : undefined;
  const think = input.think === undefined || (capabilities !== undefined && !capabilities.includes("thinking")) ? undefined : input.think;
  const system = typeof details.system === "string" && details.system.trim() ? details.system : undefined;

  let done = 0;
  let evalCount = 0;
  let evalNs = 0;
  const step = () => input.onStep?.(++done, STEPS, speedOf(evalCount, evalNs));
  await warmUp(input, fetcher, think);
  step();

  const firstWords: number[] = [];
  const checks: MeasureCheck[] = [];
  const runs = (c: MeasureCase) => !(c.db && noDatabase);
  let owed = CASES.filter(runs).reduce((sum, c) => sum + BUDGET[c.part], 0);
  let runLeft = owed;
  for (const [index, c] of CASES.entries()) {
    let live = turnOf(c);
    const graded = (check: MeasureCheck) => {
      checks.push(check);
      input.onTurn?.(index, { ...live, check });
      step();
    };
    if (!runs(c)) {
      graded({ id: c.id, kind: c.part, ok: false, state: "skipped", needs: c.needs, why: "Run commands is off on this machine, so the database can't be read." });
      continue;
    }
    input.onTurn?.(index, live);
    owed -= BUDGET[c.part];
    const cap = Math.max(0, Math.min(CEILING * BUDGET[c.part], runLeft - owed));
    const meter: Meter = { cap, think: think === true ? THINK_BUDGET : 0, used: 0, thought: 0, start: now(), cut: false, cutThinking: false };
    const metered = meterFetch(fetcher, meter, now, (count, ns) => { evalCount += count; evalNs += ns; });
    const calls: string[] = [];
    const tools = createTools({ sources, platform: input.platform, ...(noDatabase ? { shell: false } : {}) });
    const execute = async (call: ToolCall, signal: AbortSignal): Promise<ToolResult> => {
      const named = `${call.name} ${clip(JSON.stringify(call.input), CALL_KEPT)}`;
      try {
        const result = await tools.execute(call, signal);
        calls.push(`${named} → ${clip(result.output, CALL_KEPT)}`);
        return result;
      } catch (e) {
        calls.push(`${named} → ${clip((e as Error).message, CALL_KEPT)}`);
        throw e;
      }
    };
    const messages: TurnMessage[] = [...(system ? [{ role: "system" as const, content: system }] : []), ...c.history ?? [], { role: "user", content: c.prompt }];
    const turn: ToolTurnInput = {
      baseUrl: input.baseUrl, model: input.model, messages, numCtx: input.numCtx, signal: input.signal,
      sources, ...(input.platform ? { platform: input.platform } : {}), ...(input.shell ? { shell: input.shell } : {}),
      ...(think === undefined ? {} : { think }), settings: { temperature: SAMPLING.temperature, ...(input.keepAlive === undefined ? {} : { keep_alive: input.keepAlive }) },
    };
    const onTurn = input.onTurn;
    const watch = onTurn === undefined ? undefined : (event: TurnEvent) => {
      live = turnWith(live, event);
      onTurn(index, live);
    };
    const end = await turnEnd(streamToolTurn({ ...turn, fetch: metered, execute }), watch);
    input.signal.throwIfAborted();
    if (end.type === "error" && end.code === "context-too-small") {
      graded({ id: c.id, kind: c.part, ok: false, state: "skipped", needs: c.needs, why: end.message });
      continue;
    }
    // why: a turn that failed on the runtime says nothing about the model, so the run stops.
    if (end.type === "error") throw new Error(`Measure stopped at check ${checks.length + 1} of ${CASES.length}: ${end.message}`);
    const { answer, steps } = end;
    live = { ...live, answer, steps };
    if (meter.firstMs !== undefined) firstWords.push(meter.firstMs);
    runLeft -= answered(meter);
    const evidence: Evidence = {
      ...(answer ? { reply: headTail(answer) } : {}),
      ...(calls.length ? { calls } : {}),
      tokens: meter.used, ...(meter.thought > 0 ? { thinkTokens: meter.thought } : {}), ms: Math.round(now() - meter.start),
      ...(meter.cut ? { cut: true } : {}), ...(meter.cut && meter.cutThinking ? { cutThinking: true } : {}),
    };
    const noTools = needsTools(c) ? toolsLeftOut(steps) ?? await windowTooSmall(c, answer, turn, details, windows) : undefined;
    input.signal.throwIfAborted();
    graded(noTools !== undefined
      ? { id: c.id, kind: c.part, ok: false, state: "skipped", needs: c.needs, why: noTools, ...evidence }
      : grade(c, { answer, steps: steps.filter((s) => s.name !== "note") }, evidence));
  }

  const tokensPerSecond = speedOf(evalCount, evalNs);
  const firstTokenMs = median(firstWords);
  const slow = tokensPerSecond > 0 && tokensPerSecond < SLOW_TOKENS_PER_SECOND ? "decode" as const
    : firstTokenMs !== undefined && firstTokenMs > SLOW_FIRST_WORD_MS ? "first-token" as const : undefined;
  const parts = partsOf(checks);
  return {
    at: now(), version: MEASURE_VERSION, numCtx: input.numCtx, ...(think === undefined ? {} : { think }), sampling: SAMPLING, tokensPerSecond,
    ...(firstTokenMs === undefined ? {} : { firstTokenMs: Math.round(firstTokenMs) }), ...(slow ? { slow } : {}),
    score: scoreOf(parts), parts, checks,
  };
}

type Evidence = Pick<MeasureCheck, "reply" | "calls" | "tokens" | "thinkTokens" | "ms" | "cut" | "cutThinking">;

const needsTools = (c: MeasureCase): c is AnswerCase => c.kind === "answer" && c.reference.calls.length > 0;

function toolsLeftOut(steps: readonly ToolStep[]): string | undefined {
  const note = steps.length > 0 && steps.every((s) => s.name === "note") ? steps.at(-1)?.summary : undefined;
  return note ? `${note}.` : undefined;
}

async function windowTooSmall(c: AnswerCase, answer: string, turn: ToolTurnInput, show: { capabilities?: unknown }, windows: boolean): Promise<string | undefined> {
  const full = windowFullWords(turn.numCtx);
  const endedFull = (said: string) => (said.trim().split(/\n\n/).at(-1) ?? "").startsWith(full);
  if (!endedFull(answer)) return undefined;
  const native = Array.isArray(show.capabilities) && show.capabilities.includes("tools");
  let round = 0;
  const right = (async (url: URL | string) => {
    if (!String(url).endsWith("/api/chat")) return Response.json(show);
    const call = c.reference.calls[round++];
    const fn = call === undefined ? undefined : toolCallOf(call, windows);
    const message = fn === undefined ? { content: c.reference.answer }
      : native ? { content: "", tool_calls: [{ function: fn }] } : { content: `${CALL_OPEN}${JSON.stringify(fn)}${CALL_CLOSE}` };
    return new Response(`${JSON.stringify({ message: { role: "assistant", ...message }, done: false })}\n${JSON.stringify({ message: { role: "assistant", content: "" }, done: true, done_reason: "stop" })}\n`);
  }) as typeof fetch;
  // why: if the right calls fit the window, a full one was the model's doing, not the setting's.
  const end = await turnEnd(streamToolTurn({ ...turn, fetch: right }));
  return end.type === "done" && endedFull(end.answer) ? full : undefined;
}

export const CUT_THINKING = "It was still thinking when its tokens ran out.";
const CUT_ANSWER = "It used its whole token budget before it answered.";

function grade(c: MeasureCase, turn: Turn, evidence: Evidence): MeasureCheck {
  const base = { id: c.id, kind: c.part, needs: c.needs, ...evidence };
  const cutWhy = evidence.cutThinking ? CUT_THINKING : CUT_ANSWER;
  if (c.kind === "answer") {
    const wrong = turn.answer.trim() || evidence.cut ? c.grade(turn) : "It gave no answer.";
    const why = wrong && evidence.cut ? cutWhy : wrong;
    return { ...base, ok: why === undefined, ...(why ? { why } : {}) };
  }
  const page = pageIn(turn.answer);
  if (page === undefined) return { ...base, ok: false, why: evidence.cut ? (evidence.cutThinking ? CUT_THINKING : "It used its whole token budget before the page was written.") : "The reply had no HTML page." };
  return { ...base, ok: false, state: "pending", page: clip(page, PAGE_KEPT), script: [...c.script] };
}

async function turnEnd(events: ReturnType<typeof streamToolTurn>, watch?: (event: TurnEvent) => void) {
  for await (const event of events) {
    watch?.(event);
    if (event.type === "done") return { type: "done" as const, answer: event.message.content, steps: event.message.tools ?? [] };
    if (event.type === "error") return { type: "error" as const, code: event.code, message: event.message };
  }
  return { type: "error" as const, code: undefined, message: "The turn ended without an answer." };
}

// why: one token, so the model is in memory before the first check is timed.
async function warmUp(input: MeasureInput, fetcher: typeof fetch, think: boolean | undefined) {
  const response = await fetcher(new URL("/api/chat", input.baseUrl), {
    method: "POST", headers: { "content-type": "application/json" }, signal: input.signal,
    body: JSON.stringify({
      model: input.model, messages: [{ role: "user", content: "Hi" }], stream: true,
      options: { ...SAMPLING, num_ctx: input.numCtx, num_predict: 1 },
      ...(input.keepAlive === undefined ? {} : { keep_alive: input.keepAlive }), ...(think === undefined ? {} : { think: false }),
    }),
  });
  if (!response.ok) throw new Error(`The model did not load (HTTP ${response.status}): ${(await response.text()).slice(0, 300)}`);
  await response.text();
}

function meterFetch(base: typeof fetch, meter: Meter, now: () => number, counted: (tokens: number, ns: number) => void): typeof fetch {
  return async (url, init) => {
    if (!String(url).endsWith("/api/chat") || typeof init?.body !== "string") return base(url, init);
    const answerLeft = meter.cap - answered(meter);
    const thinkLeft = Math.max(0, meter.think - meter.thought);
    if (answerLeft <= 0) {
      meter.cut = true;
      return new Response(`${JSON.stringify({ message: { role: "assistant", content: "" }, done: true, done_reason: "length", eval_count: 0 })}\n`);
    }
    const body = JSON.parse(init.body) as { options?: Record<string, unknown> };
    body.options = { ...body.options, ...SAMPLING, num_predict: answerLeft + thinkLeft };
    const response = await base(url, { ...init, body: JSON.stringify(body) });
    if (!response.ok || !response.body) return response;
    const decoder = new TextDecoder();
    let buffer = "";
    let pieces = 0;
    let chars = 0;
    let thinkingLast = false;
    const watch = (line: string) => {
      if (!line.trim()) return;
      let v: { done?: boolean; done_reason?: string; eval_count?: number; eval_duration?: number; message?: { content?: string; thinking?: string; tool_calls?: unknown[] } };
      try { v = JSON.parse(line); } catch { return; }
      if (meter.firstMs === undefined && (v.message?.content || v.message?.thinking || v.message?.tool_calls?.length)) meter.firstMs = now() - meter.start;
      if (v.message?.thinking) {
        pieces += 1;
        chars += v.message.thinking.length;
        thinkingLast = true;
      }
      if (v.message?.content || v.message?.tool_calls?.length) thinkingLast = false;
      if (!v.done) return;
      // external: Ollama's eval_count is the thinking and the answer together.
      const count = v.eval_count ?? 0;
      meter.used += count;
      // why: a streamed piece is about a token, and so are four characters of it; the larger of the two.
      meter.thought += Math.min(count, Math.max(pieces, Math.ceil(chars / 4)));
      counted(count, v.eval_duration ?? 0);
      if (v.done_reason === "length") {
        meter.cut = true;
        meter.cutThinking = thinkingLast;
      }
    };
    const stream = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, out) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        lines.forEach(watch);
        out.enqueue(chunk);
      },
      flush() { watch(buffer); },
    }));
    return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}
