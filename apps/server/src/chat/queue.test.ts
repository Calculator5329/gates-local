import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { type Entry, type Ready, createQueue } from "./queue.ts";

const entry = (id: string, threadId = "t1", more: Partial<Entry> = {}): Entry => ({ id, threadId, messageId: `m-${id}`, text: id, at: 1, waitFor: "reply", model: "m", numCtx: 4096, ...more });
const idle: Ready = { chat: true, anyTurn: false, busy: new Set() };
const busy = (...threads: string[]): Ready => ({ chat: true, anyTurn: true, busy: new Set(threads) });

function queue(file?: string) {
  const heard: (readonly Entry[])[] = [];
  return { q: createQueue({ file, changed: (l) => heard.push(l), log: () => undefined }), heard };
}

describe("the server's queue", () => {
  it("sends oldest first, one reply at a time, past nothing held or open in a composer", () => {
    const { q } = queue();
    q.add(entry("a"));
    q.add(entry("b"));
    expect(q.next(busy("t1"))).toBeUndefined();
    expect(q.next(idle)?.id).toBe("a");
    q.change("a", { editing: true });
    expect(q.next(idle)?.id, "the one being edited keeps its place while the next goes").toBe("b");
    q.sending("b", "turn-b");
    expect(q.next(idle), "an entry on its way is not sent twice").toBeUndefined();
    q.started("m-b");
    expect(q.list().map((e) => e.id)).toEqual(["a"]);
    q.change("a", { text: "a, edited", messageId: "m-a2", editing: false });
    expect(q.next(idle)).toMatchObject({ id: "a", text: "a, edited", messageId: "m-a2" });
  });

  it("a chat message waits for Ollama and a model; a picture does not", () => {
    const { q } = queue();
    q.add(entry("a", "t1", { waitFor: "download" }));
    expect(q.next({ ...idle, chat: false })).toBeUndefined();
    q.remove("a");
    q.add(entry("p", "t1", { draw: { preset: "sdxl", width: 1024, height: 1024 } }));
    expect(q.next({ ...idle, chat: false })?.id).toBe("p");
  });

  it("a stopped or failed reply holds what waited behind it in its chat only; Send now goes first once its chat is free", () => {
    const { q } = queue();
    q.add(entry("a"));
    q.add(entry("b", "t2"));
    q.ended("t1", "stopped");
    expect(q.list().map((e) => [e.id, e.held])).toEqual([["a", true], ["b", undefined]]);
    expect(q.next(idle)?.id).toBe("b");
    q.change("a", { now: true });
    expect(q.list()[0]).toMatchObject({ id: "a", now: true });
    expect(q.list()[0]?.held).toBeUndefined();
    expect(q.next(busy("t1")), "it waits for its own chat").toBeUndefined();
    expect(q.next(busy("t2"))?.id, "not for another chat's reply").toBe("a");
  });

  it("behind a second attempt: held while it runs, sent when it finishes, held with the word when it fails too", () => {
    const { q } = queue();
    q.add(entry("a"));
    q.retrying("t1");
    expect(q.list()[0]).toMatchObject({ held: true, retry: "running" });
    q.ended("t1", "done");
    expect(q.list()[0]?.held).toBeUndefined();
    q.retrying("t1");
    q.ended("t1", "failed-again");
    expect(q.list()[0]).toMatchObject({ held: true, retry: "failed" });
    // a finished reply does not release a message the person's Stop held
    q.ended("t1", "stopped");
    q.ended("t1", "done");
    expect(q.list()[0]).toMatchObject({ held: true });
  });

  it("a refused send goes back to its place on hold with why, and what waited behind it in its chat holds too", () => {
    const { q } = queue();
    q.add(entry("a", "t1", { waitFor: "setup" }));
    q.add(entry("b"));
    q.sending("a", "turn-a");
    expect(q.refused("turn-a", { code: "wont-fit", message: "too big" })).toBe(true);
    expect(q.list()).toMatchObject([{ id: "a", held: true, waitFor: "reply", why: { code: "wont-fit" } }, { id: "b", held: true }]);
    expect(q.list()[0]?.sending).toBeUndefined();
    expect(q.refused("turn-other", { code: "x", message: "" }), "another window's turn is not the queue's").toBe(false);
  });

  it("Send now keeps its place for a refusal; a Stop's hold does not hold it; refused before a turn, it holds what waited behind it", () => {
    const { q } = queue();
    q.add(entry("a"));
    q.add(entry("b"));
    q.add(entry("c"));
    q.change("b", { now: true, stopOthers: true, stopTurns: ["turn-x"] });
    expect(q.list().map((e) => e.id), "the window shows it first; the server keeps its place").toEqual(["a", "b", "c"]);
    expect(q.next(busy("t2"))?.id).toBe("b");
    q.change("b", { held: true });
    expect(q.list()[1], "a Stop's hold leaves a Send now alone").toMatchObject({ now: true, stopOthers: true, stopTurns: ["turn-x"] });
    q.turnless("b", { code: "would-stop", message: "a reply is running" });
    expect(q.list()).toMatchObject([{ id: "a", held: true }, { id: "b", held: true, why: { code: "would-stop" } }, { id: "c", held: true }]);
    expect(q.list()[1]?.now).toBeUndefined();
    expect(q.list()[1]?.stopTurns).toBeUndefined();
  });

  it("an entry whose turn has started cannot be changed or removed; a new id or saved message is not queued twice", () => {
    const { q, heard } = queue();
    q.add(entry("a"));
    q.add(entry("a"));
    q.add(entry("z", "t1", { messageId: "m-a" }));
    expect(q.list()).toHaveLength(1);
    q.sending("a", "turn-a");
    expect(q.change("a", { text: "x" })).toBe("sending");
    expect(q.remove("a")).toBe(false);
    expect(q.change("nope", { text: "x" })).toBeUndefined();
    expect(heard).toHaveLength(2);
  });

  it("a removed message is not queued again, even by a window that missed the removal, and a restart keeps that", () => {
    const root = path.join(os.homedir(), ".cache", "gates-local-tests");
    mkdirSync(root, { recursive: true });
    const dir = mkdtempSync(path.join(root, "queue-"));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, "queue.json");
    const { q } = queue(file);
    q.add(entry("a"));
    expect(q.remove("a")).toBe(true);
    expect(q.add(entry("a")), "a window that queued it before the removal asks again").toBe("removed");
    expect(q.list()).toEqual([]);
    expect(queue(file).q.add(entry("a")), "after a restart too").toBe("removed");
    expect(q.add(entry("b"))).toBe("ok");
    q.dropThread("t1");
    expect(q.add(entry("a", "t2")), "a deleted chat's memory goes with it").toBe("ok");
  });

  it("is kept on disk; one a closed app left comes back on hold, with nothing open or on its way", () => {
    const root = path.join(os.homedir(), ".cache", "gates-local-tests");
    mkdirSync(root, { recursive: true });
    const dir = mkdtempSync(path.join(root, "queue-"));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, "queue.json");
    const { q } = queue(file);
    q.add(entry("a", "t1", { images: ["data:image/png;base64,AAAA"] }));
    q.add(entry("b", "t1", { waitFor: "download" }));
    q.change("a", { editing: true });
    q.sending("b", "turn-b");
    const again = queue(file).q;
    expect(again.list()).toEqual([
      { ...entry("a", "t1", { images: ["data:image/png;base64,AAAA"] }), held: true },
      { ...entry("b"), held: true },
    ]);
    expect(again.next(idle)).toBeUndefined();
    // an entry that does not read is left out, not the whole queue
    const saved = JSON.parse(readFileSync(file, "utf8")) as { entries: unknown[] };
    writeFileSync(file, JSON.stringify({ version: 1, entries: [...saved.entries, { id: 3 }] }));
    expect(queue(file).q.list()).toHaveLength(2);
  });

  it("a deleted chat takes its queue with it", () => {
    const { q } = queue();
    q.add(entry("a"));
    q.add(entry("b", "t2"));
    q.dropThread("t1");
    expect(q.list().map((e) => e.id)).toEqual(["b"]);
  });
});
