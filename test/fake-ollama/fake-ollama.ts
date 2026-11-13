// A fake Ollama HTTP server for the E2E suite and unit tests. It speaks the
// part of the Ollama API the app uses, deterministically, and never touches a
// GPU. Start it in-process with startFakeOllama(), or as a process with
// `node test/fake-ollama/main.ts --port <n>`.
//
// POST /__fake/scenario {"scenario": "...", ...options} switches behaviour:
//   models            three installed models (the default)
//   no-models         nothing installed; /api/pull can add one
//   slow-first-token  the first token waits firstTokenDelayMs (default 2500)
//   mid-stream-error  the stream breaks with an error after a few tokens
//   wrong-service     the port answers, but not as Ollama
//   embed-smallest    the three models plus nomic-embed-text, the smallest
//   embed-only        only nomic-embed-text: nothing can chat; /api/pull can add one
//   slow-drip         every reply is DRIP_REPLY (paragraphs, a heading, a list,
//                     a code block, a table) over about 2 s; holdAfterTokens > 0
//                     pauses until /__fake/release or cancellation
//                     (holdThinkingAfterTokens pauses any thinking model the
//                     same way, inside its thinking)
//   long-name         the three models plus a long Hugging Face GGUF tag
//   threads           prompt-labelled paragraphs with independent request timing
//   image-text-call   streams IMAGE_TEXT_CALL, an image call written as reply text, with no tool_calls
//   image-batch       "N images of X": one image call with N distinct prompts when the tool is
//                     offered; without it, the reply says what the system prompt's image line says
// A prompt with the word "tool" makes any scenario call the first offered tool
// once (repeatToolCalls: every round; toolCalls: N, the first N rounds);
// quietToolRounds ends such a round at the call, with no reply text.
// An "installed": [names] option replaces the scenario's installed set (names
// from models.ts; no-models stays empty).
// GET /__fake/state returns installed and loaded models and the request log.
// POST /__fake/gpu {"otherMib": n} puts another program's n MiB on the fake GPU.
import { writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { DEFAULT_INSTALLED, EMBED_ONLY_INSTALLED, EMBED_SMALLEST_INSTALLED, FAKE_MODELS, LONG_NAME_INSTALLED, findFakeModel, showBody, type FakeModel } from "./models.ts";
import { createScheduler } from "./scheduler.ts";
import { STREAM_REPLY } from "./stream-reply.ts";

const SCENARIO_INSTALLED: Readonly<Record<string, readonly string[]>> = {
  "no-models": [],
  "embed-smallest": EMBED_SMALLEST_INSTALLED,
  "embed-only": EMBED_ONLY_INSTALLED,
  "long-name": LONG_NAME_INSTALLED,
};
const installedFor = (s: string): readonly string[] => SCENARIO_INSTALLED[s] ?? DEFAULT_INSTALLED;

export const SCENARIOS = ["models", "no-models", "slow-first-token", "mid-stream-error", "wrong-service", "embed-smallest", "embed-only", "slow-drip", "long-name", "threads", "image-turn", "image-claims", "image-text-call", "image-batch"] as const;
export type Scenario = (typeof SCENARIOS)[number];
/** A Gemma 4 12B reply seen 2026-11-11: it wrote its image call as text in a shape of its own. */
const IMAGE_TEXT_CALL_PROMPT ="A cinematic sci-fi background featuring a massive, high-tech space station orbiting a ringed planet within a vibrant, colorful nebula. The scene includes distant stars, glowing energy fields, and intricate hull details on the station. High-resolution, 8k, photorealistic, epic scale, and dramatic lighting.";
export const IMAGE_TEXT_CALL = `{ "action": "image", "action_input": "${IMAGE_TEXT_CALL_PROMPT}" }`;

export interface FakeOptions {
  /** Delay between streamed tokens. */
  tokenDelayMs: number;
  /** Delay before the first token (thinking or content). */
  firstTokenDelayMs: number;
  /** Bytes added per pull tick, and the tick interval. */
  pullChunkBytes: number;
  pullTickMs: number;
  /** Words in a reply; the text is deterministic for a given prompt. */
  replyWords: number;
  /** Tokens before a mid-stream error. */
  errorAfterTokens: number;
  /** threads: when nonzero, only the first this-many replies to a prompt break at errorAfterTokens; later ones finish. */
  errorReplies: number;
  /** slow-drip/threads: pause after this many tokens until released or cancelled; 0 never pauses. */
  holdAfterTokens: number;
  /** Any scenario that thinks: pause after this many thinking tokens until released or cancelled; 0 never pauses. */
  holdThinkingAfterTokens: number;
  /** The thinking text this many times over, for a thought taller than the view. */
  thinkingRepeat: number;
  /** Keep asking for a native tool after receiving its result, to exercise the tool-turn limit. */
  repeatToolCalls: number;
  /** When nonzero: call a tool in each of the first this-many rounds of a reply, then answer. */
  toolCalls: number;
  /** A round that calls a tool ends at the call, with no reply text, as a real model's tool round usually does. */
  quietToolRounds: number;
  /** slow-drip: use the long mixed-Markdown measurement fixture when nonzero. */
  longDrip: number;
  /** Number of reply tokens delivered together; tokenDelayMs is then the gap between bursts. */
  burstTokens: number;
  /**
   * A cold load (preload or chat) takes this long; 0 is instant. While it runs the
   * model's memory fills the fake GPU in LOAD_STEPS steps and /api/ps leaves it out,
   * as a real runner does until it is ready.
   */
  loadDelayMs: number;
  /** Delay before /api/show answers: holds the server's fit survey (and so its chat pick). */
  showDelayMs: number;
  /** Concurrent requests per runner at the same context. */
  parallelLimit: number;
  /** Idle runners are evicted to make room; active runners must finish first. */
  capacityBytes: number;
  /**
   * 0 puts every loaded model wholly on the GPU. Above 0, a loaded model holds at
   * most this much GPU memory and the rest sits in system memory: /api/ps then
   * answers size_vram = the GPU part and size = the GPU part plus 256 MiB, as a
   * real runtime did for a model whose CPU-side weights are mapped from disk.
   */
  vramCapBytes: number;
}

const LOAD_STEPS = 6;

const DEFAULTS: FakeOptions = {
  tokenDelayMs: 12,
  firstTokenDelayMs: 60,
  pullChunkBytes: 256 * 1024 * 1024,
  pullTickMs: 100,
  replyWords: 60,
  errorAfterTokens: 8,
  errorReplies: 0,
  holdAfterTokens: 0,
  holdThinkingAfterTokens: 0,
  thinkingRepeat: 1,
  repeatToolCalls: 0,
  toolCalls: 0,
  quietToolRounds: 0,
  longDrip: 0,
  burstTokens: 0,
  loadDelayMs: 0,
  showDelayMs: 0,
  parallelLimit: 1,
  capacityBytes: 12 * 1024 ** 3,
  vramCapBytes: 0,
};

/** The slow-drip reply: one of each block kind the reply renderer draws. */
export const DRIP_REPLY = [
  "Here is how to check the free disk space before you download a model. It takes a minute.",
  "",
  "## Steps",
  "",
  "- Open a terminal window.",
  "- Run the two commands below.",
  "- Compare the free space with the model size.",
  "",
  "```sh",
  "df -h /",
  "du -sh ~/.ollama/models",
  "```",
  "",
  "| Model | Download |",
  "| --- | --- |",
  "| Gemma 4 12B | 8.1 GB |",
  "| Qwen 3.5 9B | 6.6 GB |",
  "",
  "A model fits when the free space is larger than its download. Keep some room for the context cache.",
].join("\n");

/** The reply as stream tokens: each word with the whitespace before it, so newlines arrive with the next word. */
export const dripTokens = (): string[] => DRIP_REPLY.match(/\s*\S+/g) ?? [];

export const FAKE_VERSION = "0.40.4";

export interface LoadedEntry {
  readonly name: string;
  readonly numCtx: number;
  readonly sizeBytes: number;
}

export interface FakeRequest {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

export interface FakeTurn {
  readonly id: number;
  readonly model: string;
  readonly numCtx: number;
  readonly prompt: string;
  readonly receivedAt: number;
  startedAt?: number;
  firstTokenAt?: number;
  endedAt?: number;
  outcome?: "done" | "cancelled" | "error";
  tokens: number;
}

export interface FakeLoad {
  readonly model: string;
  readonly numCtx: number;
  readonly startedAt: number;
  endedAt?: number;
  cancelled?: boolean;
}

/** Scenario options: the timing knobs, plus the installed models when a test picks them. */
export type ScenarioOptions = Partial<FakeOptions> & { installed?: readonly string[]; prompts?: Record<string, Partial<FakeOptions>> };

export interface FakeOllama {
  readonly url: string;
  readonly port: number;
  setScenario(scenario: Scenario, options?: ScenarioOptions): void;
  state(): { scenario: Scenario; options: FakeOptions; installed: string[]; loaded: LoadedEntry[]; requests: FakeRequest[]; turns: FakeTurn[]; loads: FakeLoad[] };
  close(): Promise<void>;
}

export interface StartOptions {
  port?: number;
  scenario?: Scenario;
  options?: Partial<FakeOptions>;
  /** When set, the GPU state (loaded models) is written here for the fake nvidia-smi. */
  gpuStateFile?: string;
}

const LOREM =
  "Here is a plain answer . The fake model keeps every reply deterministic , so tests can check what arrives . It streams one word at a time with a short pause between words . A real model would say something useful here . This sentence pads the reply so streaming takes a little while . The end comes soon after this .".split(
    " ",
  );
const THINKING = "The question is short . Answer it plainly , in two or three sentences , without a tool .".split(" ");

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    let text = "";
    req.setEncoding("utf8");
    req.on("data", (c: string) => (text += c));
    req.on("end", () => {
      if (text === "") return resolve(undefined);
      try {
        resolve(JSON.parse(text));
      } catch {
        resolve(text);
      }
    });
  });
}

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}

function field(body: unknown, key: string): unknown {
  return typeof body === "object" && body !== null ? (body as Record<string, unknown>)[key] : undefined;
}

function str(body: unknown, key: string): string | undefined {
  const v = field(body, key);
  return typeof v === "string" ? v : undefined;
}

/** Words of the reply: the prompt's first words, then filler, joined to replyWords. */
export function replyWords(prompt: string, count: number): string[] {
  const head = ["You", "asked:", ...prompt.split(/\s+/).filter(Boolean).slice(0, 8), "."];
  const words = [...head];
  for (let i = 0; words.length < count; i++) words.push(LOREM[i % LOREM.length] ?? ".");
  return words.slice(0, Math.max(count, head.length));
}

/** Multiple blocks make partial progress visible without waiting for completion. */
export function threadReply(prompt: string): string {
  return Array.from({ length: 8 }, (_, i) => `Reply ${i + 1} for ${prompt}. These words belong to this request.`).join("\n\n");
}

/** Joins words the way the stream sends them: a space before each word except punctuation. */
function tokens(words: readonly string[]): string[] {
  return words.map((w, i) => (i === 0 || /^[.,]$/.test(w) ? w : ` ${w}`));
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });

const tagEntry = (m: FakeModel) => ({
  name: m.name,
  model: m.name,
  modified_at: "2026-11-01T12:00:00Z",
  size: m.sizeBytes,
  digest: m.digest,
  details: { format: "gguf", family: m.family, families: [m.family], parameter_size: m.parameterSize, quantization_level: m.quantization },
});

const entryFor = (m: FakeModel, numCtx: number): LoadedEntry => {
  const kv = m.blockCount * m.headCountKv * m.keyLength * 2 * 2 * numCtx;
  return { name: m.name, numCtx, sizeBytes: m.sizeBytes + kv };
};

export async function startFakeOllama(start: StartOptions = {}): Promise<FakeOllama> {
  let scenario: Scenario = start.scenario ?? "models";
  let options: FakeOptions = { ...DEFAULTS, ...start.options };
  let installed = new Set<string>(installedFor(scenario));
  let loaded: LoadedEntry[] = [];
  /** Loads still filling memory: on the GPU, not yet in /api/ps. */
  let filling: LoadedEntry[] = [];
  const requests: FakeRequest[] = [];
  const turns: FakeTurn[] = [];
  const loads: FakeLoad[] = [];
  let promptOptions: Record<string, Partial<FakeOptions>> = {};
  const releases = new Map<number, () => void>();
  const released = new Set<number>();
  const thinkHolds = new Map<number, () => void>();
  const scheduler = createScheduler(() => [...loaded, ...filling], (names) => {
    loaded = loaded.filter((l) => !names.includes(l.name));
    writeGpu();
  });

  /** Another program's GPU memory and the card's size (0: nvidia-smi.ts's own), set by POST /__fake/gpu: moves the GPU reading without touching the runtime. */
  let otherMib = 0, totalMib = 0;
  /** No NVIDIA GPU at all (POST /__fake/gpu {none: true}): the fake nvidia-smi finds no devices. */
  let absent = false;
  const onGpu = (l: LoadedEntry): number => (options.vramCapBytes > 0 ? Math.min(l.sizeBytes, options.vramCapBytes) : l.sizeBytes);
  const writeGpu = () => {
    if (!start.gpuStateFile) return;
    writeFileSync(start.gpuStateFile, JSON.stringify({ loaded: [...loaded, ...filling].map((l) => ({ ...l, sizeBytes: onGpu(l) })), otherMib, ...totalMib > 0 ? { totalMib } : {}, ...absent ? { absent } : {} }));
  };
  writeGpu();

  const setScenario = (next: Scenario, opts: ScenarioOptions = {}) => {
    const { installed: names, prompts = {}, ...timing } = opts;
    promptOptions = prompts;
    scenario = next;
    const preset = next === "slow-first-token" ? { firstTokenDelayMs: 2500 } : next === "slow-drip" ? { tokenDelayMs: 20 } : next === "threads" ? { errorAfterTokens: -1 } : {};
    options = { ...DEFAULTS, ...start.options, ...preset, ...timing };
    installed = new Set(next === "no-models" ? [] : (names?.map((n) => findFakeModel(n)?.name ?? n) ?? installedFor(next)));
    loaded = [];
    filling = [];
    requests.length = 0;
    turns.length = 0;
    loads.length = 0;
    released.clear();
    otherMib = 0; totalMib = 0; absent = false;
    writeGpu();
  };
  if (scenario === "slow-first-token" || scenario === "slow-drip" || scenario === "threads") setScenario(scenario, start.options);

  const isInstalled = (name: string): FakeModel | undefined => {
    const m = findFakeModel(name);
    return m && installed.has(m.name) ? m : undefined;
  };

  const load = async (m: FakeModel, numCtx: number, signal: AbortSignal, timing: FakeOptions) => {
    const entry = entryFor(m, numCtx);
    const warm = loaded.some((l) => l.name === m.name && l.numCtx === numCtx);
    const record: FakeLoad | undefined = warm ? undefined : { model: m.name, numCtx, startedAt: Date.now() };
    if (record) loads.push(record);
    if (!warm && timing.loadDelayMs > 0) {
      // the old copy goes first, then the new one fills memory a step at a time
      loaded = loaded.filter((l) => l.name !== m.name);
      for (let i = 1; i <= LOAD_STEPS && !signal.aborted; i++) {
        filling = [...filling.filter((l) => l.name !== m.name), { ...entry, sizeBytes: Math.round((entry.sizeBytes * i) / LOAD_STEPS) }];
        writeGpu();
        await sleep(timing.loadDelayMs / LOAD_STEPS, signal);
      }
      filling = filling.filter((l) => l.name !== m.name);
    }
    if (record) { record.endedAt = Date.now(); record.cancelled = signal.aborted; }
    if (signal.aborted) { writeGpu(); return; }
    loaded = [...loaded.filter((l) => l.name !== m.name), entry];
    writeGpu();
  };

  async function chat(body: unknown, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const name = str(body, "model") ?? "";
    const m = isInstalled(name);
    if (!m) return json(res, 404, { error: `model '${name}' not found` });
    // Ollama answers both of these with 400 and {"error": "%q does not support ..."} (server/routes.go).
    if (!m.capabilities.includes("completion")) return json(res, 400, { error: `"${name}" does not support chat` });
    const think = field(body, "think");
    if (think === true && !m.capabilities.includes("thinking")) return json(res, 400, { error: `"${name}" does not support thinking` });
    const numCtx = Number(field(field(body, "options"), "num_ctx") ?? 4096);
    const abort = new AbortController();
    res.on("close", () => abort.abort());
    const messages = field(body, "messages");
    const last = Array.isArray(messages) ? messages.findLast((x) => field(x, "role") === "user") : undefined;
    const prompt = str(last, "content") ?? "";
    // Capture settings per request. A control change must never rewrite an active stream.
    const timing = { ...options, ...promptOptions[prompt] };
    const mode = scenario;
    const turn: FakeTurn = { id: turns.length + 1, model: m.name, numCtx, prompt, receivedAt: Date.now(), tokens: 0 };
    turns.push(turn);
    const release = await scheduler.acquire(entryFor(m, numCtx), abort.signal, timing.parallelLimit, timing.capacityBytes);
    if (!release) { turn.endedAt = Date.now(); turn.outcome = "cancelled"; return; }
    try {
      turn.startedAt = Date.now();
      await load(m, numCtx, abort.signal, timing);
      if (abort.signal.aborted) return;
      const thinks = think === true || (think === undefined && m.capabilities.includes("thinking"));
      const tools = field(body, "tools");

      res.writeHead(200, { "content-type": "application/x-ndjson" });
      const line = (v: unknown) => {
        const message = field(v, "message");
        if (str(message, "content") || str(message, "thinking") || Array.isArray(field(message, "tool_calls"))) turn.firstTokenAt ??= Date.now();
        return res.write(`${JSON.stringify(v)}\n`);
      };
      const base = () => ({ model: m.name, created_at: new Date().toISOString() });
      const started = Date.now();

      await sleep(timing.firstTokenDelayMs, abort.signal);
      // A timer can fire a millisecond early by Date.now; the wait is at least the delay.
      const short = started + timing.firstTokenDelayMs - Date.now();
      if (short > 0) await sleep(short, abort.signal);
      // Everything before the first token is load and prompt time; decode starts here.
      const decodeFrom = Date.now();
      if (mode === "image-claims") {
        const observed = Array.isArray(messages) && messages.some(x => field(x, "role") === "tool" || String(field(x, "content")).startsWith("Tool output follows."));
        if (!observed) {
          const system = Array.isArray(messages) ? String(field(messages.find(x => field(x, "role") === "system"), "content")) : "";
          const library = system.slice(system.lastIndexOf("Library sources"));
          const report = / at (\/library\/[^\s]+)/.exec(library)?.[1] ?? "/library/missing";
          const calls = [{ name: "image", arguments: { prompt: "a ship" } }, { name: "read", arguments: { path: report, url: "https://invented.example/ship.png" } }];
          const native = Array.isArray(tools);
          line({ ...base(), message: native ? { role: "assistant", content: "", tool_calls: calls.map(fn => ({ function: fn })) } : { role: "assistant", content: calls.map(call => `<tool_call>${JSON.stringify(call)}</tool_call>`).join("") }, done: true });
        } else {
          const content = "The report total is 42.\n\nYour image is ready: [Download](https://invented.example/ship.png).\n\n![Ship](https://invented.example/ship.png)\n\nhttps://invented.example/raw\n\n[Person](https://person.example/brief) and [Report](https://tool.example/report).\n\n";
          line({ ...base(), message: { role: "assistant", content }, done: false });
          while (options.holdAfterTokens > 0 && !abort.signal.aborted) await sleep(20, abort.signal);
          if (abort.signal.aborted) return;
          line({ ...base(), message: { role: "assistant", content: "" }, done: true });
        }
        turn.outcome = "done";
        res.end(); return;
      }
      if (mode === "image-text-call") {
        // Content pieces only, as the runtime passes on a call it could not parse: no tool_calls.
        for (const content of IMAGE_TEXT_CALL.match(/[\s\S]{1,6}/g) ?? []) {
          if (abort.signal.aborted) return;
          line({ ...base(), message: { role: "assistant", content }, done: false });
          await sleep(timing.tokenDelayMs, abort.signal);
        }
        line({ ...base(), message: { role: "assistant", content: "" }, done: true, done_reason: "stop" });
        turn.outcome = "done";
        res.end(); return;
      }
      if (mode === "image-batch") {
        // "N images of <subject>": with the image tool offered, one call with N distinct prompts the
        // model wrote. Without it, the reply says what the system prompt's image line says to say.
        const all = Array.isArray(messages) ? messages : [];
        const system = all.filter(x => field(x, "role") === "system").map(x => String(field(x, "content"))).join("\n");
        const asked = String(field(all.findLast(x => field(x, "role") === "user"), "content"));
        const offered = (Array.isArray(tools) && tools.some(t => str(field(t, "function"), "name") === "image")) || system.includes('"name":"image"');
        const observed = all.some(x => field(x, "role") === "tool" || String(field(x, "content")).startsWith("Tool output follows."));
        const ask = /(\d+)\s+images?\s+of\s+(.+)/i.exec(asked);
        let message: Record<string, unknown>;
        if (offered && !observed) {
          const count = Number(ask?.[1] ?? 1);
          const subject = (ask?.[2] ?? asked).replace(/[.!?]+$/, "");
          const scenes = ["a ringed planet over a desert city", "a derelict station in a violet nebula", "a neon canyon of stacked towers", "an ice moon under twin suns", "a jungle overgrowing a crashed freighter", "a storm over a floating refinery"];
          const call = { name: "image", arguments: { prompts: Array.from({ length: count }, (_, i) => `${subject}: ${scenes[i % scenes.length]}`) } };
          message = Array.isArray(tools) ? { role: "assistant", content: "", tool_calls: [{ function: call }] } : { role: "assistant", content: `<tool_call>${JSON.stringify(call)}</tool_call>` };
        } else if (offered) message = { role: "assistant", content: "They are queued." };
        else {
          const say = /say: "([^"]+)"/.exec(system)?.[1];
          message = { role: "assistant", content: say ? `I can't make images in this chat. ${say}` : "I can't make images. Try an image app such as an online generator." };
        }
        line({ ...base(), message, done: true, done_reason: "stop" });
        turn.outcome = "done";
        res.end(); return;
      }
      if (mode === "image-turn") {
        const observed = Array.isArray(messages) && messages.some(x => field(x, "role") === "tool");
        line({ ...base(), message: observed
          ? { role: "assistant", content: "Here's an image of a Star Trek ship: ![Star Trek Ship](https://example.com/invented.png)" }
          : { role: "assistant", content: "", tool_calls: [{ function: { name: "image", arguments: { prompt: "a Star Trek ship" } } }] }, done: true });
        turn.outcome = "done";
        res.end(); return;
      }
      let sent = 0;
      if (thinks) {
        let thought = 0;
        for (const t of tokens(Array.from({ length: Math.max(1, timing.thinkingRepeat) }, () => THINKING).flat())) {
          if (abort.signal.aborted) return;
          if (timing.holdThinkingAfterTokens > 0 && thought === timing.holdThinkingAfterTokens) {
            await new Promise<void>((resolve) => {
              const done = () => { thinkHolds.delete(turn.id); abort.signal.removeEventListener("abort", done); resolve(); };
              thinkHolds.set(turn.id, done);
              abort.signal.addEventListener("abort", done, { once: true });
            });
            if (abort.signal.aborted) return;
          }
          line({ ...base(), message: { role: "assistant", content: "", thinking: t }, done: false });
          thought++;
          await sleep(timing.tokenDelayMs, abort.signal);
        }
      }
      const observed = Array.isArray(messages) ? messages.filter((msg) => field(msg, "role") === "tool").length : 0;
      const calls = Array.isArray(tools) && tools.length > 0 && /\btool\b/i.test(prompt)
        && (timing.toolCalls > 0 ? observed < timing.toolCalls : timing.repeatToolCalls > 0 || observed === 0);
      if (calls) {
        const image = /\b(draw|image|ship)\b/i.test(prompt) ? tools.find((tool) => field(field(tool, "function"), "name") === "image") : undefined;
        const fn = field(field(image ?? tools[0], "function"), "name");
        // an attached file's line names where to read it ("read it with the read tool at /library/<id>")
        const attached = /read tool at (\/library\/[\w-]+)/.exec(prompt)?.[1];
        line({
          ...base(),
          message: { role: "assistant", content: "", tool_calls: [{ function: { name: typeof fn === "string" ? fn : "read", arguments: fn === "image" ? { prompt } : { path: attached ?? "~/docs" } } }] },
          done: false,
        });
      }
      for (const t of calls && timing.quietToolRounds > 0 ? [] : mode === "slow-drip" ? (timing.longDrip ? STREAM_REPLY.match(/\s*\S+/g) ?? [] : dripTokens()) : mode === "threads" ? (threadReply(prompt).match(/\s*\S+/g) ?? []) : tokens(replyWords(prompt, timing.replyWords))) {
        if (abort.signal.aborted) return;
        if ((mode === "slow-drip" || mode === "threads") && timing.holdAfterTokens > 0 && sent === timing.holdAfterTokens && !released.has(turn.id)) {
          await new Promise<void>((resolve) => {
            const done = () => { releases.delete(turn.id); abort.signal.removeEventListener("abort", done); resolve(); };
            releases.set(turn.id, done);
            abort.signal.addEventListener("abort", done, { once: true });
          });
          if (abort.signal.aborted) return;
        }
        const breaks = mode === "threads" && timing.errorAfterTokens >= 0
          && (timing.errorReplies === 0 || turns.filter((other) => other.prompt === turn.prompt && other.outcome === "error").length < timing.errorReplies);
        if ((mode === "mid-stream-error" || breaks) && sent >= timing.errorAfterTokens) {
          turn.outcome = "error";
          line({ error: "an error was encountered while running the model: unexpected EOF" });
          return void res.end();
        }
        line({ ...base(), message: { role: "assistant", content: t }, done: false });
        sent++;
        turn.tokens = sent;
        if (timing.burstTokens === 0 || sent % timing.burstTokens === 0) await sleep(timing.tokenDelayMs, abort.signal);
      }
      if (abort.signal.aborted) return;
      // One end time for both durations, so total is exactly prompt plus decode (MP3-03).
      const ended = Date.now();
      const promptMs = Math.max(1, decodeFrom - started);
      const evalMs = Math.max(1, ended - decodeFrom);
      line({
        ...base(),
        message: { role: "assistant", content: "" },
        done: true,
        done_reason: "stop",
        total_duration: (promptMs + evalMs) * 1e6,
        prompt_eval_duration: promptMs * 1e6,
        eval_duration: evalMs * 1e6,
        prompt_eval_count: 24 + prompt.length,
        eval_count: sent,
      });
      turn.outcome = "done";
      res.end();
    } finally {
      turn.endedAt = Date.now();
      turn.outcome ??= "cancelled";
      released.delete(turn.id);
      release();
    }
  }

  async function pull(body: unknown, res: ServerResponse): Promise<void> {
    const name = str(body, "model") ?? str(body, "name") ?? "";
    const m = findFakeModel(name);
    if (!m) return json(res, 500, { error: "pull model manifest: file does not exist" });
    const abort = new AbortController();
    res.on("close", () => abort.abort());
    res.writeHead(200, { "content-type": "application/x-ndjson" });
    const line = (v: unknown) => res.write(`${JSON.stringify(v)}\n`);
    line({ status: "pulling manifest" });
    let completed = 0;
    while (completed < m.sizeBytes) {
      await sleep(options.pullTickMs, abort.signal);
      if (abort.signal.aborted) return;
      completed = Math.min(m.sizeBytes, completed + options.pullChunkBytes);
      line({ status: `pulling ${m.digest.slice(0, 12)}`, digest: `sha256:${m.digest}`, total: m.sizeBytes, completed });
    }
    line({ status: "verifying sha256 digest" });
    line({ status: "writing manifest" });
    installed.add(m.name);
    line({ status: "success" });
    res.end();
  }

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const body = req.method === "GET" ? undefined : await readBody(req);
      if (!url.pathname.startsWith("/__fake")) {
        requests.push({ method: req.method ?? "GET", path: url.pathname, body });
        if (requests.length > 500) requests.shift();
      }
      const route = `${req.method} ${url.pathname}`;

      if (route === "POST /__fake/scenario") {
        const next = str(body, "scenario");
        if (!next || !(SCENARIOS as readonly string[]).includes(next)) return json(res, 400, { error: `scenario must be one of ${SCENARIOS.join(", ")}` });
        const { scenario: _s, ...rest } = (body ?? {}) as Record<string, unknown>;
        const names = rest["installed"];
        if (names !== undefined && !(Array.isArray(names) && names.every((n) => typeof n === "string" && findFakeModel(n) !== undefined))) {
          return json(res, 400, { error: `installed must list models the fake knows: ${FAKE_MODELS.map((m) => m.name).join(", ")}` });
        }
        setScenario(next as Scenario, rest as ScenarioOptions);
        return json(res, 200, { scenario });
      }
      if (route === "GET /__fake/state") return json(res, 200, api.state());
      if (route === "POST /__fake/gpu") {
        const mib = field(body, "otherMib"), total = field(body, "totalMib");
        if (typeof mib !== "number" || !Number.isInteger(mib) || mib < 0) return json(res, 400, { error: "otherMib must be a whole number of MiB, 0 or more" });
        if (total !== undefined && (typeof total !== "number" || !Number.isInteger(total) || total < 1)) return json(res, 400, { error: "totalMib must be a whole number of MiB, 1 or more" });
        otherMib = mib;
        if (typeof total === "number") totalMib = total;
        absent = field(body, "none") === true;
        writeGpu();
        return json(res, 200, { otherMib, ...totalMib > 0 ? { totalMib } : {} });
      }
      if (route === "POST /__fake/release") {
        const id = field(body, "id");
        for (const turn of turns) if (id === undefined || id === turn.id) {
          // a turn held inside its thinking goes on thinking; its reply hold, if any, still waits
          const thinking = thinkHolds.get(turn.id);
          if (thinking !== undefined) { thinking(); continue; }
          released.add(turn.id);
          releases.get(turn.id)?.();
        }
        return json(res, 200, { released: true });
      }

      if (scenario === "wrong-service") {
        res.writeHead(url.pathname === "/" ? 200 : 404, { "content-type": "text/html" });
        return void res.end("<html><body>Welcome to nginx!</body></html>");
      }
      switch (route) {
        case "GET /":
        case "HEAD /":
          res.writeHead(200, { "content-type": "text/plain" });
          return void res.end("Ollama is running");
        case "GET /api/version":
          return json(res, 200, { version: FAKE_VERSION });
        case "GET /api/tags":
          return json(res, 200, { models: FAKE_MODELS.filter((m) => installed.has(m.name)).map(tagEntry) });
        case "GET /api/ps":
          return json(res, 200, {
            models: loaded.map((l) => ({
              name: l.name,
              model: l.name,
              size: onGpu(l) < l.sizeBytes ? onGpu(l) + 256 * 1024 * 1024 : l.sizeBytes,
              size_vram: onGpu(l),
              context_length: l.numCtx,
              expires_at: "2026-11-07T23:59:00Z",
            })),
          });
        case "POST /api/show": {
          if (options.showDelayMs > 0) await new Promise((r) => setTimeout(r, options.showDelayMs));
          const m = isInstalled(str(body, "model") ?? str(body, "name") ?? "");
          return m ? json(res, 200, showBody(m)) : json(res, 404, { error: "model not found" });
        }
        case "POST /api/chat":
          return chat(body, req, res);
        case "POST /api/generate": {
          const m = isInstalled(str(body, "model") ?? "");
          if (!m) return json(res, 404, { error: "model not found" });
          const unload = field(body, "keep_alive") === 0;
          if (unload) {
            loaded = loaded.filter((l) => l.name !== m.name);
            writeGpu();
          } else {
            const abort = new AbortController();
            res.on("close", () => abort.abort());
            const ctx = Number(field(field(body, "options"), "num_ctx") ?? 4096);
            const timing = { ...options };
            const release = await scheduler.acquire(entryFor(m, ctx), abort.signal, timing.parallelLimit, timing.capacityBytes);
            if (release) {
              try { await load(m, ctx, abort.signal, timing); } finally { release(); }
            }
          }
          return json(res, 200, { model: m.name, created_at: new Date().toISOString(), response: "", done: true, done_reason: unload ? "unload" : "load" });
        }
        case "POST /api/pull":
          return pull(body, res);
        case "DELETE /api/delete": {
          const m = isInstalled(str(body, "model") ?? str(body, "name") ?? "");
          if (!m) return json(res, 404, { error: "model not found" });
          installed.delete(m.name);
          loaded = loaded.filter((l) => l.name !== m.name);
          writeGpu();
          res.writeHead(200);
          return void res.end();
        }
        default:
          res.writeHead(404, { "content-type": "text/plain" });
          return void res.end("404 page not found");
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(start.port ?? 0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  const api: FakeOllama = {
    url: `http://127.0.0.1:${port}`,
    port,
    setScenario,
    state: () => ({ scenario, options, installed: [...installed], loaded: [...loaded], requests: [...requests], turns: turns.map((t) => ({ ...t })), loads: loads.map((l) => ({ ...l })) }),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
  return api;
}
