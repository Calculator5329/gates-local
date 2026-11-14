// The server's words for a fit verdict (fit-words.ts): the status line every list and Settings print.
import { describe, expect, it } from "vitest";
import { fitWords, type FitReport, type FitVerdict } from "../src/index.ts";

const GIB = 1024 ** 3;
const report = (verdict: FitVerdict, measured = false): FitReport => ({
  model: "m",
  numCtx: 16384,
  freeVramBytes: 14 * GIB,
  needVramBytes: 8 * GIB,
  spillRamBytes: verdict === "spills" ? GIB : 0,
  verdict,
  source: measured ? "measured" : "estimate",
  measuredAt: 0,
});
const label = (verdict: FitVerdict, measured = false, cpu = false) => fitWords(report(verdict, measured), "card", cpu).label;

describe("fit words", () => {
  it("says an estimate is one, and keeps Runs for a model that really ran at that size", () => {
    expect(label("fits")).toBe("Should run well");
    expect(label("spills")).toBe("Should run slower");
    expect(label("fits", true)).toBe("Runs well");
    expect(label("spills", true)).toBe("Runs slower");
  });

  it("says a model that cannot load won't run, measured or not", () => {
    expect(label("refuse")).toBe("Won't run here");
    expect(label("refuse", true, true)).toBe("Won't run here");
  });

  it("a fitting report on a small model reads as any other fit, never as a refusal", () => {
    const w = fitWords({ ...report("fits"), numCtx: 2048 }, "card", false);
    expect(w.k).toBe("gpu");
    expect(w.word).toBe("Runs on GPU");
  });

  it("keeps the memory words for a memory refusal", () => {
    const w = fitWords({ ...report("refuse"), needVramBytes: 20 * GIB, shortfallBytes: 3 * GIB }, "card", false);
    expect(w.word).toBe("Not enough memory at 16k");
    expect(w.chip).toBe("not enough memory");
    expect(w.detail).toBe(`needs 3.0${String.fromCharCode(160)}GB more`);
  });

  it("says system memory when there is no supported GPU", () => {
    expect(label("spills", false, true)).toBe("Should run in system memory");
    expect(label("spills", true, true)).toBe("Runs in system memory");
  });
});
