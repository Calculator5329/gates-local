// Measure (Settings › Models), version MEASURE_VERSION: how well one model does the app's own work on
// this computer, run only when the person clicks Measure. Each check (cases.ts) is one chat turn
// through the chat's tool turn: the same loop, the same Library tools and sandbox, the window a
// chat with this model gets, and thinking as the chat's setting has it. A tool's result goes back
// to the model, so a check can take several steps. The person's own system prompt is left out, so
// a score says the same thing on every computer; the model's built-in one stays, as in a chat.
//
// Every request is metered. The run has RUN_BUDGET answer tokens in all, what every check's own
// share (BUDGET) adds up to: a check always has its share, and may take up to CEILING times it
// from what the checks before it left. Thinking has its own THINK_BUDGET a check, apart from
// the answer's: a thinking model thinks on every tool round, and that does not shorten its answer.
// A check is cut where its tokens end, and one cut while it was still thinking says so. The
// decode speed is over every check's requests together, and the time to the first word is the
// middle check's. A page check ends here with the page it wrote;
// the window runs it later (score.ts). Nothing here takes the GPU lease or checks the fit: the
// caller does both before it calls measureModel.
import { MEASURE_VERSION, type MeasureCheck, type ModelMeasure, type ShellStatus, type ToolStep } from "@gates-local/contracts";
import { CALL_CLOSE, CALL_OPEN, createTools, type LibraryEntry, type ToolCall, type ToolResult } from "@gates-local/harness";
import { streamToolTurn, windowFullWords, type ToolTurnInput } from "../chat/tools.ts";
import type { TurnMessage } from "../chat/types.ts";
import { BUDGET, CASES, SHOP_ID, pageIn, toolCallOf, type AnswerCase, type MeasureCase, type Turn } from "./cases.ts";
import { partsOf, scoreOf } from "./score.ts";

/** A model this slow writes slower than a person reads: about 250 words a minute is 5.5 tokens a second; twice that. */
export const SLOW_TOKENS_PER_SECOND = 10;
/** Past 10 seconds a person stops waiting on a reply and turns to something else (Nielsen's response-time limits). */
export const SLOW_FIRST_WORD_MS = 10_000;
/** The same seed every run, so a measure repeats. */
export const SEED = 7;
/**
 * How Measure samples, whatever the person saved for chats: the most likely word each time, the
 * same seed, and the model's own defaults for the rest. Two models are measured alike, and the
 * measure keeps these beside its score.
 */
export const SAMPLING = { temperature: 0, seed: SEED } as const;
/** How much of a reply a check keeps: its start and its end. */
const KEPT = 400;
const CALL_KEPT = 300;
const PAGE_KEPT = 30_000;

const clip = (text: string, max: number) => text.length > max ? `${text.slice(0, max)}…` : text;
/** The start and the end of a reply, with what was between them counted. */
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
  /** Measure's own Library sources (ensureFixtures). */
  sources: readonly LibraryEntry[];
  /** The window a chat with this model gets: the default context, capped at the model's own. */
  numCtx: number;
  /** The chat's thinking setting; sent only to a model that can think. */
  think?: boolean;
  /** How long the model stays in memory after a request, as the person set it for chats. */
  keepAlive?: number;
  /** The shell sandbox's probe: off on Linux skips the database checks. */
  shell?: ShellStatus;
  platform?: NodeJS.Platform;
  fetch?: typeof fetch;
  /** Steps finished so far, of total: loading the model, then each check. */
  onStep?: (done: number, total: number) => void;
  now?: () => number;
}

/** Loading the model, then one step per check. */
export const STEPS = CASES.length + 1;

/** Answer tokens for the whole run: every check's own share, added up. */
export const RUN_BUDGET = CASES.reduce((sum, c) => sum + BUDGET[c.part], 0);
/** A check may take up to this many times its own share, so one check cannot eat the run. */
export const CEILING = 2;
/** Thinking tokens one check may use over all its requests, with Thinking on; not counted in its answer's. */
export const THINK_BUDGET = 1500;

/**
 * One check's tokens. `cap`: its answer's; `think`: its thinking's allowance (0 with Thinking
 * off). `used` is every token it wrote, `thought` the ones it thought.
 */
interface Meter { cap: number; think: number; used: number; thought: number; start: number; firstMs?: number; cut: boolean; cutThinking: boolean }
/** Answer tokens a check used: thinking past its allowance counts as answer. */
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
  // As a chat: a model that cannot think gets no flag; a runtime that lists nothing gets it as asked.
  const think = input.think === undefined || (capabilities !== undefined && !capabilities.includes("thinking")) ? undefined : input.think;
  const system = typeof details.system === "string" && details.system.trim() ? details.system : undefined;

  let done = 0;
  const step = () => input.onStep?.(++done, STEPS);
  await warmUp(input, fetcher, think);
  step();

  let evalCount = 0;
  let evalNs = 0;
  const firstWords: number[] = [];
  const checks: MeasureCheck[] = [];
  const runs = (c: MeasureCase) => !(c.db && noDatabase);
  // What the checks still to come are owed: their own shares.
  let owed = CASES.filter(runs).reduce((sum, c) => sum + BUDGET[c.part], 0);
  let runLeft = owed;
  for (const c of CASES) {
    if (!runs(c)) {
      checks.push({ id: c.id, kind: c.part, ok: false, state: "skipped", needs: c.needs, why: "Run commands is off on this machine, so the database can't be read." });
      step();
      continue;
    }
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
    const end = await turnEnd(streamToolTurn({ ...turn, fetch: metered, execute }));
    input.signal.throwIfAborted();
    // The question itself did not fit the window: the app's sentence, and the check is skipped.
    if (end.type === "error" && end.code === "context-too-small") {
      checks.push({ id: c.id, kind: c.part, ok: false, state: "skipped", needs: c.needs, why: end.message });
      step();
      continue;
    }
    // A turn that failed (the runtime crashed or went away, the model did not load, the stream
    // broke) says nothing about the model: the run stops, and nothing it measured is kept.
    if (end.type === "error") throw new Error(`Measure stopped at check ${checks.length + 1} of ${CASES.length}: ${end.message}`);
    const { answer, steps } = end;
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
    checks.push(noTools !== undefined
      ? { id: c.id, kind: c.part, ok: false, state: "skipped", needs: c.needs, why: noTools, ...evidence }
      : grade(c, { answer, steps: steps.filter((s) => s.name !== "note") }, evidence));
    step();
  }

  const tokensPerSecond = evalNs > 0 ? Math.round((evalCount / (evalNs / 1e9)) * 10) / 10 : 0;
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

/** A check a model that gets it right does with the Library's tools. */
const needsTools = (c: MeasureCase): c is AnswerCase => c.kind === "answer" && c.reference.calls.length > 0;

// A check is skipped, not failed, only where the window kept it from being asked: the window is a
// setting, not what the model wrote. The chat's tool turn (chat/tools.ts) says so in two ways,
// read by the two functions below. A turn the model itself brought to its end (calls the tools
// refused, calls up to the turn limit, a window filled with reads the check has no use for) is
// graded like any other, and fails.

/**
 * The tools did not fit beside the question, so the turn answered without them and its only step
 * is a note saying why: that note. (Measure offers no database it cannot read, so the shell's
 * note never comes here.)
 */
function toolsLeftOut(steps: readonly ToolStep[]): string | undefined {
  const note = steps.length > 0 && steps.every((s) => s.name === "note") ? steps.at(-1)?.summary : undefined;
  return note ? `${note}.` : undefined;
}

/**
 * The turn ended on the full window, and so does the check done right: its reference calls and
 * answer (cases.ts), played through the same tool turn with the same tools and no model asked.
 * Then the sentence the turn ended on. A full window the right calls fit in is the model's doing.
 */
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
  const end = await turnEnd(streamToolTurn({ ...turn, fetch: right }));
  return end.type === "done" && endedFull(end.answer) ? full : undefined;
}

/** Why a cut check failed: still thinking when its tokens ran out, or out of answer tokens. */
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

/** The turn's one ending: its answer and steps, or why it failed. */
async function turnEnd(events: ReturnType<typeof streamToolTurn>) {
  for await (const event of events) {
    if (event.type === "done") return { type: "done" as const, answer: event.message.content, steps: event.message.tools ?? [] };
    if (event.type === "error") return { type: "error" as const, code: event.code, message: event.message };
  }
  return { type: "error" as const, code: undefined, message: "The turn ended without an answer." };
}

/** One token at the chat's window and Measure's sampling, so the model is in memory before the first check is timed. */
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

/**
 * The chat requests of one check, each capped at what is left of its answer's tokens and its
 * thinking's, and seeded; the first word's time and each request's counts are read off the stream
 * as it passes. The runtime counts thinking and answer together, so the thinking is counted here:
 * a streamed piece is about a token, and so are four characters of it; the larger of the two,
 * never more than the request wrote. Past the answer's tokens a request is not sent: it ends at
 * once, cut.
 */
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
      const count = v.eval_count ?? 0;
      meter.used += count;
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
