import { describe, expect, it } from "vitest";
import type { Message, ReplyRecord } from "@gates-local/contracts";
import type { LiveTurn } from "../store.ts";
import { reduceTurn, unfinished, withTurn, workMsAt } from "./turn.ts";

const T0 = 1_000_000;
const turn = (patch: Partial<LiveTurn> = {}): LiveTurn => ({ gen: 1, threadId: "A", turnId: "t1", model: "m", startedAt: T0, thinking: "", text: "", tools: [], pendingUser: null, ...patch });
const question: Message = { id: "u1", threadId: "A", role: "user", content: "hi", createdAt: 1 };
const answer: Message = { id: "a1", threadId: "A", role: "assistant", content: "done", createdAt: 2 };
const at = (secs: number) => T0 + secs * 1000;
const record = (patch: Partial<ReplyRecord> = {}): ReplyRecord => ({ stage: "waiting", startedAt: T0, workMs: 0, toolMs: 0, attempt: 1, spans: [], callsAt: {}, ...patch });

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

  it("a reply ended here holds its record still, and takes no later one", () => {
    const thinking = reduceTurn(turn(), { type: "reply", reply: record({ stage: "thinking", workMs: 1000 }) }, at(10))!;
    const stopped = reduceTurn(thinking, { type: "stop" }, at(12))!;
    expect(stopped.reply).toMatchObject({ stage: "ended", workMs: 3000 });
    expect(workMsAt(stopped, at(40))).toBe(3000);
    expect(reduceTurn(stopped, { type: "reply", reply: record({ stage: "thinking", workMs: 9000 }) }, at(13))).toBe(stopped);
    expect(reduceTurn(thinking, { type: "error", code: "stream-error", message: "x" }, at(14))?.reply).toMatchObject({ stage: "ended", workMs: 5000 });
    // a reply the connection cut off takes the server's record again
    const cut = reduceTurn(thinking, { type: "lost" }, at(11))!;
    expect(reduceTurn(cut, { type: "reply", reply: record({ stage: "writing", workMs: 6000 }) }, at(20))?.reply).toMatchObject({ stage: "writing", workMs: 6000 });
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

  it("ends with done, or an error that saved a partial: the saved row takes its place", () => {
    expect(reduceTurn(turn(), { type: "done", message: answer, stopReason: "stop" }, T0)).toBeNull();
    expect(reduceTurn(turn(), { type: "error", code: "internal", message: "x", partial: { ...answer, interrupted: true } }, T0)).toBeNull();
  });

  it("an error without a saved row keeps the turn with why it ended", () => {
    expect(reduceTurn(turn({ ending: true }), { type: "error", code: "preempted", message: "Stopped so B could load." }, T0)).toMatchObject({ end: { kind: "error", code: "preempted", message: "Stopped so B could load." }, ending: undefined });
  });

  it("a cancel keeps the time Stop showed, or takes the server's stop time when the stop came from elsewhere", () => {
    const stopped = reduceTurn(turn(), { type: "stop" }, at(4));
    expect(stopped).toMatchObject({ end: { kind: "stopped", secs: 4 }, ending: true });
    expect(reduceTurn(stopped!, { type: "error", code: "cancelled", message: "c", ended: { reason: "stopped", at: at(5) } }, at(9))).toMatchObject({ end: { kind: "stopped", secs: 4 }, ending: undefined });
    // stopped in another window at 6 s; the end reached this one at 7 s
    expect(reduceTurn(turn(), { type: "error", code: "cancelled", message: "c", ended: { reason: "stopped", at: at(6) } }, at(7))?.end).toEqual({ kind: "stopped", secs: 6 });
  });

  it("chat row 32: how a reply stopped here ended is the server's word, not a guess from its code", () => {
    const stopped = reduceTurn(turn(), { type: "stop" }, at(4))!;
    expect(reduceTurn(stopped, { type: "error", code: "cancelled", message: "m", ended: { reason: "stopped", at: at(4) } }, at(9))).toMatchObject({ end: { kind: "stopped", secs: 4 }, ending: undefined });
    // the server stopped it for another model before the Stop reached it: that is why it ended
    expect(reduceTurn(stopped, { type: "error", code: "preempted", message: "Stopped so B could load.", ended: { reason: "preempted", at: at(4) } }, at(9)))
      .toMatchObject({ end: { kind: "error", code: "preempted", message: "Stopped so B could load." }, ending: undefined });
    expect(reduceTurn(stopped, { type: "error", code: "model-not-found", message: "HTTP 404", ended: { reason: "failed", at: at(5) } }, at(9))).toMatchObject({ end: { kind: "error", code: "model-not-found", message: "HTTP 404" }, ending: undefined });
    expect(reduceTurn(turn(), { type: "error", code: "stream-error", message: "m", ended: { reason: "failed", at: at(9) } }, at(9))?.end).toMatchObject({ kind: "error" });
  });

  it("Stop on an ended turn changes nothing", () => {
    const ended = turn({ end: { kind: "error", code: "internal", message: "x" } });
    expect(reduceTurn(ended, { type: "stop" }, T0)).toBe(ended);
  });

  it("chat.send's answer gives the turn its id; its start brings the saved question", () => {
    const pending = turn({ turnId: null, pendingUser: "hi" });
    const sent = reduceTurn(pending, { type: "sent", turnId: "t9" }, T0)!;
    expect(sent).toMatchObject({ turnId: "t9", pendingUser: "hi" });
    expect(sent.userMessageId).toBeUndefined();
    expect(reduceTurn(sent, { type: "start", model: "m", userMessage: question }, T0)).toMatchObject({ turnId: "t9", userMessageId: "u1", pendingUser: null });
  });

  it("a refused send keeps how it ended, without the question it waited to save", () => {
    const stopped = turn({ turnId: null, pendingUser: "hi", end: { kind: "stopped", secs: 1 }, ending: true });
    expect(reduceTurn(stopped, { type: "refused" }, T0)).toMatchObject({ pendingUser: null, ending: undefined, end: { kind: "stopped", secs: 1 } });
  });

  it("a dropped connection cuts off a running reply, and a stopped one stops waiting", () => {
    expect(reduceTurn(turn(), { type: "lost" }, T0)?.end).toMatchObject({ kind: "error", code: "closed" });
    expect(reduceTurn(turn({ end: { kind: "stopped", secs: 1 }, ending: true }), { type: "lost" }, T0)).toMatchObject({ end: { kind: "stopped", secs: 1 }, ending: undefined });
  });

  it("a cut-off reply runs again on turns.active and on the server's start snapshot, which replaces its words", () => {
    const cut = reduceTurn(turn({ text: "one ", thinking: "t" }), { type: "lost" }, T0)!;
    expect(reduceTurn(cut, { type: "running" }, T0)).toMatchObject({ end: undefined, text: "one " });
    expect(reduceTurn(cut, { type: "start", model: "m", userMessage: question }, T0)).toMatchObject({ end: undefined, text: "", thinking: "", tools: [], userMessageId: "u1" });
  });

  it("the start snapshot replaces the words of a reply turns.active already showed running again", () => {
    const revived = reduceTurn(reduceTurn(turn({ text: "one ", thinking: "t" }), { type: "lost" }, T0)!, { type: "running" }, T0)!;
    expect(reduceTurn(revived, { type: "start", model: "m", userMessage: question }, T0)).toMatchObject({ end: undefined, text: "", thinking: "", tools: [] });
  });

  it("a turn known only from turns.active becomes a turn like any other at its own first event", () => {
    const listed = turn({ listed: true });
    expect(reduceTurn(listed, { type: "running" }, T0)?.listed).toBe(true);
    expect(reduceTurn(listed, { type: "start", model: "m", userMessage: question }, T0)?.listed).toBeUndefined();
    expect(reduceTurn(listed, { type: "delta", text: "Hi" }, T0)).toMatchObject({ text: "Hi", listed: undefined });
  });

  it("a listed turn's start starts its clock; a turn already running keeps its own", () => {
    expect(reduceTurn(turn({ listed: true }), { type: "start", model: "m", userMessage: question }, at(20))?.startedAt).toBe(at(20));
    expect(reduceTurn(turn(), { type: "start", model: "m", userMessage: question }, at(20))?.startedAt).toBe(T0);
    expect(reduceTurn(turn({ listed: true }), { type: "running" }, at(20))?.startedAt).toBe(T0);
  });

  it("neither revives a reply stopped here", () => {
    const stopped = turn({ text: "one ", end: { kind: "stopped", secs: 1 } });
    expect(reduceTurn(stopped, { type: "running" }, T0)).toBe(stopped);
    expect(reduceTurn(stopped, { type: "start", model: "m", userMessage: question }, T0)).toMatchObject({ end: { kind: "stopped" }, text: "one " });
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

  it("a reply is unfinished while it is written, and while a Stop waits for the server", () => {
    expect(unfinished(undefined)).toBe(false);
    expect(unfinished(turn())).toBe(true);
    expect(unfinished(turn({ end: { kind: "stopped", secs: 1 }, ending: true }))).toBe(true);
    expect(unfinished(turn({ end: { kind: "stopped", secs: 1 } }))).toBe(false);
    expect(unfinished(turn({ listed: true })), "the server may drop a listed turn without a word").toBe(false);
  });
});
