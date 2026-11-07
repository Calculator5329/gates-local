import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { InvalidInputError, TurnBufferClosedError } from "./errors.ts";
import { openThreadStore, type ThreadStore } from "./store.ts";
import { createTurnBuffer } from "./turn-buffer.ts";

function clock(...times: number[]): () => number {
  let i = 0;
  return () => times[Math.min(i++, times.length - 1)]!;
}

describe("createTurnBuffer", () => {
  it("accumulates deltas and thinking and exposes the partial text", () => {
    const buf = createTurnBuffer({ threadId: "t1", now: clock(100) });
    expect(buf.state).toBe("streaming");
    expect(buf.partial()).toEqual({ content: "", thinking: "" });
    buf.appendThinking("let me ");
    buf.appendDelta("Hel");
    buf.appendThinking("think");
    buf.appendDelta("lo");
    expect(buf.partial()).toEqual({ content: "Hello", thinking: "let me think" });
  });

  it("finish returns the completed Message and closes the buffer", () => {
    const buf = createTurnBuffer({ threadId: "t1", model: "qwen3:8b", now: clock(1_000, 1_750) });
    buf.appendThinking("plan");
    buf.appendDelta("done");
    const msg = buf.finish({ promptTokens: 10, completionTokens: 1, numCtx: 16384 });
    expect(msg).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      threadId: "t1",
      role: "assistant",
      content: "done",
      thinking: "plan",
      model: "qwen3:8b",
      createdAt: 1_750,
      stats: { promptTokens: 10, completionTokens: 1, numCtx: 16384, durationMs: 750 },
    });
    expect(buf.state).toBe("finished");
    expect(buf.startedAt).toBe(1_000);
    expect(() => buf.appendDelta("late")).toThrow(TurnBufferClosedError);
    expect(() => buf.appendThinking("late")).toThrow(TurnBufferClosedError);
    expect(() => buf.finish()).toThrow(TurnBufferClosedError);
    buf.discard(); // no-op after finish
    expect(buf.state).toBe("finished");
  });

  it("omits empty thinking and keeps a caller durationMs", () => {
    const buf = createTurnBuffer({ threadId: "t1", role: "system", now: clock(0, 5) });
    buf.appendDelta("x");
    const msg = buf.finish({ durationMs: 42 });
    expect(msg.thinking).toBeUndefined();
    expect(msg.model).toBeUndefined();
    expect(msg.role).toBe("system");
    expect(msg.stats).toEqual({ durationMs: 42 });
  });

  it("discard drops the partial and refuses further use", () => {
    const buf = createTurnBuffer({ threadId: "t1" });
    buf.appendDelta("half a sen");
    buf.discard();
    buf.discard(); // idempotent
    expect(buf.state).toBe("discarded");
    expect(buf.partial()).toEqual({ content: "", thinking: "" });
    expect(() => buf.appendDelta("tence")).toThrow(TurnBufferClosedError);
    expect(() => buf.finish()).toThrow(TurnBufferClosedError);
  });

  it("validates input", () => {
    expect(() => createTurnBuffer({ threadId: "" })).toThrow(InvalidInputError);
    const buf = createTurnBuffer({ threadId: "t1" });
    expect(() => buf.appendDelta(3 as unknown as string)).toThrow(InvalidInputError);
  });
});

describe("turn buffer with the store", () => {
  let dir: string;
  let store: ThreadStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "gates-turnbuf-"));
    store = openThreadStore(join(dir, "threads.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("persists a finished turn exactly once and nothing from a discarded one", () => {
    const t = store.createThread();
    store.appendMessage({ threadId: t.id, role: "user", content: "q" });

    const cancelled = createTurnBuffer({ threadId: t.id });
    cancelled.appendDelta("never stored");
    expect(store.getThread(t.id).messages).toHaveLength(1); // deltas stay in memory
    cancelled.discard();

    const ok = createTurnBuffer({ threadId: t.id, model: "m" });
    ok.appendDelta("stored ");
    ok.appendDelta("answer");
    expect(store.getThread(t.id).messages).toHaveLength(1);
    const msg = store.appendMessage(ok.finish());

    const { messages } = store.getThread(t.id);
    expect(messages.map((m) => m.content)).toEqual(["q", "stored answer"]);
    expect(messages[1]).toEqual(msg);
  });
});
