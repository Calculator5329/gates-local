import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Message, ReplyChange } from "@gates-local/contracts";
import { describe, expect, it, onTestFinished } from "vitest";
import { entry, sentFree, waits } from "./queue-testing.ts";
import { type Ready, type RepliesDeps, createReplies } from "./replies.ts";

const idle: Ready = { chat: true, anyWork: false, busy: () => false };
const busy = (...threads: string[]): Ready => ({ chat: true, anyWork: true, busy: (threadId) => threads.includes(threadId) });
const question = (id: string, threadId = "t1"): Message => ({ id, threadId, role: "user", content: id, createdAt: 1 });
const WARM = { cold: false, drawing: false };

/** The store alone: what its windows heard, and the works it cut. */
function store(file?: string, more: Partial<RepliesDeps> = {}) {
  const heard: ReplyChange[] = [];
  const cuts: string[] = [];
  const q = createReplies({
    file, log: () => undefined, told: (c) => heard.push(c), saved: () => undefined, deleting: () => false, closing: () => false,
    cut: (turnId) => cuts.push(turnId), clock: () => undefined, ...more,
  });
  /** A reply in `threadId` with its question saved, taken past what waits there: what a waiting message waits behind. */
  const running = (turnId: string, threadId = "t1") => {
    waits(q, entry(turnId, threadId));
    expect(q.take(turnId, turnId, 1)).toBe(1);
    q.begun(turnId);
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
    waits(q, entry("a"));
    waits(q, entry("b"));
    expect(q.pick(busy("t1"))).toBeUndefined();
    expect(q.pick(idle)?.id).toBe("a");
    q.edit({ id: "a", open: true }, 1);
    expect(q.pick(idle)?.id, "the one being edited keeps its place while the next goes").toBe("b");
    expect(q.take("b", "turn-b", 1)).toBe(1);
    expect(q.pick(idle), "an entry on its way is not sent twice").toBeUndefined();
    expect(q.started("turn-b", 1, question("m-b"), "m", WARM)).toBe(true);
    q.notify();
    expect(q.list().map((e) => e.id)).toEqual(["a"]);
    q.change({ id: "a", base: "m-a", messageId: "m-a2", text: "a, edited" }, 1);
    expect(q.pick(idle)).toMatchObject({ id: "a", words: { text: "a, edited", messageId: "m-a2" } });
  });

  it("a chat message waits for Ollama and a model; a picture does not", () => {
    const { q } = store();
    waits(q, entry("a", "t1", { waitFor: "download" }));
    expect(q.pick({ ...idle, chat: false })).toBeUndefined();
    q.remove({ id: "a" });
    waits(q, entry("p", "t1", { draw: { preset: "sdxl", width: 1024, height: 1024 } }));
    expect(q.pick({ ...idle, chat: false })?.id).toBe("p");
  });

  it("a message that cannot go does not hold up another chat's that can", () => {
    const { q } = store();
    waits(q, entry("a"));
    waits(q, entry("p", "t2", { draw: { preset: "sdxl", width: 1024, height: 1024 } }));
    waits(q, entry("c", "t3"));
    expect(q.pick({ ...idle, chat: false })?.id, "no chat model yet: the picture behind it goes").toBe("p");
    expect(q.pick({ ...idle, busy: (threadId) => threadId === "t1" })?.id, "its chat is still giving back what it took: the next chat's goes").toBe("p");
    expect(q.pick(idle)?.id, "when it can go, the oldest goes first").toBe("a");
  });

  it("a stopped or failed reply holds what waited behind it in its chat only; Send now goes first once its chat is free", () => {
    const { q, running, cuts } = store();
    running("turn-1");
    waits(q, entry("a"));
    waits(q, entry("b", "t2"));
    q.stop({ id: "turn-1" });
    expect(cuts, "the Stop cut the reply's work").toEqual(["turn-1"]);
    expect(q.list().map((e) => [e.id, e.held])).toEqual([["a", true], ["b", undefined]]);
    q.ended("turn-1", { how: "stopped", by: { who: "person" } }, 2);
    expect(q.pick(idle)?.id).toBe("b");
    q.now({ id: "a" });
    expect(q.list()[0]).toMatchObject({ id: "a", now: true });
    expect(q.list()[0]?.held).toBeUndefined();
    expect(q.pick(busy("t1")), "it waits for its own chat").toBeUndefined();
    expect(q.pick(busy("t2"))?.id, "not for another chat's reply").toBe("a");
  });

  it("behind a second attempt: held while it runs, sent when it finishes, held with the word when it fails too", () => {
    const { q, running } = store();
    waits(q, entry("a"));
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
    waits(q, entry("a", "t1", { waitFor: "setup" }));
    waits(q, entry("b"));
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

  it("Send now keeps its place for a refusal; refused before a turn, it holds what waited behind it", () => {
    const { q } = store();
    waits(q, entry("a"));
    waits(q, entry("b"));
    waits(q, entry("c"));
    q.now({ id: "b", consent: { kind: "named", replies: ["turn-x"] } });
    expect(q.list().map((e) => e.id), "the window shows it first; the server keeps its place").toEqual(["a", "b", "c"]);
    expect(q.pick(busy("t2"))?.id).toBe("b");
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
    waits(q, entry("a"));
    waits(q, entry("a"));
    waits(q, entry("z", "t1", { messageId: "m-a" }));
    expect(q.list()).toHaveLength(1);
    q.take("a", "turn-a", 1);
    q.begun("turn-a");
    expect(q.change({ id: "a", base: "m-a", messageId: "m-x", text: "x" }, 1).answer).toBe("sending");
    expect(q.remove({ id: "a" }).answer).toBe("sending");
    expect(q.list()).toHaveLength(1);
    expect(q.change({ id: "nope", base: "m-nope", messageId: "m-x", text: "x" }, 1)).toEqual({ answer: "gone", why: "unknown" });
    expect(heard).toHaveLength(2);
  });

  it("a taken message is listed as it was until its start is answered: a start refused before any work shows only the refusal", () => {
    const { q, heard } = store();
    waits(q, entry("a"));
    q.now({ id: "a" });
    const told = heard.length;
    const attempt = q.take("a", "turn-a", 1);
    expect(heard, "no window hears of a start that may be refused at once").toHaveLength(told);
    expect(q.list()[0]).toMatchObject({ id: "a", now: true });
    expect(q.list()[0]?.sending).toBeUndefined();
    expect(q.change({ id: "a", base: "m-a", messageId: "m-x", text: "x" }, 1).answer, "it is on its way all the same").toBe("sending");
    q.refused("turn-a", attempt!, { code: "would-stop", message: "a reply is running" });
    q.notify();
    expect(heard, "one change: the refusal").toHaveLength(told + 1);
    expect(heard.at(-1)).toMatchObject({ kind: "is", reply: { id: "a", stage: "held", held: { why: "refused", code: "would-stop" } } });
    // taken again, and answered this time
    q.now({ id: "a" });
    q.take("a", "turn-a2", 2);
    q.begun("turn-a");
    expect(q.list()[0]?.sending, "an older start's answer says nothing").toBeUndefined();
    q.begun("turn-a2");
    expect(heard.at(-1)).toMatchObject({ kind: "is", reply: { id: "a", stage: "starting", attempt: 2 } });
  });

  it("a Stop while a message is starting puts it back on hold at once, and the work of that start may write nothing", () => {
    const { q, cuts, heard } = store();
    waits(q, entry("a"));
    waits(q, entry("b"));
    const attempt = q.take("a", "turn-a", 1);
    expect(q.starting("turn-a", attempt!)).toBe(true);
    const told = heard.length;
    expect(q.stop({ id: "turn-a" })).toMatchObject({ answer: "done", reply: { id: "a", stage: "held", held: { why: "stopped" } } });
    expect(heard.slice(told).map((c) => (c.kind === "is" ? c.reply.id : c.id)), "every window hears of both in the same call").toEqual(["a", "b"]);
    expect(q.list().map((e) => [e.id, e.held, e.sending])).toEqual([["a", true, undefined], ["b", true, undefined]]);
    expect(cuts).toEqual(["turn-a"]);
    expect(q.starting("turn-a", attempt!), "the check its work makes before it saves").toBe(false);
    expect(q.started("turn-a", attempt!, question("m-a"), "m", WARM), "a save that came anyway moves nothing").toBe(false);
    expect(q.question("turn-a")).toBeUndefined();
    // taken again by Send now: a new start, and the old one's work still finds the record moved on
    q.now({ id: "a" });
    const again = q.take("a", "turn-a2", 2);
    expect(again).toBe(2);
    expect(q.starting("turn-a", attempt!)).toBe(false);
    expect(q.starting("turn-a2", again!)).toBe(true);
  });

  it("a removed message is not queued again, even by a window that missed the removal, and a restart keeps that", () => {
    const file = dataFile();
    const { q } = store(file);
    waits(q, entry("a"));
    expect(q.remove({ id: "a" }).answer).toBe("done");
    expect(waits(q, entry("a")), "a window that queued it before the removal asks again").toBe("removed");
    expect(q.list()).toEqual([]);
    expect(waits(store(file).q, entry("a")), "after a restart too").toBe("removed");
    expect(waits(q, entry("b"))).toBe("ok");
    q.dropThread("t1");
    expect(waits(q, entry("a", "t2")), "a deleted chat's memory goes with it").toBe("ok");
  });

  it("is kept on disk; one a closed app left comes back on hold, with nothing open or on its way", () => {
    const file = dataFile();
    const { q } = store(file);
    waits(q, entry("a", "t1", { images: ["data:image/png;base64,AAAA"] }));
    waits(q, entry("b", "t1", { waitFor: "download" }));
    q.edit({ id: "a", open: true }, 1);
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

  it("a save the disk refused is tried again at the next step, so a restart still finds the message", () => {
    const file = dataFile();
    const { q } = store(file);
    waits(q, entry("a"));
    mkdirSync(`${file}.tmp`);
    waits(q, entry("b"));
    rmSync(`${file}.tmp`, { recursive: true });
    q.notify();
    expect(store(file).q.list().map((e) => e.id)).toEqual(["a", "b"]);
  });

  it("a restart leaves out a waiting message whose question is already saved, and tells a late call it was sent", () => {
    const file = dataFile();
    const { q } = store(file);
    waits(q, entry("a"));
    waits(q, entry("b"));
    waits(q, entry("c", "t2"));
    // the app closed after a's question was saved and before its row left the file
    const inChat = (messageId: string): Message | undefined => (messageId === "m-a" ? question("m-a") : messageId === "m-c" ? question("m-c", "another chat") : undefined);
    const { q: again, heard } = store(file, { saved: inChat });
    expect(again.list(), "the one that was asked is not listed; a saved message of another chat with the same id does not count").toEqual([{ ...entry("b"), held: true }, { ...entry("c", "t2"), held: true }]);
    expect(again.remove({ id: "a" })).toEqual({ answer: "gone", why: "sent", question: question("m-a") });
    expect(waits(again, entry("a")), "a window that still has it is told it was sent, and not given it back").toBe("sent");
    expect(again.list().map((e) => e.id)).toEqual(["b", "c"]);
    // the file loses the row at the next change
    again.change({ id: "b", base: "m-b", messageId: "m-b2", text: "b, edited" }, 1);
    expect(heard).toHaveLength(1);
    expect((JSON.parse(readFileSync(file, "utf8")) as { entries: { id: string }[] }).entries.map((e) => e.id)).toEqual(["b", "c"]);
  });

  it("a deleted chat takes its queue with it", () => {
    const { q } = store();
    waits(q, entry("a"));
    waits(q, entry("b", "t2"));
    q.dropThread("t1");
    expect(q.list().map((e) => e.id)).toEqual(["b"]);
  });
});

describe("a picture's record", () => {
  it("lists the picture's jobs to every window while it is drawn, and while its Stop is taken", () => {
    const told: ReplyChange[] = [];
    const clock = { stage: "waiting", startedAt: 5, workMs: 0, toolMs: 0, attempt: 1, spans: [], callsAt: {} } as const;
    const { q } = store(undefined, { told: (c) => told.push(c), clock: () => clock });
    sentFree(q, "p1", { text: "a lighthouse" });
    q.begun("p1");
    expect(q.started("p1", 1, question("m-p1"), "preset", { cold: false, drawing: true, jobs: ["job-1", "job-2"] })).toBe(true);
    q.notify();
    const last = () => told.flatMap((c) => (c.kind === "is" ? [c.reply] : [])).at(-1);
    expect(last()).toMatchObject({ stage: "drawing", preset: "preset", jobs: ["job-1", "job-2"] });
    q.stop({ id: "p1" }, 9);
    expect(last()).toMatchObject({ stage: "drawing", jobs: ["job-1", "job-2"], stoppedAt: 9 });
  });
});
