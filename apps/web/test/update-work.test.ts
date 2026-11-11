// What an update stops, one short line per kind of running work, for the
// footer's one confirm: the server's activity list plus this window's queue and drafts.
import { describe, expect, it } from "vitest";
import { workLines } from "../src/update-work.ts";

describe("the confirm's lines", () => {
  it("say what stops and what happens to it, once, only for the work that runs", () => {
    expect(workLines(["1 running reply (including other windows)", "model download: qwen3:14b", "2 image generation jobs (queued or running)", "3 queued messages in this window", "1 unsent draft in this window", "Import: notes.zip"])).toEqual([
      "1 reply stops. Its text is kept.",
      "Download of qwen3:14b stops. It resumes.",
      "2 image jobs stop.",
      "3 queued messages wait for Send now.",
      "1 unsent draft is kept.",
      "Import: notes.zip must finish before the update.",
    ]);
    expect(workLines(["3 running replies (including other windows)", "1 image generation jobs (queued or running)", "1 queued message in this window", "2 unsent drafts in this window"])).toEqual([
      "3 replies stop. Their text is kept.",
      "1 image job stops.",
      "1 queued message waits for Send now.",
      "2 unsent drafts are kept.",
    ]);
  });
  it("count this window's queue and drafts", async () => {
    const { setState } = await import("../src/store.ts");
    const { replaceDraft } = await import("../src/drafts.ts");
    const { updateWork } = await import("../src/update-work.ts");
    expect(updateWork([])).toEqual([]);
    setState({ queued: [{ id: "q1", threadId: "t", text: "a", at: 1, waitFor: "reply" }, { id: "q2", threadId: "t", text: "b", at: 2, waitFor: "reply" }] });
    replaceDraft("t", { text: "half a thought" });
    expect(updateWork(["1 running reply (including other windows)"])).toEqual(["1 running reply (including other windows)", "2 queued messages in this window", "1 unsent draft in this window"]);
    expect(updateWork(undefined)).toBeUndefined();
  });
  it("nothing running: no lines; activity the server did not send: one line that says so", () => {
    expect(workLines([])).toEqual([]);
    expect(workLines(undefined)).toEqual(["What is running could not be read. It all stops."]);
  });
});
