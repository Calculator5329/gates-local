import { describe, expect, it } from "vitest";
import { imageFitVerdict } from "../src/index.ts";

const GIB = 1024 ** 3;

describe("the image job's fit", () => {
  it("names what free memory lacks now, counting ComfyUI's own memory as free, and nothing when it fits", () => {
    expect(imageFitVerdict({ estimateBytes: 10 * GIB, freeBytes: 3 * GIB, creditedBytes: 2 * GIB })).toEqual({ verdict: "refuse", shortBytes: 5 * GIB });
    expect(imageFitVerdict({ estimateBytes: 10 * GIB, freeBytes: 3 * GIB, creditedBytes: 2 * GIB, freeableBytes: 5 * GIB })).toEqual({ verdict: "frees", shortBytes: 5 * GIB });
    expect(imageFitVerdict({ estimateBytes: 10 * GIB, freeBytes: 8 * GIB, creditedBytes: 2 * GIB })).toEqual({ verdict: "fits", shortBytes: 0 });
    expect(imageFitVerdict({ estimateBytes: 4 * GIB, freeBytes: 8 * GIB, creditedBytes: 2 * GIB })).toEqual({ verdict: "fits", shortBytes: 0 });
  });
});
