import { describe, expect, it } from "vitest";
import { turnClock } from "./times.ts";

const call = (callId: string, state: "running" | "done") => ({ type: "tool" as const, step: { callId, state } });

describe("turnClock (chat row 32, decision 33)", () => {
  it("times a warm reply's thought from ready to its first answer word, and each round", () => {
    const c = turnClock(1_000);
    c.ready(1_200);
    c.see({ type: "thinking", text: "Hmm" }, 1_300, "");
    c.see(call("c1", "running"), 2_300, "Hmm");
    c.see(call("c1", "done"), 2_400, "Hmm");
    c.see({ type: "thinking", text: " then" }, 2_500, "Hmm");
    c.see({ type: "delta", text: "Yes" }, 3_700, "Hmm then");
    expect(c.end({ reason: "done", at: 4_000 }, "Hmm then")).toEqual({
      // the work clock starts at the first thought: from ready until then the runtime may hold it in a queue
      startedAt: 1_000, firstTokenAt: 3_700, thoughtMs: 2_500, workMs: 2_400,
      spans: [{ from: 0, ms: 1_000 }, { from: 3, ms: 1_200 }], callsAt: { c1: 3 }, ended: { reason: "done", at: 4_000 },
    });
  });

  it("words that come after a Stop change no time: the thought runs to the Stop, and there is no first word", () => {
    const c = turnClock(1_000);
    c.ready(1_000);
    c.see({ type: "thinking", text: "Hmm" }, 1_500, "");
    c.stop(4_000, "Hmm");
    // the model's first answer word was already on its way when the cancel landed
    expect(c.see({ type: "delta", text: "Late" }, 4_100, "Hmm")).toBe(false);
    const t = c.end({ reason: "stopped", at: 4_000 }, "Hmm");
    expect(t.firstTokenAt).toBeUndefined();
    expect(t.thoughtMs).toBe(3_000);
    expect(t.workMs).toBe(2_500);
    expect(t.spans).toEqual([{ from: 0, ms: 2_500 }]);
  });

  // thinks 0-3 s, writes at 3 s, a call 3.5-8.5 s, thinks from 8.5 s; then answers at 10 s and ends
  // at 12 s, or keeps thinking until another device's Stop at 30 s: what every window shows after
  it.each([["done", 5, 9_500], ["stopped", 25, 29_500]] as const)("rounds of thinking either side of a call add up, %s", (end, secs, work) => {
    const c = turnClock(0);
    c.ready(0);
    c.see({ type: "thinking", text: "Hm." }, 0, "");
    c.see({ type: "delta", text: "Let me check." }, 3_000, "Hm.");
    c.see(call("a", "running"), 3_500, "Hm.");
    c.see(call("a", "done"), 8_500, "Hm.");
    c.see({ type: "thinking", text: " Again." }, 8_500, "Hm.");
    if (end === "done") c.see({ type: "delta", text: " Done." }, 10_000, "Hm. Again.");
    else c.stop(30_000, "Hm. Again.");
    const t = c.end({ reason: end, at: end === "done" ? 12_000 : 30_000 }, "Hm. Again.");
    expect(Math.round(t.spans.reduce((n, s) => n + s.ms, 0) / 1000)).toBe(secs);
    expect(t.callsAt).toEqual({ a: 3 });
    // the work clock: thinking and the call, never the writing between them or after
    expect(t.workMs).toBe(work);
  });

  it("keeps why only for a turn the server halted or that failed", () => {
    const why = { code: "model-error", message: "boom" };
    expect(turnClock(0).end({ reason: "failed", at: 5 }, "", why).why).toEqual(why);
    expect(turnClock(0).end({ reason: "stopped", at: 5 }, "", why).why).toBeUndefined();
  });

  it("a model in memory leaves the reply waiting until the runtime's first event: it may be queued behind another reply", () => {
    const c = turnClock(0);
    c.ready(0);
    expect(c.record(3_000)).toMatchObject({ stage: "waiting", readyAt: 0, workMs: 0 });
    expect(c.see({ type: "thinking", text: "x" }, 3_000, "")).toBe(true);
    expect(c.record(4_000)).toMatchObject({ stage: "thinking", workMs: 1_000 });
  });

  it("goes waiting, loading, thinking, tool, writing; the work clock never counts the load or the writing", () => {
    const c = turnClock(0);
    expect(c.record(0)).toMatchObject({ stage: "waiting", workMs: 0, toolMs: 0, attempt: 1 });
    expect(c.loading(), "the first notice moves it: a push").toBe(true);
    expect(c.loading(), "a second notice changes nothing: no push").toBe(false);
    expect(c.record(5_000)).toMatchObject({ stage: "loading", workMs: 0 });
    expect(c.record(5_000).readyAt).toBeUndefined();
    // a cold load is ready at its first token
    expect(c.see({ type: "thinking", text: "x" }, 5_000, "")).toBe(true);
    expect(c.record(7_000)).toMatchObject({ stage: "thinking", readyAt: 5_000, workMs: 2_000 });
    expect(c.loading(), "a started reply is never sent back to loading").toBe(false);
    expect(c.see(call("t", "running"), 7_000, "x")).toBe(true);
    expect(c.record(8_000)).toMatchObject({ stage: "tool", workMs: 3_000, toolMs: 1_000, callsAt: { t: 1 } });
    expect(c.see(call("t", "done"), 9_000, "x")).toBe(true);
    expect(c.record(9_000)).toMatchObject({ stage: "thinking", toolMs: 2_000 });
    expect(c.see({ type: "delta", text: "Hi" }, 10_000, "x")).toBe(true);
    // more words change nothing a window draws: no push
    expect(c.see({ type: "delta", text: " there" }, 11_000, "x")).toBe(false);
    expect(c.record(15_000)).toMatchObject({ stage: "writing", firstTokenAt: 10_000, workMs: 5_000, toolMs: 2_000 });
    expect(c.end({ reason: "done", at: 16_000 }, "x").workMs).toBe(5_000);
    expect(c.record(16_000)).toMatchObject({ stage: "ended", ended: { reason: "done", at: 16_000 } });
  });

  it("a second attempt starts its rounds and first word over and keeps the work done", () => {
    const c = turnClock(0);
    c.ready(0);
    c.see({ type: "thinking", text: "Hm" }, 0, "");
    c.see({ type: "delta", text: "Par" }, 1_000, "Hm");
    c.retry(2_000);
    expect(c.record(2_000)).toMatchObject({ stage: "thinking", attempt: 2, workMs: 1_000, spans: [], callsAt: {} });
    expect(c.record(2_000).firstTokenAt).toBeUndefined();
    c.see({ type: "delta", text: "Whole" }, 2_500, "");
    const t = c.end({ reason: "done", at: 3_000 }, "");
    expect(t).toMatchObject({ firstTokenAt: 2_500, workMs: 1_500 });
  });
});
