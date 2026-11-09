import { describe, expect, it, vi } from "vitest";
import { startFakeOllama } from "../../../../test/fake-ollama/fake-ollama.ts";
import { streamToolTurn } from "./tools.ts";

describe("the image-turn fake Ollama scenario", () => {
  it("queues an image with valid arguments while another threads-scenario reply can remain held", async () => {
    const fake = await startFakeOllama({ scenario: "threads", options: { parallelLimit: 2, firstTokenDelayMs: 0, tokenDelayMs: 0 } });
    const abort = new AbortController();
    try {
      fake.setScenario("threads", { prompts: { alpha: { holdAfterTokens: 28 } } });
      await fetch(`${fake.url}/api/chat`, { method: "POST", signal: abort.signal, body: JSON.stringify({ model: "qwen3.5:9b", options: { num_ctx: 16384 }, messages: [{ role: "user", content: "alpha" }], stream: true }) });
      await vi.waitFor(() => expect(fake.state().turns[0]?.tokens).toBe(28));
      const queueImage = vi.fn(async () => ({ jobId: "ship" }));
      for await (const _ of streamToolTurn({ baseUrl: fake.url, model: "qwen3.5:9b", numCtx: 16384,
        messages: [{ role: "user", content: "Use a tool to draw a ship" }], sources: [], image: true, queueImage,
      })) { /* consume the turn */ }
      expect(queueImage).toHaveBeenCalledWith("Use a tool to draw a ship", expect.any(AbortSignal));
      expect(fake.state().turns[0]?.endedAt).toBeUndefined();
      expect(fake.state().turns[1]?.outcome).toBe("done");
    } finally { abort.abort(); await fake.close(); }
  });

  it("cannot send its invented image after queueing a job", async () => {
    const fake = await startFakeOllama({ scenario: "image-turn", options: { firstTokenDelayMs: 0 } });
    try {
      const queueImage = vi.fn(async () => ({ jobId: "ship" }));
      const events = [];
      for await (const event of streamToolTurn({ baseUrl: fake.url, model: "qwen3.5:9b", numCtx: 16384,
        messages: [{ role: "user", content: "Generate an image of a Star Trek ship" }], sources: [], image: true, queueImage,
      })) events.push(event);
      expect(events.at(-1)).toMatchObject({ type: "done", message: { content: "", tools: [{ name: "image", state: "done" }] } });
      expect(fake.state().requests.filter(r => r.path === "/api/chat")).toHaveLength(1);
      expect(fake.state().turns[0]?.outcome).toBe("done");
      expect(queueImage).toHaveBeenCalledOnce();
    } finally { await fake.close(); }
  });
});
