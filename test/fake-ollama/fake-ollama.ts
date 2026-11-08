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
// GET /__fake/state returns installed and loaded models and the request log.
import { writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { DEFAULT_INSTALLED, EMBED_ONLY_INSTALLED, EMBED_SMALLEST_INSTALLED, FAKE_MODELS, findFakeModel, showBody, type FakeModel } from "./models.ts";

const installedFor = (s: string): readonly string[] =>
  s === "no-models" ? [] : s === "embed-smallest" ? EMBED_SMALLEST_INSTALLED : s === "embed-only" ? EMBED_ONLY_INSTALLED : DEFAULT_INSTALLED;

export const SCENARIOS = ["models", "no-models", "slow-first-token", "mid-stream-error", "wrong-service", "embed-smallest", "embed-only"] as const;
export type Scenario = (typeof SCENARIOS)[number];

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
  /** Delay before /api/show answers: holds the server's fit survey (and so its chat pick). */
  showDelayMs: number;
}

const DEFAULTS: FakeOptions = {
  tokenDelayMs: 12,
  firstTokenDelayMs: 60,
  pullChunkBytes: 256 * 1024 * 1024,
  pullTickMs: 100,
  replyWords: 60,
  errorAfterTokens: 8,
  showDelayMs: 0,
};

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

export interface FakeOllama {
  readonly url: string;
  readonly port: number;
  setScenario(scenario: Scenario, options?: Partial<FakeOptions>): void;
  state(): { scenario: Scenario; options: FakeOptions; installed: string[]; loaded: LoadedEntry[]; requests: FakeRequest[] };
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

export async function startFakeOllama(start: StartOptions = {}): Promise<FakeOllama> {
  let scenario: Scenario = start.scenario ?? "models";
  let options: FakeOptions = { ...DEFAULTS, ...start.options };
  let installed = new Set<string>(installedFor(scenario));
  let loaded: LoadedEntry[] = [];
  const requests: FakeRequest[] = [];

  const writeGpu = () => {
    if (!start.gpuStateFile) return;
    writeFileSync(start.gpuStateFile, JSON.stringify({ loaded }));
  };
  writeGpu();

  const setScenario = (next: Scenario, opts: Partial<FakeOptions> = {}) => {
    scenario = next;
    options = { ...DEFAULTS, ...start.options, ...(next === "slow-first-token" ? { firstTokenDelayMs: 2500 } : {}), ...opts };
    installed = new Set(installedFor(next));
    loaded = [];
    writeGpu();
  };
  if (scenario === "slow-first-token") setScenario(scenario, start.options);

  const isInstalled = (name: string): FakeModel | undefined => {
    const m = findFakeModel(name);
    return m && installed.has(m.name) ? m : undefined;
  };

  const load = (m: FakeModel, numCtx: number) => {
    const kv = m.blockCount * m.headCountKv * m.keyLength * 2 * 2 * numCtx;
    loaded = [...loaded.filter((l) => l.name !== m.name), { name: m.name, numCtx, sizeBytes: m.sizeBytes + kv }];
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
    load(m, numCtx);
    const messages = field(body, "messages");
    const last = Array.isArray(messages) ? messages.findLast((x) => field(x, "role") === "user") : undefined;
    const prompt = str(last, "content") ?? "";
    const thinks = think === true || (think === undefined && m.capabilities.includes("thinking"));
    const tools = field(body, "tools");

    const abort = new AbortController();
    res.on("close", () => abort.abort());
    res.writeHead(200, { "content-type": "application/x-ndjson" });
    const line = (v: unknown) => res.write(`${JSON.stringify(v)}\n`);
    const base = () => ({ model: m.name, created_at: new Date().toISOString() });
    const started = Date.now();

    await sleep(options.firstTokenDelayMs, abort.signal);
    // Everything before the first token is load and prompt time; decode starts here.
    const decodeFrom = Date.now();
    let sent = 0;
    if (thinks) {
      for (const t of tokens(THINKING)) {
        if (abort.signal.aborted) return;
        line({ ...base(), message: { role: "assistant", content: "", thinking: t }, done: false });
        await sleep(options.tokenDelayMs, abort.signal);
      }
    }
    if (Array.isArray(tools) && tools.length > 0 && /\btool\b/i.test(prompt)) {
      const fn = field(field(tools[0], "function"), "name");
      line({
        ...base(),
        message: { role: "assistant", content: "", tool_calls: [{ function: { name: typeof fn === "string" ? fn : "read", arguments: { path: "~/docs" } } }] },
        done: false,
      });
    }
    for (const t of tokens(replyWords(prompt, options.replyWords))) {
      if (abort.signal.aborted) return;
      if (scenario === "mid-stream-error" && sent >= options.errorAfterTokens) {
        line({ error: "an error was encountered while running the model: unexpected EOF" });
        return void res.end();
      }
      line({ ...base(), message: { role: "assistant", content: t }, done: false });
      sent++;
      await sleep(options.tokenDelayMs, abort.signal);
    }
    if (abort.signal.aborted) return;
    line({
      ...base(),
      message: { role: "assistant", content: "" },
      done: true,
      done_reason: "stop",
      total_duration: (Date.now() - started) * 1e6,
      prompt_eval_duration: Math.max(1, decodeFrom - started) * 1e6,
      eval_duration: Math.max(1, Date.now() - decodeFrom) * 1e6,
      prompt_eval_count: 24 + prompt.length,
      eval_count: sent,
    });
    res.end();
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
        setScenario(next as Scenario, rest as Partial<FakeOptions>);
        return json(res, 200, { scenario });
      }
      if (route === "GET /__fake/state") return json(res, 200, api.state());

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
              size: l.sizeBytes,
              size_vram: l.sizeBytes,
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
          } else load(m, Number(field(field(body, "options"), "num_ctx") ?? 4096));
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
    state: () => ({ scenario, options, installed: [...installed], loaded: [...loaded], requests: [...requests] }),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
  return api;
}
