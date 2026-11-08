import { afterEach, describe, expect, it, vi } from "vitest";
import { realCheck } from "./real-check.ts";

const MiB = 1024 * 1024;
const entry = { name: "tiny", model: "tiny", size: 1000 * MiB, size_vram: 1000 * MiB, expires_at: "later", digest: "d" };
const ndjson = (items: unknown[]) => new Response(items.map((i) => JSON.stringify(i)).join("\n") + "\n");
const probes = {
  runNvidiaSmi: async (args: readonly string[]) => (args[0]?.startsWith("--query-gpu") ? "16384, 1024, 15360\n" : "5100, /usr/bin/whisper-server, 2202\n"),
  readMeminfo: async () => "MemAvailable: 32000000 kB\n",
};
/** An Ollama holding a model whose maximum context is 2,048; the model is resident once a chat has run. */
const fakeOllama = () => {
  const chats: { options: { num_ctx: number } }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const pathname = new URL(String(url)).pathname;
    if (pathname === "/api/ps") return Response.json({ models: chats.length > 0 ? [entry] : [] });
    if (pathname === "/api/tags") return Response.json({ models: [{ name: "tiny", size: 100 * MiB, digest: "d" }] });
    if (pathname === "/api/show") return Response.json({ model_info: { "general.architecture": "tiny", "tiny.context_length": 2048 }, capabilities: ["completion"] });
    if (pathname === "/api/generate") return Response.json({});
    if (pathname !== "/api/chat") throw new Error(`unexpected request to ${pathname}`);
    chats.push(JSON.parse(String(init?.body)) as { options: { num_ctx: number } });
    return ndjson([{ message: { content: "4" }, done: true, done_reason: "stop" }]);
  }));
  return chats;
};

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("the real-runtime check at a model's maximum context (R-03)", () => {
  it("a 2,048-maximum model asked for 16,384 streams and measures at 2,048", async () => {
    const chats = fakeOllama();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const code = await realCheck({ baseUrl: "http://fake", model: "tiny", numCtx: 16384 }, probes);
    expect(chats.map((c) => c.options.num_ctx)).toEqual([2048]);
    const lines = log.mock.calls.map(([line]) => String(line));
    const measured = lines.findIndex((line) => /fit \(measured\)/.test(line));
    expect(lines[measured + 1]).toContain("num_ctx 2048");
    expect(code).toBe(0);
  });
});
