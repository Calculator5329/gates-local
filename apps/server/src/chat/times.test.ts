import { describe, expect, it } from "vitest";
import { turnClock } from "./times.ts";

describe("turnClock (chat row 32)", () => {
  it("times a warm reply's thought from ready to its first answer word, and each round", () => {
    const c = turnClock(1_000);
    c.ready(1_200);
    c.see({ type: "thinking", text: "Hmm" }, 1_300, "");
    c.see({ type: "tool", step: { callId: "c1" } }, 2_300, "Hmm");
    c.see({ type: "thinking", text: " then" }, 2_500, "Hmm");
    c.see({ type: "delta", text: "Yes" }, 3_700, "Hmm then");
    expect(c.end({ reason: "done", at: 4_000 }, "Hmm then")).toEqual({
      startedAt: 1_000, firstTokenAt: 3_700, thoughtMs: 2_500,
      spans: [{ from: 0, ms: 1_000 }, { from: 3, ms: 1_200 }], callsAt: { c1: 3 }, ended: { reason: "done", at: 4_000 },
    });
  });

  it("words that come after a Stop change no time: the thought runs to the Stop, and there is no first word", () => {
    const c = turnClock(1_000);
    c.ready(1_000);
    c.see({ type: "thinking", text: "Hmm" }, 1_500, "");
    c.stop(4_000, "Hmm");
    // the model's first answer word was already on its way when the cancel landed
    c.see({ type: "delta", text: "Late" }, 4_100, "Hmm");
    const t = c.end({ reason: "stopped", at: 4_000 }, "Hmm");
    expect(t.firstTokenAt).toBeUndefined();
    expect(t.thoughtMs).toBe(3_000);
    expect(t.spans).toEqual([{ from: 0, ms: 2_500 }]);
  });

  // thinks 0-3 s, writes at 3 s, a call 3.5-8.5 s, thinks from 8.5 s; then answers at 10 s and ends
  // at 12 s, or keeps thinking until another device's Stop at 30 s: what every window shows after
  it.each([["done", 5], ["stopped", 25]] as const)("rounds of thinking either side of a call add up, %s", (end, secs) => {
    const c = turnClock(0);
    c.ready(0);
    c.see({ type: "thinking", text: "Hm." }, 0, "");
    c.see({ type: "delta", text: "Let me check." }, 3_000, "Hm.");
    c.see({ type: "tool", step: { callId: "a" } }, 3_500, "Hm.");
    c.see({ type: "thinking", text: " Again." }, 8_500, "Hm.");
    if (end === "done") c.see({ type: "delta", text: " Done." }, 10_000, "Hm. Again.");
    else c.stop(30_000, "Hm. Again.");
    const t = c.end({ reason: end, at: end === "done" ? 12_000 : 30_000 }, "Hm. Again.");
    expect(Math.round(t.spans.reduce((n, s) => n + s.ms, 0) / 1000)).toBe(secs);
    expect(t.callsAt).toEqual({ a: 3 });
  });

  it("keeps why only for a turn the server halted or that failed", () => {
    const why = { code: "model-error", message: "boom" };
    expect(turnClock(0).end({ reason: "failed", at: 5 }, "", why).why).toEqual(why);
    expect(turnClock(0).end({ reason: "stopped", at: 5 }, "", why).why).toBeUndefined();
  });
});
