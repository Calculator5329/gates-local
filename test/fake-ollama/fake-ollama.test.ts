import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GPU_STATUS_ARGS } from "../../apps/server/src/fit/gpu-status.ts";
import { startFakeOllama, type FakeOllama } from "./fake-ollama.ts";

const HERE = path.dirname(new URL(import.meta.url).pathname);

async function ndjson(res: Response): Promise<Record<string, unknown>[]> {
  const text = await res.text();
  return text
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

const post = (fake: FakeOllama, p: string, body: unknown, method = "POST") =>
  fetch(`${fake.url}${p}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

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
    // The fake's own clock: start 1000, first token 1040, then a millisecond boundary between any two end reads.
    const clock = [1000, 1040, 1200, 1201];
    let reads = 0;
    const realNow = Date.now.bind(Date);
    const spy = vi.spyOn(Date, "now").mockImplementation(() => ((new Error().stack ?? "").includes("fake-ollama.ts") ? (clock[reads++] ?? 1201) : realNow()));
    let last: Record<string, unknown>;
    try {
      last = (await hello()).at(-1) ?? {};
    } finally {
      spy.mockRestore();
    }
    expect(Number(last["prompt_eval_duration"])).toBe(40e6);
    expect(Number(last["eval_duration"])).toBe(160e6);
    expect(Number(last["total_duration"])).toBe(200e6);
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

    await post(fake, "/__fake/scenario", { scenario: "no-models", pullTickMs: 50, pullChunkBytes: 1024 ** 2 });
    const abort = new AbortController();
    const res = await fetch(`${fake.url}/api/pull`, { method: "POST", body: JSON.stringify({ model: "qwen3.5:9b" }), signal: abort.signal });
    expect(res.ok).toBe(true);
    abort.abort();
    await new Promise((r) => setTimeout(r, 120));
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
});

const run = (args: string[], env: Record<string, string> = {}) =>
  new Promise<string>((resolve, reject) =>
    execFile(path.join(HERE, "nvidia-smi.ts"), args, { env: { ...process.env, ...env } }, (e, out) => (e ? reject(e) : resolve(out))),
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
