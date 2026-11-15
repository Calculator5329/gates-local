import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Message } from "@gates-local/contracts";
import { describe, expect, it, onTestFinished } from "vitest";
import { type Entry, type Ready, type RepliesDeps, createReplies } from "./replies.ts";

const entry = (id: string, threadId = "t1", more: Partial<Entry> = {}): Entry => ({ id, threadId, messageId: `m-${id}`, text: id, at: 1, waitFor: "reply", model: "m", numCtx: 4096, ...more });
const idle: Ready = { chat: true, anyWork: false, busy: () => false };
const busy = (...threads: string[]): Ready => ({ chat: true, anyWork: true, busy: (threadId) => threads.includes(threadId) });
const question = (id: string, threadId = "t1"): Message => ({ id, threadId, role: "user", content: id, createdAt: 1 });
const WARM = { cold: false, drawing: false };

/** The store alone: what its windows heard, and the works it cut. */
function store(file?: string, more: Partial<RepliesDeps> = {}) {
  const heard: (readonly Entry[])[] = [];
  const cuts: string[] = [];
  const q = createReplies({
    file, log: () => undefined, changed: (l) => heard.push(l), saved: () => undefined, deleting: () => false, closing: () => false,
    cut: (turnId) => cuts.push(turnId), clock: () => undefined, ...more,
  });
  /** A reply a window sent itself in `threadId`, with its question saved: what a waiting message waits behind. */
  const running = (turnId: string, threadId = "t1") => {
    q.direct(turnId, threadId, { messageId: `m-${turnId}`, text: turnId, at: 1 }, false, 1);
    expect(q.started(turnId, 1, question(`m-${turnId}`, threadId), "m", WARM)).toBe(true);
  };
  return { q, heard, cuts, running };
}

function dataFile(): string {
  const root = path.join(os.homedir(), ".cache", "gates-local-tests");
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(path.join(root, "queue-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "queue.json");
}

describe("the server's record of every message", () => {
  it("sends oldest first, one reply at a time, past nothing held or open in a composer", () => {
    const { q } = store();
    q.add(entry("a"));
    q.add(entry("b"));
    expect(q.pick(busy("t1"))).toBeUndefined();
    expect(q.pick(idle)?.id).toBe("a");
    q.update("a", { editing: true }, 1);
    expect(q.pick(idle)?.id, "the one being edited keeps its place while the next goes").toBe("b");
    expect(q.take("b", "turn-b", 1)).toBe(1);
    expect(q.pick(idle), "an entry on its way is not sent twice").toBeUndefined();
    expect(q.started("turn-b", 1, question("m-b"), "m", WARM)).toBe(true);
    q.notify();
    expect(q.list().map((e) => e.id)).toEqual(["a"]);
    q.update("a", { text: "a, edited", messageId: "m-a2", editing: false }, 1);
    expect(q.pick(idle)).toMatchObject({ id: "a", words: { text: "a, edited", messageId: "m-a2" } });
  });

  it("a chat message waits for Ollama and a model; a picture does not", () => {
    const { q } = store();
    q.add(entry("a", "t1", { waitFor: "download" }));
    expect(q.pick({ ...idle, chat: false })).toBeUndefined();
    q.remove({ id: "a" });
    q.add(entry("p", "t1", { draw: { preset: "sdxl", width: 1024, height: 1024 } }));
    expect(q.pick({ ...idle, chat: false })?.id).toBe("p");
  });

  it("a message that cannot go does not hold up another chat's that can", () => {
    const { q } = store();
    q.add(entry("a"));
    q.add(entry("p", "t2", { draw: { preset: "sdxl", width: 1024, height: 1024 } }));
    q.add(entry("c", "t3"));
    expect(q.pick({ ...idle, chat: false })?.id, "no chat model yet: the picture behind it goes").toBe("p");
    expect(q.pick({ ...idle, busy: (threadId) => threadId === "t1" })?.id, "its chat is still giving back what it took: the next chat's goes").toBe("p");
    expect(q.pick(idle)?.id, "when it can go, the oldest goes first").toBe("a");
  });

  it("a stopped or failed reply holds what waited behind it in its chat only; Send now goes first once its chat is free", () => {
    const { q, running, cuts } = store();
    running("turn-1");
    q.add(entry("a"));
    q.add(entry("b", "t2"));
    q.stop({ id: "turn-1" });
    expect(cuts, "the Stop cut the reply's work").toEqual(["turn-1"]);
    expect(q.list().map((e) => [e.id, e.held])).toEqual([["a", true], ["b", undefined]]);
    q.ended("turn-1", { how: "stopped", by: { who: "person" } }, 2);
    expect(q.pick(idle)?.id).toBe("b");
    q.update("a", { now: true }, 1);
    expect(q.list()[0]).toMatchObject({ id: "a", now: true });
    expect(q.list()[0]?.held).toBeUndefined();
    expect(q.pick(busy("t1")), "it waits for its own chat").toBeUndefined();
    expect(q.pick(busy("t2"))?.id, "not for another chat's reply").toBe("a");
  });

  it("behind a second attempt: held while it runs, sent when it finishes, held with the word when it fails too", () => {
    const { q, running } = store();
    q.add(entry("a"));
    running("turn-1");
    q.retrying("turn-1");
    expect(q.list()[0]).toMatchObject({ held: true, retry: "running" });
    q.ended("turn-1", { how: "done" }, 2);
    expect(q.list()[0]?.held).toBeUndefined();
    running("turn-2");
    q.retrying("turn-2");
    q.ended("turn-2", { how: "failed", code: "model-error", message: "boom" }, 3);
    expect(q.list()[0]).toMatchObject({ held: true, retry: "failed" });
    // a finished reply does not release a message the person's Stop held
    running("turn-3");
    q.stop({ id: "turn-3" });
    q.ended("turn-3", { how: "done" }, 4);
    running("turn-4");
    q.ended("turn-4", { how: "done" }, 5);
    expect(q.list()[0]).toMatchObject({ held: true });
  });

  it("a refused send goes back to its place on hold with why, and what waited behind it in its chat holds too", () => {
    const { q } = store();
    q.add(entry("a", "t1", { waitFor: "setup" }));
    q.add(entry("b"));
    const attempt = q.take("a", "turn-a", 1);
    expect(attempt).toBe(1);
    q.refused("turn-a", 1, { code: "wont-fit", message: "too big" });
    q.notify();
    expect(q.list()).toMatchObject([{ id: "a", held: true, waitFor: "reply", why: { code: "wont-fit" } }, { id: "b", held: true }]);
    expect(q.list()[0]?.sending).toBeUndefined();
    const before = JSON.stringify(q.list());
    q.refused("turn-other", 1, { code: "x", message: "" });
    q.refused("turn-a", 2, { code: "x", message: "" });
    q.notify();
    expect(JSON.stringify(q.list()), "a refusal for another turn, or for a start that is over, changes nothing").toBe(before);
  });

  it("Send now keeps its place for a refusal; a Stop's hold does not hold it; refused before a turn, it holds what waited behind it", () => {
    const { q } = store();
    q.add(entry("a"));
    q.add(entry("b"));
    q.add(entry("c"));
    q.update("b", { now: true, stopOthers: true, stopTurns: ["turn-x"] }, 1);
    expect(q.list().map((e) => e.id), "the window shows it first; the server keeps its place").toEqual(["a", "b", "c"]);
    expect(q.pick(busy("t2"))?.id).toBe("b");
    q.update("b", { held: true }, 1);
    expect(q.list()[1], "a Stop's hold leaves a Send now alone").toMatchObject({ now: true, stopOthers: true, stopTurns: ["turn-x"] });
    expect(q.take("b", "turn-b", 1)).toBe(1);
    q.begun("turn-b");
    expect(q.list()[1], "on its way, it still says how it went").toMatchObject({ sending: "turn-b", now: true, stopOthers: true, stopTurns: ["turn-x"] });
    q.refused("turn-b", 1, { code: "would-stop", message: "a reply is running" });
    q.notify();
    expect(q.list()).toMatchObject([{ id: "a", held: true }, { id: "b", held: true, why: { code: "would-stop" } }, { id: "c", held: true }]);
    expect(q.list()[1]?.now).toBeUndefined();
    expect(q.list()[1]?.stopTurns).toBeUndefined();
  });

  it("an entry whose turn has started cannot be changed or removed; a new id or saved message is not queued twice", () => {
    const { q, heard } = store();
    q.add(entry("a"));
    q.add(entry("a"));
    q.add(entry("z", "t1", { messageId: "m-a" }));
    expect(q.list()).toHaveLength(1);
    q.take("a", "turn-a", 1);
    q.begun("turn-a");
    expect(q.update("a", { text: "x" }, 1)).toBe("sending");
    expect(q.remove({ id: "a" }).answer).toBe("sending");
    expect(q.list()).toHaveLength(1);
    expect(q.update("nope", { text: "x" }, 1)).toBeUndefined();
    expect(heard).toHaveLength(2);
  });

  it("a taken message is listed as it was until its start is answered: a start refused before any work shows only the refusal", () => {
    const { q, heard } = store();
    q.add(entry("a"));
    q.update("a", { now: true }, 1);
    const told = heard.length;
    const attempt = q.take("a", "turn-a", 1);
    expect(heard, "no window hears of a start that may be refused at once").toHaveLength(told);
    expect(q.list()[0]).toMatchObject({ id: "a", now: true });
    expect(q.list()[0]?.sending).toBeUndefined();
    expect(q.update("a", { text: "x" }, 1), "it is on its way all the same").toBe("sending");
    q.refused("turn-a", attempt!, { code: "would-stop", message: "a reply is running" });
    q.notify();
    expect(heard, "one change: the refusal").toHaveLength(told + 1);
    expect(heard.at(-1)).toMatchObject([{ id: "a", held: true, why: { code: "would-stop" } }]);
    // taken again, and answered this time
    q.update("a", { now: true }, 1);
    q.take("a", "turn-a2", 2);
    q.begun("turn-a");
    expect(q.list()[0]?.sending, "an older start's answer says nothing").toBeUndefined();
    q.begun("turn-a2");
    expect(heard.at(-1)).toMatchObject([{ id: "a", sending: "turn-a2", now: true }]);
  });

  it("a Stop while a message is starting puts it back on hold at once, and the work of that start may write nothing", () => {
    const { q, cuts, heard } = store();
    q.add(entry("a"));
    q.add(entry("b"));
    const attempt = q.take("a", "turn-a", 1);
    expect(q.starting("turn-a", attempt!)).toBe(true);
    const told = heard.length;
    expect(q.stop({ id: "turn-a" })).toMatchObject({ answer: "done", reply: { id: "a", stage: "held", held: { why: "stopped" } } });
    expect(heard.length, "every window hears in the same call").toBe(told + 1);
    expect(q.list().map((e) => [e.id, e.held, e.sending])).toEqual([["a", true, undefined], ["b", true, undefined]]);
    expect(cuts).toEqual(["turn-a"]);
    expect(q.starting("turn-a", attempt!), "the check its work makes before it saves").toBe(false);
    expect(q.started("turn-a", attempt!, question("m-a"), "m", WARM), "a save that came anyway moves nothing").toBe(false);
    expect(q.question("turn-a")).toBeUndefined();
    // taken again by Send now: a new start, and the old one's work still finds the record moved on
    q.update("a", { now: true }, 1);
    const again = q.take("a", "turn-a2", 2);
    expect(again).toBe(2);
    expect(q.starting("turn-a", attempt!)).toBe(false);
    expect(q.starting("turn-a2", again!)).toBe(true);
  });

  it("a removed message is not queued again, even by a window that missed the removal, and a restart keeps that", () => {
    const file = dataFile();
    const { q } = store(file);
    q.add(entry("a"));
    expect(q.remove({ id: "a" }).answer).toBe("done");
    expect(q.add(entry("a")), "a window that queued it before the removal asks again").toBe("removed");
    expect(q.list()).toEqual([]);
    expect(store(file).q.add(entry("a")), "after a restart too").toBe("removed");
    expect(q.add(entry("b"))).toBe("ok");
    q.dropThread("t1");
    expect(q.add(entry("a", "t2")), "a deleted chat's memory goes with it").toBe("ok");
  });

  it("is kept on disk; one a closed app left comes back on hold, with nothing open or on its way", () => {
    const file = dataFile();
    const { q } = store(file);
    q.add(entry("a", "t1", { images: ["data:image/png;base64,AAAA"] }));
    q.add(entry("b", "t1", { waitFor: "download" }));
    q.update("a", { editing: true }, 1);
    q.take("b", "turn-b", 1);
    const again = store(file).q;
    expect(again.list()).toEqual([
      { ...entry("a", "t1", { images: ["data:image/png;base64,AAAA"] }), held: true },
      { ...entry("b"), held: true },
    ]);
    expect(again.pick(idle)).toBeUndefined();
    // an entry that does not read is left out, not the whole queue
    const saved = JSON.parse(readFileSync(file, "utf8")) as { entries: unknown[] };
    writeFileSync(file, JSON.stringify({ version: 1, entries: [...saved.entries, { id: 3 }] }));
    expect(store(file).q.list()).toHaveLength(2);
  });

  it("a restart leaves out a waiting message whose question is already saved, and tells a late call it was sent", () => {
    const file = dataFile();
    const { q } = store(file);
    q.add(entry("a"));
    q.add(entry("b"));
    q.add(entry("c", "t2"));
    // the app closed after a's question was saved and before its row left the file
    const inChat = (messageId: string): Message | undefined => (messageId === "m-a" ? question("m-a") : messageId === "m-c" ? question("m-c", "another chat") : undefined);
    const { q: again, heard } = store(file, { saved: inChat });
    expect(again.list(), "the one that was asked is not listed; a saved message of another chat with the same id does not count").toEqual([{ ...entry("b"), held: true }, { ...entry("c", "t2"), held: true }]);
    expect(again.remove({ id: "a" })).toEqual({ answer: "gone", why: "sent", question: question("m-a") });
    expect(again.add(entry("a")), "a window that still has it is not given it back").toBe("ok");
    expect(again.list().map((e) => e.id)).toEqual(["b", "c"]);
    // the file loses the row at the next change
    again.update("b", { text: "b, edited" }, 1);
    expect(heard).toHaveLength(1);
    expect((JSON.parse(readFileSync(file, "utf8")) as { entries: { id: string }[] }).entries.map((e) => e.id)).toEqual(["b", "c"]);
  });

  it("a deleted chat takes its queue with it", () => {
    const { q } = store();
    q.add(entry("a"));
    q.add(entry("b", "t2"));
    q.dropThread("t1");
    expect(q.list().map((e) => e.id)).toEqual(["b"]);
  });
});
