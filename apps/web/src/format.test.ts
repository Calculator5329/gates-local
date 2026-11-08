import { describe, expect, it } from "vitest";
import type { FitReport, Message } from "@gates-local/contracts";
import { decodeSpeed, replyMeta, verdictOf } from "./format.ts";

const GIB = 1024 ** 3;
const base: FitReport = {
  model: "m",
  numCtx: 16384,
  freeVramBytes: 12 * GIB,
  needVramBytes: 0,
  spillRamBytes: 0,
  verdict: "refuse",
  source: "estimate",
  measuredAt: 1,
};

describe("verdictOf", () => {
  it("words a context-limit refusal as the most the model supports", () => {
    const v = verdictOf({ ...base, model: "nomic-embed-text:latest", contextLimit: 2048, message: "num_ctx 16384 is above the model's context_length 2048; refused." });
    expect(v.k).toBe("no");
    expect(v.word).toBe("Supports up to 2k context");
    expect(v.chip).toBe("up to 2k context");
    expect(v.word).not.toMatch(/memory/i);
  });

  it("keeps the memory words for a memory refusal", () => {
    const v = verdictOf({ ...base, needVramBytes: 20 * GIB, shortfallBytes: 3 * GIB });
    expect(v.word).toBe("Not enough memory at 16k");
    expect(v.chip).toBe("not enough memory");
    expect(v.detail).toBe("needs 3.0 GB more");
  });
});

const msg = (stats: Message["stats"]): Message => ({ id: "a", threadId: "t", role: "assistant", content: "x", createdAt: 1, ...(stats ? { stats } : {}) });

describe("decode speed", () => {
  it("divides by decode time, not the total that includes the load", () => {
    // A cold turn: 4 s total (3.5 s of it loading the model), 60 tokens decoded in 0.5 s.
    const m = msg({ completionTokens: 60, durationMs: 4000, evalDurationMs: 500 });
    expect(decodeSpeed(m.stats)).toBe(120);
    expect(replyMeta("Qwen 3.5 9B", m, 2900)).toBe("Qwen 3.5 9B · 2.9 s to first token · 120 tok/s");
  });

  it("falls back to the total for a reply saved before decode time was kept", () => {
    expect(decodeSpeed({ completionTokens: 60, durationMs: 2000 })).toBe(30);
    expect(decodeSpeed({ completionTokens: 60 })).toBeUndefined();
  });
});
