import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GPU_STATUS_ARGS } from "../../apps/server/src/fit/gpu-status.ts";
import { startFakeOllama, threadReply, type FakeOllama } from "./fake-ollama.ts";

const HERE = import.meta.dirname;

async function ndjson(res: Response): Promise<Record<string, unknown>[]> {
  const text = await res.text();
  return text
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

const post = (fake: FakeOllama, p: string, body: unknown, method = "POST") =>
  fetch(`${fake.url}${p}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const contentOf = (lines: Record<string, unknown>[]) => lines.map((l) => (l["message"] as { content?: string } | undefined)?.content ?? "").join("");

describe("fake ollama", () => {
  let fake: FakeOllama;
  beforeEach(async () => {
    fake = await startFakeOllama({ options: { tokenDelayMs: 0, firstTokenDelayMs: 0, pullTickMs: 1 } });
  });
  afterEach(() => fake.close());

  it("answers the probe the server runs", async () => {
    expect(await (await fetch(`${fake.url}/`)).text()).toContain("Ollama is running");
    expect(await (await fetch(`${fake.url}/api/version`)).json()).toEqual({ version: "0.40.4" });
    const tags = (await (await fetch(`${fake.url}/api/tags`)).json()) as { models: { name: string }[] };
    expect(tags.models.map((m) => m.name)).toEqual(["qwen3.5:9b", "gemma4:12b", "qwen3.8-abliterated:27b"]);
  });

  for (const parallelLimit of [1, 2]) {
    it(`threads: ${parallelLimit} slot(s) record independent lifetimes and exact words`, async () => {
      fake.setScenario("threads", { parallelLimit, holdAfterTokens: 20, tokenDelayMs: 0, firstTokenDelayMs: 0 });
      const request = (prompt: string) => post(fake, "/api/chat", { model: "qwen3.5:9b", think: false, options: { num_ctx: 8192 }, messages: [{ role: "user", content: prompt }] }).then(ndjson);
      const first = request("alpha");
      await vi.waitFor(() => expect(fake.state().turns[0]?.tokens).toBe(20));
      const second = request("beta");
      await vi.waitFor(() => expect(fake.state().turns).toHaveLength(2));
      if (parallelLimit === 1) expect(fake.state().turns[1]?.startedAt).toBeUndefined();
      else await vi.waitFor(() => expect(fake.state().turns[1]?.tokens).toBe(20));
      await post(fake, "/__fake/release", { id: 1 });
      const a = await first;
      await vi.waitFor(() => expect(fake.state().turns[1]?.tokens).toBe(20));
      await post(fake, "/__fake/release", { id: 2 });
      const b = await second;
      expect(contentOf(a)).toBe(threadReply("alpha")); expect(contentOf(b)).toBe(threadReply("beta"));
      const [one, two] = fake.state().turns;
      expect(one?.outcome).toBe("done"); expect(two?.outcome).toBe("done");
      if (parallelLimit === 1) expect(two?.startedAt).toBeGreaterThanOrEqual(one?.endedAt ?? Infinity);
      else expect(two?.firstTokenAt).toBeLessThan(one?.endedAt ?? 0);
    });
  }

  it("threads: a new context waits, then replaces the resident copy without changing the first reply", async () => {
    fake.setScenario("threads", { parallelLimit: 2, holdAfterTokens: 20, tokenDelayMs: 0, firstTokenDelayMs: 0, loadDelayMs: 40 });
    const request = (prompt: string, num_ctx: number) => post(fake, "/api/chat", { model: "qwen3.5:9b", think: false, options: { num_ctx }, messages: [{ role: "user", content: prompt }] }).then(ndjson);
    const first = request("alpha", 8192);
    await vi.waitFor(() => expect(fake.state().turns[0]?.tokens).toBe(20));
    const second = request("beta", 16384);
    await vi.waitFor(() => expect(fake.state().turns).toHaveLength(2));
    expect(fake.state().loaded[0]?.numCtx).toBe(8192);
    expect(fake.state().turns[1]?.startedAt).toBeUndefined();
    await post(fake, "/__fake/release", { id: 1 }); await first;
    await vi.waitFor(() => expect(fake.state().turns[1]?.tokens).toBe(20));
    expect(fake.state().loaded[0]?.numCtx).toBe(16384);
    await post(fake, "/__fake/release", { id: 2 }); await second;
    expect(fake.state().loads.map((l) => l.numCtx)).toEqual([8192, 16384]);
    const { turns, loads } = fake.state();
    expect(loads[1]?.startedAt).toBeGreaterThanOrEqual(turns[0]?.endedAt ?? Infinity);
    expect(turns[1]?.firstTokenAt).toBeGreaterThanOrEqual(loads[1]?.endedAt ?? Infinity);
    expect((loads[1]?.endedAt ?? 0) - (loads[1]?.startedAt ?? 0)).toBeGreaterThan(0);
  });

  it("threads: /api/ps names each model and its own KV memory", async () => {
    fake.setScenario("threads", { installed: ["tiny-chat:2k", "mid-chat:32k"], tokenDelayMs: 0, firstTokenDelayMs: 0 });
    for (const model of ["tiny-chat:2k", "mid-chat:32k"]) {
      await (await post(fake, "/api/chat", { model, options: { num_ctx: 2048 }, messages: [{ role: "user", content: model }] })).text();
    }
    const ps = await (await fetch(`${fake.url}/api/ps`)).json() as { models: { name: string; size_vram: number; context_length: number }[] };
    expect(ps.models.map((m) => m.name)).toEqual(["tiny-chat:2k", "mid-chat:32k"]);
    for (const m of ps.models) {
      expect(m.context_length).toBe(2048);
      expect(m.size_vram).toBe(fake.state().loaded.find((l) => l.name === m.name)?.sizeBytes);
    }
  });

  it("threads: an aborted cold load never appears resident", async () => {
    fake.setScenario("threads", { loadDelayMs: 500 });
    const controller = new AbortController();
    const loading = fetch(`${fake.url}/api/chat`, { method: "POST", body: JSON.stringify({ model: "qwen3.5:9b", messages: [{ role: "user", content: "alpha" }] }), signal: controller.signal }).catch(() => undefined);
    await vi.waitFor(() => expect(fake.state().loads).toHaveLength(1));
    controller.abort(); await loading;
    await vi.waitFor(() => expect(fake.state().loads[0]?.cancelled).toBe(true));
    expect(fake.state().loaded).toEqual([]);
    expect(fake.state().turns[0]?.outcome).toBe("cancelled");
  });

  it("threads: releasing before the pause is reached advances that request instead of losing the release", async () => {
    fake.setScenario("threads", { firstTokenDelayMs: 300, tokenDelayMs: 0, holdAfterTokens: 20 });
    const reply = post(fake, "/api/chat", { model: "gemma4:12b", messages: [{ role: "user", content: "early release" }] }).then(ndjson).catch(() => []);
    await vi.waitFor(() => expect(fake.state().turns).toHaveLength(1));
    await post(fake, "/__fake/release", { id: 1 });
    await vi.waitFor(() => expect(fake.state().turns[0]?.outcome).toBe("done"), { timeout: 1000 });
    expect((await reply).at(-1)).toMatchObject({ done: true });
  });

  const hello = async () =>
    ndjson(await post(fake, "/api/chat", { model: "qwen3.5:9b", messages: [{ role: "user", content: "hello there" }], stream: true }));

  it("streams thinking then deterministic content for a thinking model", async () => {
    const lines = await hello();
    const thinking = lines.map((l) => (l["message"] as { thinking?: string } | undefined)?.thinking ?? "").join("");
    const content = lines.map((l) => (l["message"] as { content?: string } | undefined)?.content ?? "").join("");
    expect(thinking).toMatch(/^The question is short/);
    expect(content).toMatch(/^You asked: hello there\. Here is/);
    expect(lines.at(-1)).toMatchObject({ done: true, done_reason: "stop" });
    const again = (await hello()).map((l) => (l["message"] as { content?: string } | undefined)?.content ?? "").join("");
    expect(again).toBe(content);
  });

  it("skips thinking when think is false, and loads the model at the asked context", async () => {
    const lines = await ndjson(
      await post(fake, "/api/chat", { model: "qwen3.5:9b", think: false, options: { num_ctx: 32768 }, messages: [{ role: "user", content: "x" }] }),
    );
    expect(lines.some((l) => (l["message"] as { thinking?: string } | undefined)?.thinking)).toBe(false);
    expect(fake.state().loaded).toMatchObject([{ name: "qwen3.5:9b", numCtx: 32768 }]);
  });

  it("W-10: refuses think true for a model without thinking, with Ollama's status and error body", async () => {
    const res = await post(fake, "/api/chat", { model: "gemma4:12b", think: true, messages: [{ role: "user", content: "x" }] });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: '"gemma4:12b" does not support thinking' });
    // think false, or left out, still chats.
    const ok = await post(fake, "/api/chat", { model: "gemma4:12b", think: false, messages: [{ role: "user", content: "x" }] });
    expect(ok.status).toBe(200);
    await ok.text();
  });

  it("ends a reply with eval_duration that covers decode only, inside total_duration", async () => {
    fake.setScenario("models", { tokenDelayMs: 2, firstTokenDelayMs: 40 });
    const last = (await hello()).at(-1) ?? {};
    const total = Number(last["total_duration"]);
    const evalNs = Number(last["eval_duration"]);
    const promptNs = Number(last["prompt_eval_duration"]);
    expect(evalNs).toBeGreaterThan(0);
    expect(promptNs).toBeGreaterThan(0);
    // The first-token wait is load and prompt time, not decode: total splits into the two.
    expect(total).toBe(promptNs + evalNs);
  });

  it("reads one end time, so total_duration splits exactly even when the clock ticks between reads (MP3-03)", async () => {
    fake.setScenario("models", { tokenDelayMs: 0, firstTokenDelayMs: 0 });
    // The fake's own clock ticks 40 ms on every read, so any two reads differ, however many the fake makes (MP4-06).
    let reads = 0;
    const realNow = Date.now.bind(Date);
    const spy = vi.spyOn(Date, "now").mockImplementation(() => ((new Error().stack ?? "").includes("fake-ollama.ts") ? 1000 + 40 * reads++ : realNow()));
    let last: Record<string, unknown>;
    try {
      last = (await hello()).at(-1) ?? {};
    } finally {
      spy.mockRestore();
    }
    const promptNs = Number(last["prompt_eval_duration"]);
    const evalNs = Number(last["eval_duration"]);
    expect(promptNs).toBeGreaterThan(0);
    expect(evalNs).toBeGreaterThan(0);
    expect(Number(last["total_duration"])).toBe(promptNs + evalNs);
  });

  it("embed-smallest: an embedding model is installed and smallest, lists embedding only, and refuses chat", async () => {
    fake.setScenario("embed-smallest");
    const tags = (await (await fetch(`${fake.url}/api/tags`)).json()) as { models: { name: string; size: number }[] };
    const smallest = tags.models.toSorted((a, b) => a.size - b.size)[0];
    expect(smallest?.name).toBe("nomic-embed-text:latest");
    expect(tags.models.map((m) => m.name)).toEqual(["qwen3.5:9b", "gemma4:12b", "qwen3.8-abliterated:27b", "nomic-embed-text:latest"]);
    const show = (await (await post(fake, "/api/show", { model: "nomic-embed-text:latest" })).json()) as { capabilities: string[] };
    expect(show.capabilities).toEqual(["embedding"]);
    const chat = await post(fake, "/api/chat", { model: "nomic-embed-text:latest", messages: [{ role: "user", content: "x" }] });
    expect(chat.status).toBe(400);
    expect(await chat.json()).toEqual({ error: '"nomic-embed-text:latest" does not support chat' });
  });

  it("returns native tool_calls when tools are offered and the prompt asks for one", async () => {
    const lines = await ndjson(
      await post(fake, "/api/chat", {
        model: "gemma4:12b",
        tools: [{ type: "function", function: { name: "list_files" } }],
        messages: [{ role: "user", content: "use a tool please" }],
      }),
    );
    const call = lines.find((l) => (l["message"] as { tool_calls?: unknown } | undefined)?.tool_calls);
    expect(call?.["message"]).toMatchObject({ tool_calls: [{ function: { name: "list_files" } }] });
    const continued = await ndjson(await post(fake, "/api/chat", {
      model: "gemma4:12b", tools: [{ type: "function", function: { name: "list_files" } }],
      messages: [{ role: "user", content: "use a tool please" }, { role: "tool", content: "result" }],
    }));
    expect(continued.some((l) => (l["message"] as { tool_calls?: unknown } | undefined)?.tool_calls)).toBe(false);
  });

  it("can repeat native tool requests after an observation, while still respecting tools off", async () => {
    await post(fake, "/__fake/scenario", { scenario: "models", repeatToolCalls: 1, tokenDelayMs: 0, firstTokenDelayMs: 0 });
    const body = { model: "gemma4:12b", messages: [{ role: "user", content: "use a tool please" }, { role: "tool", content: "Path is outside your Library" }] };
    const repeated = await ndjson(await post(fake, "/api/chat", { ...body, tools: [{ type: "function", function: { name: "read" } }] }));
    expect(repeated.some(l => (l["message"] as { tool_calls?: unknown } | undefined)?.tool_calls)).toBe(true);
    const plain = await ndjson(await post(fake, "/api/chat", body));
    expect(plain.some(l => (l["message"] as { tool_calls?: unknown } | undefined)?.tool_calls)).toBe(false);
  });

  it("breaks the stream with an error in the mid-stream-error scenario", async () => {
    await post(fake, "/__fake/scenario", { scenario: "mid-stream-error", tokenDelayMs: 0, firstTokenDelayMs: 0, errorAfterTokens: 3 });
    const lines = await ndjson(await post(fake, "/api/chat", { model: "qwen3.5:9b", think: false, messages: [{ role: "user", content: "hi" }] }));
    expect(lines).toHaveLength(4);
    expect(lines.at(-1)).toHaveProperty("error");
  });

  it("pulls a model with progress, then lists it; a closed request cancels", async () => {
    await post(fake, "/__fake/scenario", { scenario: "no-models", pullTickMs: 1, pullChunkBytes: 1024 ** 3 });
    expect(fake.state().installed).toEqual([]);
    const lines = await ndjson(await post(fake, "/api/pull", { model: "qwen3.5:4b", stream: true }));
    expect(lines[0]).toEqual({ status: "pulling manifest" });
    expect(lines.filter((l) => typeof l["completed"] === "number").length).toBeGreaterThan(2);
    expect(lines.at(-1)).toEqual({ status: "success" });
    expect(fake.state().installed).toEqual(["qwen3.5:4b"]);
  });

  it("a pull aborted after its first progress line never installs, even past its completion time (W-11)", async () => {
    // ten ticks of 20 ms: an uncancelled pull of this model finishes in about 200 ms
    const options = { scenario: "no-models", pullTickMs: 20, pullChunkBytes: Math.ceil(6594474711 / 10) };
    await post(fake, "/__fake/scenario", options);
    const started = Date.now();
    expect((await ndjson(await post(fake, "/api/pull", { model: "qwen3.5:9b" }))).at(-1)).toEqual({ status: "success" });
    const deadline = Date.now() - started;
    expect(fake.state().installed).toEqual(["qwen3.5:9b"]);

    await post(fake, "/__fake/scenario", options);
    expect(fake.state().installed).toEqual([]);
    const abort = new AbortController();
    const res = await fetch(`${fake.url}/api/pull`, { method: "POST", body: JSON.stringify({ model: "qwen3.5:9b" }), signal: abort.signal });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let seen = "";
    while (!seen.includes('"completed"')) {
      const { value, done } = await reader.read();
      if (done) throw new Error("the pull ended before any progress");
      seen += decoder.decode(value, { stream: true });
    }
    abort.abort();
    await reader.cancel().catch(() => undefined);
    // three times what the whole pull took uncancelled
    await new Promise((r) => setTimeout(r, Math.max(600, 3 * deadline)));
    expect(fake.state().installed).toEqual([]);
  });

  it("refuses an unknown pull, unloads with keep_alive 0, and deletes", async () => {
    expect((await post(fake, "/api/pull", { model: "nope:1b" })).status).toBe(500);
    await post(fake, "/api/generate", { model: "gemma4:12b", prompt: "" });
    expect(fake.state().loaded.map((l) => l.name)).toEqual(["gemma4:12b"]);
    await post(fake, "/api/generate", { model: "gemma4:12b", keep_alive: 0 });
    expect(fake.state().loaded).toEqual([]);
    expect((await post(fake, "/api/delete", { model: "gemma4:12b" }, "DELETE")).status).toBe(200);
    expect(fake.state().installed).not.toContain("gemma4:12b");
  });

  it("answers as something else in the wrong-service scenario", async () => {
    await post(fake, "/__fake/scenario", { scenario: "wrong-service" });
    expect(await (await fetch(`${fake.url}/`)).text()).not.toContain("Ollama is running");
    expect((await fetch(`${fake.url}/api/version`)).status).toBe(404);
  });

  it("installs the models a scenario names, and refuses a name it does not know", async () => {
    const tags = async () => ((await (await fetch(`${fake.url}/api/tags`)).json()) as { models: { name: string }[] }).models.map((m) => m.name);
    expect((await post(fake, "/__fake/scenario", { scenario: "models", installed: ["gemma4:12b", "mistral-small3.2:24b"] })).status).toBe(200);
    expect(await tags()).toEqual(["gemma4:12b", "mistral-small3.2:24b"]);
    expect((await post(fake, "/__fake/scenario", { scenario: "models", installed: ["nope:1b"] })).status).toBe(400);
    expect(await tags()).toEqual(["gemma4:12b", "mistral-small3.2:24b"]);
    await post(fake, "/__fake/scenario", { scenario: "models" });
    expect(await tags()).toEqual(["qwen3.5:9b", "gemma4:12b", "qwen3.8-abliterated:27b"]);
  });
});

// POSIX runs the script through its #! line; Windows has none, so Node runs it there.
const smi = path.join(HERE, "nvidia-smi.ts");
const [smiFile, smiArgs] = process.platform === "win32" ? [process.execPath, [smi]] : [smi, []];
const run = (args: string[], env: Record<string, string> = {}) =>
  new Promise<string>((resolve, reject) =>
    execFile(smiFile, [...smiArgs, ...args], { env: { ...process.env, ...env } }, (e, out) => (e ? reject(e) : resolve(out))),
  );

describe("fake nvidia-smi", () => {
  it("prints totals and the resident apps, plus ollama once a model is loaded", async () => {
    expect(await run(["--query-gpu=memory.total,memory.used,memory.free", "--format=csv,noheader,nounits"])).toBe("16303, 4182, 12121\n");
    // gpu.status's form (GPU_STATUS_ARGS): the card name, then the same totals
    expect(await run([...GPU_STATUS_ARGS])).toBe("NVIDIA GeForce RTX 5070 Ti, 16303, 4182, 12121\n");
    const dir = path.join(homedir(), ".cache", "gates-local-lanes", "build-web", "unit");
    mkdirSync(dir, { recursive: true });
    const stateFile = path.join(mkdtempSync(path.join(dir, "gpu-")), "gpu.json");
    const fake = await startFakeOllama({ gpuStateFile: stateFile });
    try {
      await post(fake, "/api/generate", { model: "qwen3.5:9b", options: { num_ctx: 16384 } });
      const apps = await run(["--query-compute-apps=pid,process_name,used_memory", "--format=csv,noheader,nounits"], {
        GATES_LOCAL_FAKE_GPU_STATE: stateFile,
      });
      expect(apps).toMatch(/whisper-server, 2150\n/);
      expect(apps).toMatch(/media-vault-vision, 1822\n/);
      expect(apps).toMatch(/\/usr\/local\/bin\/ollama, \d+\n$/);
    } finally {
      await fake.close();
    }
  });
});
