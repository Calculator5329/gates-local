import { describe, expect, it } from "vitest";
import { interruptedWork } from "./activity.ts";

describe("the work an update would interrupt", () => {
  it("names the imports, the replies running in every window, each model download and the image jobs, and nothing when all is idle", () => {
    expect(interruptedWork({ imports: [], turns: 0, downloads: [], imageJobs: 0 })).toEqual([]);
    expect(interruptedWork({ imports: ["import: notes.pdf"], turns: 1, downloads: ["qwen3.5:9b", "gemma4:e4b"], imageJobs: 2 })).toEqual([
      "import: notes.pdf",
      "1 running reply (including other windows)",
      "model download: qwen3.5:9b",
      "model download: gemma4:e4b",
      "2 image generation jobs (queued or running)",
    ]);
    expect(interruptedWork({ imports: [], turns: 3, downloads: [], imageJobs: 1 })).toEqual(["3 running replies (including other windows)", "1 image generation jobs (queued or running)"]);
  });
});
