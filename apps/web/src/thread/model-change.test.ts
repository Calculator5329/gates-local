// Owner, 2026-11-13: "it tells you in a chat if you've changed models mid-chat, like image versus text versus whatever."
import type { Message } from "@gates-local/contracts";
import { describe, expect, it } from "vitest";
import { LIVE_QUESTION, modelChanges } from "./model-change.ts";

let n = 0;
const ask = (): Message => ({ id: `u${++n}`, threadId: "T", role: "user", content: "q", createdAt: n });
const reply = (model: string): Message => ({ id: `a${++n}`, threadId: "T", role: "assistant", content: "a", model, createdAt: n });
const picture = (preset: string): Message => ({
  id: `a${++n}`, threadId: "T", role: "assistant", content: "a lighthouse", model: preset, createdAt: n,
  imageJob: { jobId: `j${n}`, state: "done", choice: { preset, width: 1024, height: 1024 } },
});
const QWEN = { kind: "chat", model: "qwen3.5:9b" } as const;
const GEMMA = { kind: "chat", model: "gemma4:e4b" } as const;
const ZIMAGE = { kind: "image", preset: "z-image-int8" } as const;

describe("modelChanges", () => {
  it("marks each question answered by another thing than the turn before, never the first", () => {
    const q1 = ask(), q2 = ask(), q3 = ask(), q4 = ask(), q5 = ask();
    const thread = [q1, reply("qwen3.5:9b"), q2, reply("qwen3.5:9b"), q3, reply("gemma4:e4b"), q4, picture("z-image-int8"), q5, reply("gemma4:e4b")];
    expect([...modelChanges(thread)]).toEqual([
      [q3.id, { from: QWEN, to: GEMMA }],
      [q4.id, { from: GEMMA, to: ZIMAGE }],
      [q5.id, { from: ZIMAGE, to: GEMMA }],
    ]);
  });

  it("a chat reply that drew a picture with its tool was answered by the chat model", () => {
    const q1 = ask(), q2 = ask();
    const thread = [q1, reply("qwen3.5:9b"), q2, picture("z-image-int8"), reply("qwen3.5:9b")];
    expect(modelChanges(thread).size).toBe(0);
  });

  it("a question with no reply saved changes nothing; the next answered one compares with the last answered", () => {
    const q1 = ask(), q2 = ask(), q3 = ask();
    expect([...modelChanges([q1, reply("qwen3.5:9b"), q2, q3, reply("gemma4:e4b")])]).toEqual([[q3.id, { from: QWEN, to: GEMMA }]]);
  });

  it("a live turn counts from its first frame: before its question is saved, and before any reply", () => {
    const q1 = ask(), q2 = ask();
    const thread = [q1, reply("qwen3.5:9b")];
    expect([...modelChanges(thread, { questionId: undefined, by: ZIMAGE })]).toEqual([[LIVE_QUESTION, { from: QWEN, to: ZIMAGE }]]);
    expect([...modelChanges([...thread, q2], { questionId: q2.id, by: GEMMA })]).toEqual([[q2.id, { from: QWEN, to: GEMMA }]]);
    // a picture its tool saved while the chat reply is still being written does not make it an image turn
    expect([...modelChanges([...thread, q2, picture("z-image-int8")], { questionId: q2.id, by: QWEN })]).toEqual([]);
  });

  it("the same model under its :latest name is no change", () => {
    const q1 = ask(), q2 = ask();
    expect(modelChanges([q1, reply("llama3.2"), q2, reply("llama3.2:latest")]).size).toBe(0);
  });
});
