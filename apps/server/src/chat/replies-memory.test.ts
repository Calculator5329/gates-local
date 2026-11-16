import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Message, ReplyChange } from "@gates-local/contracts";
import { describe, expect, it, onTestFinished } from "vitest";
import { entry, sentFree, waits } from "./queue-testing.ts";
import { type Ready, type RepliesDeps, createReplies } from "./replies.ts";

const idle: Ready = { chat: true, anyWork: false, busy: () => false };
const question = (id: string, threadId = "t1"): Message => ({ id, threadId, role: "user", content: id, createdAt: 1 });
const WARM = { cold: false, drawing: false };
const CLOCK = { stage: "waiting", startedAt: 5, workMs: 0, toolMs: 0, attempt: 1, spans: [], callsAt: {} } as const;
const PICTURE = { draw: { preset: "sdxl", width: 1024, height: 1024 } };

function store(file?: string, more: Partial<RepliesDeps> = {}) {
  const heard: ReplyChange[] = [];
  const cuts: string[] = [];
  const q = createReplies({
    file, log: () => undefined, told: (c) => heard.push(c), saved: () => undefined, deleting: () => false, closing: () => false,
    cut: (turnId) => cuts.push(turnId), clock: () => undefined, ...more,
  });
  const running = (turnId: string, threadId = "t1") => {
    waits(q, entry(turnId, threadId));
    expect(q.take(turnId, turnId, 1)).toBe(1);
    q.begun(turnId);
    expect(q.started(turnId, 1, question(`m-${turnId}`, threadId), "m", WARM)).toBe(true);
  };
  return { q, heard, cuts, running };
}

function dataFile(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "gl-replies-memory-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "queue.json");
}

describe("what the server remembers of messages that left", () => {
  it("past a thousand removed messages the oldest removal is forgotten first: a window sending it again is taken, the rest are still refused", () => {
    const { q } = store();
    for (let i = 0; i <= 1000; i += 1) {
      waits(q, entry(`r${i}`));
      expect(q.remove({ id: `r${i}` }).answer).toBe("done");
    }
    expect(waits(q, entry("r1000"))).toBe("removed");
    expect(waits(q, entry("r1"))).toBe("removed");
    expect(waits(q, entry("r0"))).toBe("ok");
  });

  it("past a thousand ended messages the oldest is forgotten first: a window sending it again is taken, the rest are told they were sent", () => {
    const { q } = store();
    for (let i = 0; i <= 1000; i += 1) {
      const id = `e${i}`;
      sentFree(q, id);
      expect(q.started(id, 1, question(`m-${id}`), "m", WARM)).toBe(true);
      q.ended(id, { how: "done", replyId: `r-${id}` }, 2);
    }
    expect(waits(q, entry("e1000"))).toBe("sent");
    expect(waits(q, entry("e1"))).toBe("sent");
    expect(waits(q, entry("e0"))).toBe("ok");
  });

  it("a message whose question is saved leaves the queue's file at once, so a restart does not bring it back", () => {
    const file = dataFile();
    const { q } = store(file);
    waits(q, entry("a"));
    expect(q.take("a", "turn-a", 1)).toBe(1);
    q.begun("turn-a");
    expect((JSON.parse(readFileSync(file, "utf8")) as { entries: { id: string }[] }).entries.map((e) => e.id)).toEqual(["a"]);
    expect(q.started("turn-a", 1, question("m-a"), "m", WARM)).toBe(true);
    q.notify();
    expect((JSON.parse(readFileSync(file, "utf8")) as { entries: unknown[] }).entries).toEqual([]);
    expect(store(file).q.list()).toEqual([]);
  });

  it("the moment a Stop cut a reply's work is kept after the reply ends, until its work has left", () => {
    const { q, running } = store();
    running("turn-1");
    q.stop({ id: "turn-1" }, 7);
    expect(q.stoppedAt("turn-1")).toBe(7);
    q.ended("turn-1", { how: "stopped", by: { who: "person" } }, 8);
    expect(q.stoppedAt("turn-1")).toBe(7);
    q.left("turn-1");
    expect(q.stoppedAt("turn-1")).toBeUndefined();
  });
});

describe("when the windows hear and what goes next", () => {
  it("a reply's start and end reach the windows only when the app says so, after its own chat event", () => {
    const { q, heard } = store(undefined, { clock: () => CLOCK });
    waits(q, entry("a"));
    expect(q.take("a", "turn-a", 1)).toBe(1);
    q.begun("turn-a");
    const told = heard.length;
    expect(q.started("turn-a", 1, question("m-a"), "m", WARM)).toBe(true);
    expect(heard).toHaveLength(told);
    q.notify();
    expect(heard).toHaveLength(told + 1);
    expect(heard.at(-1)).toMatchObject({ kind: "is", reply: { id: "a", stage: "thinking" } });
    q.ended("turn-a", { how: "done", replyId: "r-a" }, 2);
    expect(heard).toHaveLength(told + 1);
    q.notify();
    expect(heard).toHaveLength(told + 2);
    expect(heard.at(-1)).toMatchObject({ kind: "is", reply: { id: "a", stage: "done", replyId: "r-a" } });
  });

  it("a Stop naming an earlier start of a message now on its way again holds what waits in its chat and leaves that reply alone", () => {
    const { q, cuts } = store(undefined, { clock: () => CLOCK });
    waits(q, entry("a"));
    expect(q.take("a", "turn-a1", 1)).toBe(1);
    q.refused("turn-a1", 1, { code: "wont-fit", message: "too big" });
    q.now({ id: "a" });
    expect(q.take("a", "turn-a2", 2)).toBe(2);
    q.begun("turn-a2");
    expect(q.started("turn-a2", 2, question("m-a"), "m", WARM)).toBe(true);
    waits(q, entry("b"));
    expect(q.stop({ id: "turn-a1" })).toEqual({ answer: "gone", why: "sent" });
    expect(q.list().map((e) => [e.id, e.held])).toEqual([["b", true]]);
    expect(cuts).toEqual([]);
    expect(q.of("turn-a2")).toMatchObject({ id: "a", stage: "thinking" });
  });

  it("a later message never passes an earlier one of its own chat that cannot go: not a picture behind a chat message, not a message behind one waiting on a retry", () => {
    const words = store();
    waits(words.q, entry("a"));
    waits(words.q, entry("p", "t1", PICTURE));
    expect(words.q.pick({ ...idle, chat: false })).toBeUndefined();

    const retry = store();
    retry.running("turn-1");
    waits(retry.q, entry("a"));
    retry.q.retrying("turn-1");
    waits(retry.q, entry("b"));
    waits(retry.q, entry("c", "t2"));
    expect(retry.q.pick(idle)?.id).toBe("c");
  });
});
