import { describe, expect, it } from "vitest";
import type { FitReport, Message } from "@gates-local/contracts";
import { decodeSpeed, otherCtxWords, replyMeta, sourceDetail, verdictOf } from "./format.ts";

const size = (sizeBytes: number) => sourceDetail({ id: "s", kind: "file", label: "notes.txt", path: "notes.txt", addedAt: 0, sizeBytes, state: "ready" });
describe("a Library source's size", () => {
  it("says a small file's real size, never rounds it up to 1 MB", () => {
    // A 223-byte text file showed as "1 MB" in the Library (Windows test, 2026-11-07).
    expect(size(223)).toBe("223 bytes");
    expect(size(1)).toBe("1 byte");
    expect(size(40_000)).toBe("39 KB");
    expect(size(5 * 1024 ** 2)).toBe("5 MB");
    expect(size(3 * 1024 ** 3)).toBe("3.0 GB");
  });
});

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

const fits = (numCtx: number, need: number): FitReport => ({ ...base, numCtx, verdict: "fits", needVramBytes: need * GIB });

describe("the other context size's words (F36b)", () => {
  it("MP-06: a refusal past the model's context limit says so, not 'not enough memory'", () => {
    const past = { ...base, numCtx: 32768, contextLimit: 16384, message: "num_ctx 32768 is above the model's context_length 16384; refused." };
    const words = otherCtxWords(fits(16384, 6), past);
    expect(words).toBe("past its context limit; it supports up to 16k");
    expect(words).not.toMatch(/memory/i);
  });

  it("keeps the memory and GPU words otherwise", () => {
    expect(otherCtxWords(fits(16384, 6), fits(32768, 8.5))).toBe("still runs on GPU; uses 2.5 GB more");
    expect(otherCtxWords(fits(16384, 6), { ...base, numCtx: 32768, needVramBytes: 20 * GIB, shortfallBytes: 3 * GIB })).toBe("not enough memory; needs 3.0 GB more");
  });

  it("does not say 'still' when the two refusals differ in kind", () => {
    const limited = { ...base, numCtx: 65536, contextLimit: 32768 };
    const memory = { ...base, numCtx: 32768, needVramBytes: 20 * GIB, shortfallBytes: 1 * GIB };
    expect(otherCtxWords(limited, memory)).toBe("not enough memory; needs 1.0 GB more");
  });
});

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
