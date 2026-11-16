import { describe, expect, it } from "vitest";
import type { Message } from "@gates-local/contracts";
import type { LiveTurn, TurnClock } from "../lib/store/store.ts";
import { reduceTurn, stopping, unfinished, withTurn, workMsAt } from "./turn.ts";

const T0 = 1_000_000;
const turn = (patch: Partial<LiveTurn> = {}): LiveTurn => ({ threadId: "A", turnId: "t1", model: "m", startedAt: T0, thinking: "", text: "", tools: [], ...patch });
const question: Message = { id: "u1", threadId: "A", role: "user", content: "hi", createdAt: 1 };
const answer: Message = { id: "a1", threadId: "A", role: "assistant", content: "done", createdAt: 2 };
const at = (secs: number) => T0 + secs * 1000;
const record = (patch: Partial<TurnClock> = {}): TurnClock => ({ stage: "waiting", startedAt: T0, workMs: 0, toolMs: 0, attempt: 1, spans: [], callsAt: {}, ...patch });

describe("reduceTurn", () => {
  // decision 33: the stage and the seconds are the server's record; this client only grows the work between pushes
  it("takes the server's reply record, and grows its work on this clock only while it thinks or runs a call", () => {
    const t = reduceTurn(turn(), { type: "reply", reply: record({ stage: "thinking", workMs: 2000 }) }, at(10))!;
    expect(t).toMatchObject({ reply: { stage: "thinking", workMs: 2000 }, replyAt: at(10) });
    expect(workMsAt(t, at(13))).toBe(5000);
    const writing = reduceTurn(t, { type: "reply", reply: record({ stage: "writing", workMs: 4000 }) }, at(12))!;
    expect(workMsAt(writing, at(30)), "the writing is not work").toBe(4000);
    expect(workMsAt(turn(), at(30)), "no record, no number").toBeUndefined();
  });

  it("a second attempt starts the reply over in the same place (decision 7)", () => {
    const first = turn({ text: "half", thinking: "t", tools: [{ callId: "c", name: "read", state: "done", summary: "Read" }], reply: record({ stage: "writing" }) });
    expect(reduceTurn(first, { type: "reply", reply: record({ stage: "writing", workMs: 3000 }) }, at(5))).toMatchObject({ text: "half", thinking: "t" });
    expect(reduceTurn(first, { type: "reply", reply: record({ stage: "waiting", attempt: 2 }) }, at(5))).toMatchObject({ text: "", thinking: "", tools: [], reply: { attempt: 2 } });
  });

  it("a reply is stopped by the server's record, with the record's seconds and work, whatever this client's clock says", () => {
    const thinking = reduceTurn(turn(), { type: "reply", reply: record({ stage: "thinking", workMs: 1000 }) }, at(10))!;
    // the server took the Stop 3 s after it started the reply; this client heard so at 12 s on its own clock
    const stopped = reduceTurn(thinking, { type: "reply", reply: record({ stage: "stopping", workMs: 3000, stoppedAt: at(3) }) }, at(12))!;
    expect(stopped).toMatchObject({ end: { kind: "stopped", secs: 3 }, reply: { stage: "stopping", workMs: 3000 } });
    expect(workMsAt(stopped, at(40))).toBe(3000);
    // a reply that failed ends its record with the work the server stamped on its question, or the record's own
    const stamped = { ...question, times: { startedAt: T0, spans: [], callsAt: {}, workMs: 4200, ended: { reason: "failed" as const, at: at(14) } } };
    expect(reduceTurn(thinking, { type: "error", code: "stream-error", message: "x", question: stamped }, at(14))?.reply).toMatchObject({ stage: "ended", workMs: 4200 });
    const failed = reduceTurn(thinking, { type: "error", code: "stream-error", message: "x" }, at(14))!;
    expect(failed.reply).toMatchObject({ stage: "ended", workMs: 1000 });
    expect(reduceTurn(failed, { type: "reply", reply: record({ stage: "thinking", workMs: 9000 }) }, at(15)), "a failed reply takes no later record").toBe(failed);
  });

  it("drops words after the turn ended here, but keeps a tool step", () => {
    const ended = turn({ text: "so far", end: { kind: "stopped", secs: 2 } });
    expect(reduceTurn(ended, { type: "delta", text: " more" }, at(3))).toBe(ended);
    expect(reduceTurn(ended, { type: "thinking", text: "more" }, at(3))).toBe(ended);
    const step = { callId: "c", name: "read", state: "done", summary: "Read" } as const;
    expect(reduceTurn(ended, { type: "tool", step }, at(3))?.tools).toEqual([step]);
  });

  it("updates a tool step in place by its call id", () => {
    const running = { callId: "c", name: "read", state: "running", summary: "Reading" } as const;
    const done = { ...running, state: "done", summary: "Read" } as const;
    const t = reduceTurn(reduceTurn(turn(), { type: "tool", step: running }, T0)!, { type: "tool", step: done }, T0);
    expect(t?.tools).toEqual([done]);
  });

  it("ends with an error that saved a partial: the saved row takes its place", () => {
    expect(reduceTurn(turn(), { type: "error", code: "internal", message: "x", partial: { ...answer, interrupted: true } }, T0)).toBeNull();
  });

  it("an error without a saved row keeps the turn with why it ended", () => {
    const beingStopped = turn({ end: { kind: "stopped", secs: 4 }, reply: record({ stage: "stopping", stoppedAt: at(4) }) });
    const ended = reduceTurn(beingStopped, { type: "error", code: "preempted", message: "Stopped so B could load." }, T0)!;
    expect(ended).toMatchObject({ end: { kind: "error", code: "preempted", message: "Stopped so B could load." }, reply: { stage: "ended" } });
    expect(stopping(ended)).toBe(false);
  });

  it("a cancel's seconds are the server's in every window: the record's Stop, or the end's time against the record's start", () => {
    // this client heard of the Stop 2 s after the server took it
    const stopped = reduceTurn(turn({ reply: record({ stage: "writing" }) }), { type: "reply", reply: record({ stage: "stopping", stoppedAt: at(4) }) }, at(6))!;
    expect(stopped.end).toEqual({ kind: "stopped", secs: 4 });
    expect(stopping(stopped)).toBe(true);
    const ended = reduceTurn(stopped, { type: "error", code: "cancelled", message: "c", ended: { reason: "stopped", at: at(4) } }, at(9))!;
    expect(ended).toMatchObject({ end: { kind: "stopped", secs: 4 }, reply: { stage: "ended", ended: { reason: "stopped", at: at(4) } } });
    expect(stopping(ended)).toBe(false);
    // the end came with no stopping record before it; it reached this client at 7 s
    expect(reduceTurn(turn({ reply: record({ stage: "writing" }) }), { type: "error", code: "cancelled", message: "c", ended: { reason: "stopped", at: at(6) } }, at(7))?.end).toEqual({ kind: "stopped", secs: 6 });
  });

  it("chat row 32: how a stopped reply ended is the server's word, not a guess from its code", () => {
    const stopped = reduceTurn(turn(), { type: "reply", reply: record({ stage: "stopping", stoppedAt: at(4) }) }, at(4))!;
    expect(reduceTurn(stopped, { type: "error", code: "cancelled", message: "m", ended: { reason: "stopped", at: at(4) } }, at(9))).toMatchObject({ end: { kind: "stopped", secs: 4 } });
    // the server stopped it for another model as the Stop reached it: that is why it ended
    expect(reduceTurn(stopped, { type: "error", code: "preempted", message: "Stopped so B could load.", ended: { reason: "preempted", at: at(4) } }, at(9)))
      .toMatchObject({ end: { kind: "error", code: "preempted", message: "Stopped so B could load." }, reply: { stage: "ended" } });
    expect(reduceTurn(stopped, { type: "error", code: "model-not-found", message: "HTTP 404", ended: { reason: "failed", at: at(5) } }, at(9))).toMatchObject({ end: { kind: "error", code: "model-not-found", message: "HTTP 404" }, reply: { stage: "ended" } });
    expect(reduceTurn(turn(), { type: "error", code: "stream-error", message: "m", ended: { reason: "failed", at: at(9) } }, at(9))?.end).toMatchObject({ kind: "error" });
  });

  it("only a record that carries the server's Stop stops a reply, and never one that already failed", () => {
    expect(reduceTurn(turn(), { type: "reply", reply: record({ stage: "writing" }) }, at(5))?.end).toBeUndefined();
    const failed = turn({ end: { kind: "error", code: "internal", message: "x" } });
    expect(reduceTurn(failed, { type: "reply", reply: record({ stage: "stopping", stoppedAt: at(2) }) }, at(5))).toBe(failed);
  });

  it("a turn made from another window's record takes its words like any other", () => {
    const theirs = turn({ userMessageId: "u0", model: "m0" });
    expect(reduceTurn(theirs, { type: "delta", text: "Hi" }, T0)).toMatchObject({ text: "Hi", userMessageId: "u0" });
  });
});

describe("the turn map", () => {
  it("replaces and removes one chat's turn", () => {
    const a = turn();
    const map = withTurn({}, "A", a);
    expect(map).toEqual({ A: a });
    expect(withTurn(map, "A", null)).toEqual({});
    expect(withTurn(map, "B", null)).toBe(map);
  });

  it("a reply is unfinished while it is written, and while the server is stopping it", () => {
    expect(unfinished(undefined)).toBe(false);
    expect(unfinished(turn())).toBe(true);
    expect(unfinished(turn({ end: { kind: "stopped", secs: 1 }, reply: record({ stage: "stopping", stoppedAt: at(1) }) }))).toBe(true);
    expect(unfinished(turn({ end: { kind: "stopped", secs: 1 }, reply: record({ stage: "ended", stoppedAt: at(1) }) }))).toBe(false);
    expect(unfinished(turn({ end: { kind: "stopped", secs: 1 } }))).toBe(false);
  });
});
