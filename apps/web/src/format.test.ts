import { describe, expect, it } from "vitest";
import type { FitReport, Message } from "@gates-local/contracts";
import { CONTEXT_SIZES, ctxFor, decodeSpeed, fileSize, gb, k, otherCtxWords, replyMeta, shortAge, sourceDetail, verdictOf } from "./format.ts";

const SP = String.fromCharCode(160);

describe("gb", () => {
  it("keeps the number and its unit on one line", () => {
    expect(gb(5.1 * 1024 ** 3)).toBe(`5.1${SP}GB`);
  });
});

describe("shortAge, the drawer's one time format", () => {
  const now = Date.UTC(2026, 10, 12, 20);
  const ago = (ms: number) => shortAge(now - ms, now);
  const MIN = 60_000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;
  it.each([
    [10_000, "now"],
    [5 * MIN, "5m"],
    [3 * HOUR, "3h"],
    [2 * DAY, "2d"],
    [21 * DAY, "3w"],
    [150 * DAY, "5mo"],
    [800 * DAY, "2y"],
  ])("%d ms ago is %s", (ms, want) => {
    expect(ago(ms)).toBe(want);
  });
});

const size = (sizeBytes: number) => sourceDetail({ id: "s", kind: "file", label: "notes.txt", path: "notes.txt", addedAt: 0, sizeBytes, state: "ready" });
describe("a Library source's size", () => {
  it("says a small file's real size, never rounds it up to 1 MB", () => {
    // A 223-byte text file showed as "1 MB" in the Library (Windows test, 2026-11-07).
    expect(size(223)).toBe("223 bytes");
    expect(size(1)).toBe("1 byte");
    expect(size(40_000)).toBe("39 KB");
    expect(size(5 * 1024 ** 2)).toBe("5 MB");
    expect(size(3 * 1024 ** 3)).toBe(`3.0${SP}GB`);
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

describe("the context a model runs at", () => {
  const models = [{ name: "tiny:2k", maxContext: 2048 }, { name: "big:9b", maxContext: 262144 }, { name: "new:1b" }];

  it("is the chosen size, never past what the model takes, and never jumps up to its maximum", () => {
    expect(ctxFor(16384, models, "tiny:2k")).toBe(2048);
    expect(ctxFor(16384, models, "big:9b")).toBe(16384);
  });

  it("stays the chosen size until the model is known", () => {
    expect(ctxFor(16384, models, "new:1b")).toBe(16384);
    expect(ctxFor(16384, models, "absent")).toBe(16384);
    expect(ctxFor(16384, undefined, "tiny:2k")).toBe(16384);
  });

  it("offers an 8k choice and labels small windows honestly", () => {
    expect(CONTEXT_SIZES).toEqual([8192, 16384, 32768, 65536]);
    expect(k(2048)).toBe("2k");
    expect(k(512)).toBe("512");
  });
});

describe("verdictOf", () => {
  it("a fitting report on a small model reads as any other fit, never as a refusal", () => {
    const v = verdictOf({ ...base, numCtx: 2048, verdict: "fits" });
    expect(v.k).toBe("gpu");
    expect(v.word).toBe("Runs on GPU");
  });

  it("keeps the memory words for a memory refusal", () => {
    const v = verdictOf({ ...base, needVramBytes: 20 * GIB, shortfallBytes: 3 * GIB });
    expect(v.word).toBe("Not enough memory at 16k");
    expect(v.chip).toBe("not enough memory");
    expect(v.detail).toBe(`needs 3.0${SP}GB more`);
  });
});

const msg = (stats: Message["stats"]): Message => ({ id: "a", threadId: "t", role: "assistant", content: "x", createdAt: 1, ...(stats ? { stats } : {}) });

const fits = (numCtx: number, need: number): FitReport => ({ ...base, numCtx, verdict: "fits", needVramBytes: need * GIB });

describe("the other context size's words (F36b)", () => {
  it("keeps the memory and GPU words otherwise", () => {
    expect(otherCtxWords(fits(16384, 6), fits(32768, 8.5))).toBe(`still runs on GPU; uses 2.5${SP}GB more`);
    expect(otherCtxWords(fits(16384, 6), { ...base, numCtx: 32768, needVramBytes: 20 * GIB, shortfallBytes: 3 * GIB })).toBe(`not enough memory; needs 3.0${SP}GB more`);
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

describe("fileSize", () => {
  it("moves up a unit when rounding reaches 1024 (LS-01)", () => {
    expect(fileSize(1_048_064)).toBe("1 MB");
    expect(fileSize(1_073_217_536)).toBe(`1.0${SP}GB`);
  });

  it("stays in the unit below that", () => {
    expect(fileSize(1023)).toBe("1023 bytes");
    expect(fileSize(1_047_552)).toBe("1023 KB");
    expect(fileSize(1_072_693_248)).toBe("1023 MB");
  });
});
