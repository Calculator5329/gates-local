import { describe, expect, it } from "vitest";
import type { Message } from "@gates-local/contracts";
import type { LiveTurn } from "../store.ts";
import { reduceTurn, unfinished, withTurn } from "./turn.ts";

const T0 = 1_000_000;
const turn = (patch: Partial<LiveTurn> = {}): LiveTurn => ({ gen: 1, threadId: "A", turnId: "t1", model: "m", startedAt: T0, thinking: "", text: "", tools: [], pendingUser: null, ...patch });
const question: Message = { id: "u1", threadId: "A", role: "user", content: "hi", createdAt: 1 };
const answer: Message = { id: "a1", threadId: "A", role: "assistant", content: "done", createdAt: 2 };
const at = (secs: number) => T0 + secs * 1000;

describe("reduceTurn", () => {
  it("measures thinking from the start to the first word, when that word arrives", () => {
    let t = reduceTurn(turn(), { type: "thinking", text: "hmm" }, at(1));
    t = reduceTurn(t!, { type: "delta", text: "Hi" }, at(5));
    expect(t).toMatchObject({ thinking: "hmm", text: "Hi", firstTokenAt: at(5), thinkingSecs: 5 });
    t = reduceTurn(t!, { type: "delta", text: " there" }, at(65));
    expect(t).toMatchObject({ text: "Hi there", firstTokenAt: at(5), thinkingSecs: 5 });
  });

  it("gives no thinking time to a reply that did not think, and at least one second to one that did", () => {
    expect(reduceTurn(turn(), { type: "delta", text: "Hi" }, at(3))?.thinkingSecs).toBeUndefined();
    expect(reduceTurn(turn({ thinking: "x" }), { type: "delta", text: "Hi" }, at(0.2))?.thinkingSecs).toBe(1);
  });

  it("drops words after the turn ended here, but keeps a notice and a tool step", () => {
    const ended = turn({ text: "so far", end: { kind: "stopped", secs: 2 } });
    expect(reduceTurn(ended, { type: "delta", text: " more" }, at(3))).toBe(ended);
    expect(reduceTurn(ended, { type: "thinking", text: "more" }, at(3))).toBe(ended);
    expect(reduceTurn(ended, { type: "delta", text: " more", contextNotice: "n" }, at(3))).toMatchObject({ text: "so far", contextNotice: "n" });
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

  it("a cancel keeps the time Stop showed, or measures it when the stop came from elsewhere", () => {
    const stopped = reduceTurn(turn(), { type: "stop" }, at(4));
    expect(stopped).toMatchObject({ end: { kind: "stopped", secs: 4 }, ending: true });
    expect(reduceTurn(stopped!, { type: "error", code: "cancelled", message: "c" }, at(9))).toMatchObject({ end: { kind: "stopped", secs: 4 }, ending: undefined });
    expect(reduceTurn(turn(), { type: "error", code: "cancelled", message: "c" }, at(7))?.end).toEqual({ kind: "stopped", secs: 7 });
  });

  it("a reply stopped here stays stopped when the server ends it with an error, as a cancel during a model load does", () => {
    const stopped = reduceTurn(turn(), { type: "stop" }, at(4));
    expect(reduceTurn(stopped!, { type: "error", code: "runtime_error", message: "This operation was aborted" }, at(9))).toMatchObject({ end: { kind: "stopped", secs: 4 }, ending: undefined });
    expect(reduceTurn(turn(), { type: "error", code: "runtime_error", message: "m" }, at(9))?.end).toMatchObject({ kind: "error" });
  });

  it("Stop on an ended turn changes nothing", () => {
    const ended = turn({ end: { kind: "error", code: "internal", message: "x" } });
    expect(reduceTurn(ended, { type: "stop" }, T0)).toBe(ended);
  });

  it("chat.send's answer gives the turn its id and its saved question", () => {
    const pending = turn({ turnId: null, pendingUser: "hi", early: { turnId: "t9", ended: false } });
    expect(reduceTurn(pending, { type: "sent", turnId: "t9", userMessageId: "u1" }, T0)).toMatchObject({ turnId: "t9", userMessageId: "u1", pendingUser: null, early: undefined });
  });

  it("a refused send keeps how it ended, without the question it waited to save", () => {
    const stopped = turn({ turnId: null, pendingUser: "hi", end: { kind: "stopped", secs: 1 }, ending: true, early: { turnId: "t9", ended: false } });
    expect(reduceTurn(stopped, { type: "refused" }, T0)).toMatchObject({ pendingUser: null, ending: undefined, early: undefined, end: { kind: "stopped", secs: 1 } });
  });

  it("remembers a turn the server started while the send waited, and its end", () => {
    const pending = turn({ turnId: null, pendingUser: "hi" });
    const seen = reduceTurn(pending, { type: "early", turnId: "t9", ended: false }, T0)!;
    expect(seen.early).toEqual({ turnId: "t9", ended: false });
    expect(reduceTurn(seen, { type: "early", turnId: "other", ended: true }, T0)).toBe(seen);
    expect(reduceTurn(seen, { type: "early", turnId: "t9", ended: true }, T0)?.early).toEqual({ turnId: "t9", ended: true });
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
