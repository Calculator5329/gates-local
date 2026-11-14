// WIN-MEM-02 (docs/evidence/windows-low-memory-bug-report.md): a refusal for memory offers what does
// fit, from the same reading. The numbers are the report's: gemma4:e4b needs 8,200,560,697 bytes at
// 16,384 and 7,848,239,161 at 4,096; once the other model had left, about 4.93 GB of GPU memory was
// free and 4.32 GB of system memory available; qwen3.5:4b (3.3 GB) was installed.
import { describe, expect, it } from "vitest";
import { chooseOffer } from "./alternatives.ts";
import { DEFAULT_MARGINS, decideFit } from "./fit.ts";

const FREE_VRAM = 4_930_000_000;
const MEM_AVAILABLE = 4_320_000_000;
const at = (model: string, numCtx: number, needBytes: number, memAvailableBytes = MEM_AVAILABLE) =>
  decideFit({ model, numCtx, needBytes, freeVramBytes: FREE_VRAM, memAvailableBytes, measuredAt: 1 });

const GEMMA = "gemma4:e4b";
const QWEN = "qwen3.5:4b";
const gemma16k = at(GEMMA, 16384, 8_200_560_697);
// 8k sits between the report's 4k and 16k needs.
const gemma8k = at(GEMMA, 8192, 7_965_000_000);
// 3.3 GB of weights, its KV cache at 16k and the 1 GiB overhead.
const qwen16k = at(QWEN, 16384, 4_640_000_000);

describe("chooseOffer", () => {
  it("no context of the refused model fits: the other installed model that runs, at the default context", () => {
    expect(gemma16k.verdict).toBe("refuse");
    expect(gemma8k.verdict).toBe("refuse");
    const offer = chooseOffer({ refused: gemma16k, contexts: [gemma8k], models: [qwen16k], margins: DEFAULT_MARGINS });
    expect(offer.context).toBeUndefined();
    // 4.39 GB usable on the GPU, so the 4.64 GB it needs runs with a little in system memory
    expect(offer.model).toEqual({ model: QWEN, numCtx: 16384, verdict: "spills" });
  });

  it("a smaller context of the same model fits: that context, and no other model", () => {
    // The same machine with 0.5 GB more system memory free: 8k runs, 16k still does not.
    const roomier = MEM_AVAILABLE + 500_000_000;
    const refused = at(GEMMA, 16384, 8_200_560_697, roomier);
    const smaller = at(GEMMA, 8192, 7_000_000_000, roomier);
    expect(refused.verdict).toBe("refuse");
    const offer = chooseOffer({ refused, contexts: [smaller], models: [qwen16k], margins: DEFAULT_MARGINS });
    expect(offer.context).toEqual({ numCtx: 8192, verdict: "spills" });
    expect(offer.model).toBeUndefined();
  });

  it("a model that fits only with part of it in system memory is offered, marked as spilling", () => {
    const spills = at(QWEN, 16384, 6_000_000_000);
    expect(spills.verdict).toBe("spills");
    expect(chooseOffer({ refused: gemma16k, contexts: [], models: [spills], margins: DEFAULT_MARGINS }).model).toEqual({ model: QWEN, numCtx: 16384, verdict: "spills" });
  });

  it("the largest model that runs, and the largest context; never one that refuses or a larger context", () => {
    const small = at("tiny:1b", 16384, 2_000_000_000);
    const big = at("mid:3b", 16384, 4_000_000_000);
    const tooBig = at("huge:27b", 16384, 20_000_000_000);
    const offer = chooseOffer({ refused: gemma16k, contexts: [], models: [small, tooBig, big], margins: DEFAULT_MARGINS });
    expect(offer.model?.model).toBe("mid:3b");
    const contexts = [at(GEMMA, 8192, 3_000_000_000), at(GEMMA, 4096, 2_000_000_000), at(GEMMA, 32768, 3_500_000_000)];
    expect(chooseOffer({ refused: gemma16k, contexts, models: [], margins: DEFAULT_MARGINS }).context?.numCtx).toBe(8192);
  });

  it("says what is short, GPU and system memory apart, from the refusal's own numbers", () => {
    const { short } = chooseOffer({ refused: gemma16k, contexts: [gemma8k], models: [], margins: DEFAULT_MARGINS });
    expect(short.needBytes).toBe(8_200_560_697);
    // 4.93 GB free less the 512 MiB margin; 4.32 GB available less the 2 GiB margin
    expect(short.gpuBytes).toBe(FREE_VRAM - 512 * 1024 ** 2);
    expect(short.ramBytes).toBe(MEM_AVAILABLE - 2 * 1024 ** 3);
    expect(short.shortBytes).toBe(gemma16k.shortfallBytes);
    expect(short.shortBytes / 1e9).toBeCloseTo(1.63, 2);
  });
});
