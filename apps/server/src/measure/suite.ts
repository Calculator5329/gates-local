// Measure (Settings › Models, row 29), version 2: how well one model does the app's own work on
// this computer, run only when the person clicks Measure. Each check (cases.ts) is one chat turn
// through the chat's tool turn: the same loop, the same Library tools and sandbox, the window a
// chat with this model gets, and thinking as the chat's setting has it. A tool's result goes back
// to the model, so a check can take several steps. The person's own system prompt is left out, so
// a score says the same thing on every computer; the model's built-in one stays, as in a chat.
//
// Every request is metered: a check may write BUDGET tokens over all its requests, thinking
// included, and is cut there. The decode speed is over every check's requests together, and the
// time to the first word is the middle check's. A page check ends here with the page it wrote;
// the window runs it later (score.ts). Nothing here takes the GPU lease or checks the fit: the
// caller does both before it calls measureModel.
import type { MeasureCheck, ModelMeasure, ShellStatus } from "@gates-local/contracts";
import { createTools, type LibraryEntry, type ToolCall, type ToolResult } from "../../../../packages/harness/src/index.ts";
import { streamToolTurn } from "../chat/tools.ts";
import type { TurnMessage } from "../chat/types.ts";
import type { TurnSettings } from "../settings/turn.ts";
import { BUDGET, CASES, SHOP_ID, pageIn, type MeasureCase, type Turn } from "./cases.ts";
import { partsOf, scoreOf } from "./score.ts";

/** A model this slow writes slower than a person reads: about 250 words a minute is 5.5 tokens a second; twice that. */
export const SLOW_TOKENS_PER_SECOND = 10;
/** Past 10 seconds a person stops waiting on a reply and turns to something else (Nielsen's response-time limits). */
export const SLOW_FIRST_WORD_MS = 10_000;
/** The same seed every run, so a measure repeats; the chat's other sampling settings stay. */
export const SEED = 7;
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
  /** The model's sampling settings, without the person's system prompt. */
  settings?: TurnSettings;
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

interface Meter { budget: number; used: number; start: number; firstMs?: number; cut: boolean }

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
  for (const c of CASES) {
    if (c.db && noDatabase) {
      checks.push({ id: c.id, kind: c.part, ok: false, state: "skipped", needs: c.needs, why: "Run commands is off on this machine, so the database can't be read." });
      step();
      continue;
    }
    const meter: Meter = { budget: BUDGET[c.part], used: 0, start: now(), cut: false };
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
    let answer = "";
    let steps: Turn["steps"] = [];
    let failed: string | undefined;
    const end = await turnEnd(streamToolTurn({
      baseUrl: input.baseUrl, model: input.model, messages, numCtx: input.numCtx, signal: input.signal, fetch: metered,
      sources, execute, ...(input.platform ? { platform: input.platform } : {}), ...(input.shell ? { shell: input.shell } : {}),
      ...(think === undefined ? {} : { think }), ...(input.settings ? { settings: input.settings } : {}),
    }));
    input.signal.throwIfAborted();
    if (end.type === "done") ({ answer, steps } = end);
    else failed = end.message;
    if (meter.firstMs !== undefined) firstWords.push(meter.firstMs);
    checks.push(grade(c, { answer, steps: steps.filter((s) => s.name !== "note") }, failed, {
      ...(answer ? { reply: headTail(answer) } : {}),
      ...(calls.length ? { calls } : {}),
      tokens: meter.used, ms: Math.round(now() - meter.start), ...(meter.cut ? { cut: true } : {}),
    }));
    step();
  }

  const tokensPerSecond = evalNs > 0 ? Math.round((evalCount / (evalNs / 1e9)) * 10) / 10 : 0;
  const firstTokenMs = median(firstWords);
  const slow = tokensPerSecond > 0 && tokensPerSecond < SLOW_TOKENS_PER_SECOND ? "decode" as const
    : firstTokenMs !== undefined && firstTokenMs > SLOW_FIRST_WORD_MS ? "first-token" as const : undefined;
  const parts = partsOf(checks);
  return {
    at: now(), version: 2, numCtx: input.numCtx, ...(think === undefined ? {} : { think }), tokensPerSecond,
    ...(firstTokenMs === undefined ? {} : { firstTokenMs: Math.round(firstTokenMs) }), ...(slow ? { slow } : {}),
    score: scoreOf(parts), parts, checks,
  };
}

type Evidence = Pick<MeasureCheck, "reply" | "calls" | "tokens" | "ms" | "cut">;

function grade(c: MeasureCase, turn: Turn, failed: string | undefined, evidence: Evidence): MeasureCheck {
  const base = { id: c.id, kind: c.part, needs: c.needs, ...evidence };
  if (failed !== undefined) return { ...base, ok: false, why: `The turn failed: ${failed}` };
  if (c.kind === "answer") {
    const wrong = turn.answer.trim() || evidence.cut ? c.grade(turn) : "It gave no answer.";
    const why = wrong && evidence.cut ? "It used its whole token budget before it answered." : wrong;
    return { ...base, ok: why === undefined, ...(why ? { why } : {}) };
  }
  const page = pageIn(turn.answer);
  if (page === undefined) return { ...base, ok: false, why: evidence.cut ? "It used its whole token budget before the page was written." : "The reply had no HTML page." };
  return { ...base, ok: false, state: "pending", page: clip(page, PAGE_KEPT), script: [...c.script] };
}

/** The turn's one ending: its answer and steps, or why it failed. */
async function turnEnd(events: ReturnType<typeof streamToolTurn>) {
  for await (const event of events) {
    if (event.type === "done") return { type: "done" as const, answer: event.message.content, steps: event.message.tools ?? [] };
    if (event.type === "error") return { type: "error" as const, message: event.message };
  }
  return { type: "error" as const, message: "The turn ended without an answer." };
}

/** One token at the chat's window and settings, so the model is in memory before the first check is timed. */
async function warmUp(input: MeasureInput, fetcher: typeof fetch, think: boolean | undefined) {
  const { systemPrompt: _prompt, keep_alive, ...options } = input.settings ?? {};
  const response = await fetcher(new URL("/api/chat", input.baseUrl), {
    method: "POST", headers: { "content-type": "application/json" }, signal: input.signal,
    body: JSON.stringify({
      model: input.model, messages: [{ role: "user", content: "Hi" }], stream: true,
      options: { ...options, num_ctx: input.numCtx, num_predict: 1, seed: SEED },
      ...(keep_alive === undefined ? {} : { keep_alive }), ...(think === undefined ? {} : { think: false }),
    }),
  });
  if (!response.ok) throw new Error(`The model did not load (HTTP ${response.status}): ${(await response.text()).slice(0, 300)}`);
  await response.text();
}

/**
 * The chat requests of one check, each capped at what is left of its budget and seeded; the first
 * word's time and each request's counts are read off the stream as it passes. Past the budget a
 * request is not sent: it ends at once, cut.
 */
function meterFetch(base: typeof fetch, meter: Meter, now: () => number, counted: (tokens: number, ns: number) => void): typeof fetch {
  return async (url, init) => {
    if (!String(url).endsWith("/api/chat") || typeof init?.body !== "string") return base(url, init);
    const left = meter.budget - meter.used;
    if (left <= 0) {
      meter.cut = true;
      return new Response(`${JSON.stringify({ message: { role: "assistant", content: "" }, done: true, done_reason: "length", eval_count: 0 })}\n`);
    }
    const body = JSON.parse(init.body) as { options?: Record<string, unknown> };
    body.options = { ...body.options, num_predict: left, seed: SEED };
    const response = await base(url, { ...init, body: JSON.stringify(body) });
    if (!response.ok || !response.body) return response;
    const decoder = new TextDecoder();
    let buffer = "";
    const watch = (line: string) => {
      if (!line.trim()) return;
      let v: { done?: boolean; done_reason?: string; eval_count?: number; eval_duration?: number; message?: { content?: string; thinking?: string; tool_calls?: unknown[] } };
      try { v = JSON.parse(line); } catch { return; }
      if (meter.firstMs === undefined && (v.message?.content || v.message?.thinking || v.message?.tool_calls?.length)) meter.firstMs = now() - meter.start;
      if (!v.done) return;
      const count = v.eval_count ?? 0;
      meter.used += count;
      counted(count, v.eval_duration ?? 0);
      if (v.done_reason === "length") meter.cut = true;
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
