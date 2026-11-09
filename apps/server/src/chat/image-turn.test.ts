import { describe, expect, it, vi } from "vitest";
import { startFakeOllama } from "../../../../test/fake-ollama/fake-ollama.ts";
import { streamToolTurn } from "./tools.ts";

describe("the image-turn fake Ollama scenario", () => {
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
      expect(queueImage).toHaveBeenCalledOnce();
    } finally { await fake.close(); }
  });
});
