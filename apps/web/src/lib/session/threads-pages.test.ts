import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@gates-local/contracts";
import { methodSamples } from "@gates-local/contracts/testing";
import { installBrowser, tick, until, type Browser } from "../../../test/harness.ts";

const T = "long";
const saved: Message[] = Array.from({ length: 600 }, (_, i) => ({ id: `m${i}`, threadId: T, role: i % 2 ? "assistant" : "user", content: `message ${i}`, createdAt: i }));
const threadRow = (id: string) => ({ ...methodSamples["threads.create"].result, id });

function pageOf(list: readonly Message[], { before, limit }: { before?: string; limit?: number }) {
  const end = before === undefined ? list.length : list.findIndex((m) => m.id === before);
  let start = limit === undefined ? 0 : Math.max(0, end - limit);
  while (start > 0 && list[start]?.role !== "user") start--;
  return { thread: threadRow(T), messages: list.slice(start, end), earlier: start };
}

const failingWith = (code: string, message: string) => Object.assign(new Error(message), { code });
const quietMedia = () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined });

describe("Export as Markdown", () => {
  it("an exported chat is its title as a heading, then each message under You or its model's name, with Thread and Reply when there is none", async () => {
    vi.resetModules();
    const store = await import("../store/store.ts");
    const { threadMarkdown } = await import("../../thread/threads.ts");
    store.setState({ threads: [{ ...threadRow("trip"), title: "Trip plan" }] });
    const rows: Message[] = [
      { id: "q", threadId: "trip", role: "user", content: "Where first?", createdAt: 1 },
      { id: "a", threadId: "trip", role: "assistant", content: "Lisbon.", model: "gemma3:4b", createdAt: 2 },
      { id: "b", threadId: "trip", role: "assistant", content: "Then Porto.", createdAt: 3 },
    ];
    expect(threadMarkdown("trip", rows)).toBe("# Trip plan\n\n## You\n\nWhere first?\n\n## Gemma 3 4B\n\nLisbon.\n\n## Reply\n\nThen Porto.\n");
    expect(threadMarkdown("unlisted", rows.slice(0, 1))).toBe("# Thread\n\n## You\n\nWhere first?\n");
  });
});

describe("earlier pages, failed loads and reloads", () => {
  let browser: Browser;
  let session: typeof import("./index.ts");
  let store: typeof import("../store/store.ts");
  let disconnect: () => void;

  const loaded = () => store.getState().messages[T]?.length ?? 0;
  const reads = () => browser.server.calls("threads.get").map((c) => c.params as { threadId: string; before?: string; limit?: number });
  const readsOf = (threadId: string) => reads().filter((p) => p.threadId === threadId).length;
  const openLong = async () => {
    session.openThread(T);
    await until(() => loaded() === 200, 2000, "the newest page");
  };

  beforeEach(async () => {
    browser = installBrowser();
    vi.resetModules();
    session = await import("./index.ts");
    store = await import("../store/store.ts");
    disconnect = session.connect();
    await until(() => store.getState().imageStatus !== undefined && store.getState().conn.kind === "open");
    browser.server.answer("threads.list", () => [threadRow(T)]);
    browser.server.answer("threads.get", (params) => pageOf(saved, params));
  });

  afterEach(async () => {
    disconnect(); browser.server.accepting = false;
    for (const socket of browser.server.sockets) socket.close();
    await tick(); vi.unstubAllGlobals();
  });

  it("asking for earlier messages twice while the first ask is out sends one read and both asks get its answer", async () => {
    await openLong();
    const holding = browser.server.hold("threads.get");
    const first = session.loadEarlier(T);
    const second = session.loadEarlier(T);
    expect(second).toBe(first);
    const held = await holding;
    held.respond(pageOf(saved, held.params));
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(reads().filter((p) => p.before !== undefined)).toHaveLength(1);
    expect(loaded()).toBe(400);
  });

  it("Show earlier answers true once the page is in front, and false without asking the server when there is nothing before", async () => {
    expect(await session.loadEarlier(T)).toBe(false);
    expect(readsOf(T)).toBe(0);
    await openLong();
    expect(await session.loadEarlier(T)).toBe(true);
    expect(store.getState().messages[T]?.[0]?.id).toBe("m200");
    expect(await session.loadEarlier(T)).toBe(true);
    expect(session.earlierOf(T)).toBe(0);
    const asked = readsOf(T);
    expect(await session.loadEarlier(T)).toBe(false);
    expect(readsOf(T)).toBe(asked);
    expect(loaded()).toBe(600);
  });

  it("an earlier page that lands after the chat was deleted is thrown away and the ask answers false", async () => {
    await openLong();
    const holding = browser.server.hold("threads.get");
    const shown = session.loadEarlier(T);
    const held = await holding;
    await session.deleteThread(T);
    held.respond(pageOf(saved, held.params));
    expect(await shown).toBe(false);
    await tick();
    expect(store.getState().messages[T]).toBeUndefined();
    expect(session.earlierOf(T)).toBe(0);
  });

  it("an earlier page whose starting message is gone reads the chat again instead of saying it failed", async () => {
    await openLong();
    const holding = browser.server.hold("threads.get");
    const shown = session.loadEarlier(T);
    const held = await holding;
    const whole = reads().filter((p) => p.before === undefined).length;
    held.fail("message-not-found", "m400 is gone");
    expect(await shown).toBe(false);
    await until(() => reads().filter((p) => p.before === undefined).length === whole + 1, 1000, "the chat read again");
    await tick();
    expect(store.getState().notice).toBeNull();
    expect(loaded()).toBe(200);
  });

  it("a reload that misses the earlier page asks again for everything loaded only once, even when the front was deleted meanwhile", async () => {
    await openLong();
    const earlierAsk = browser.server.hold("threads.get");
    const reloadAsk = browser.server.hold("threads.get");
    const shown = session.loadEarlier(T);
    session.reloadThread(T);
    const [a, b] = await Promise.all([earlierAsk, reloadAsk]);
    a.respond(pageOf(saved, a.params));
    expect(await shown).toBe(true);
    expect(store.getState().messages[T]?.[0]?.id).toBe("m200");
    const remaining = saved.filter((m) => m.id !== "m200" && m.id !== "m201");
    let answered = 0;
    browser.server.answer("threads.get", (params) => {
      answered++;
      if (answered > 1) throw failingWith("internal", "asked a third time");
      return pageOf(remaining, params);
    });
    b.respond(pageOf(remaining, b.params));
    await until(() => store.getState().messages[T]?.[0]?.id === "m198", 2000, "the wider answer shown");
    await tick();
    expect(answered).toBe(1);
    expect(reads().at(-1)).toMatchObject({ limit: 400 });
    expect(reads()).toHaveLength(4);
    expect(store.getState().messages[T]?.map((m) => m.id)).toEqual(remaining.slice(198).map((m) => m.id));
    expect(store.getState().loadErrors[T]).toBeUndefined();
  });

  it("a reload that fails keeps the chat's cached messages on screen, with the reason and a Retry beside it", async () => {
    await openLong();
    browser.server.answer("threads.get", () => { throw failingWith("internal", "store busy"); });
    session.reloadThread(T);
    await until(() => store.getState().loadErrors[T] !== undefined, 1000, "the failure");
    expect(loaded()).toBe(200);
    vi.stubGlobal("matchMedia", quietMedia);
    const { Timeline } = await import("../../thread/Thread.tsx");
    const html = renderToStaticMarkup(createElement(Timeline, { threadId: T }));
    expect(html).toContain("message 599");
    expect(html).toMatch(/data-load-error[^]*?<span>[^<]+<\/span>[^]*?data-testid="chat\.thread\.reload"[^>]*>\s*Retry/);
  });

  it("a list read before this window's delete does not bring the chat back, by the delete's own answer alone", async () => {
    const listing = browser.server.hold("threads.list");
    store.setState({ imageStatus: undefined });
    browser.server.socket.close();
    const list = await listing;
    await session.deleteThread(T);
    expect(store.getState().threads.some((t) => t.id === T)).toBe(false);
    list.respond([threadRow(T)]);
    await until(() => store.getState().imageStatus !== undefined, 3000, "hydration after reconnect");
    await tick();
    expect(store.getState().threads.some((t) => t.id === T)).toBe(false);
  });

  it("a new chat keeps the model it started on when it is opened again after the pick changed", async () => {
    browser.server.answer("threads.create", ({ title }) => ({ ...threadRow("fresh"), title: title ?? "" }));
    browser.server.answer("turn.start", ({ threadId, content }) => ({ turnId: "turn-fresh", userMessage: { id: "q-fresh", threadId, role: "user", content, createdAt: 1 } }));
    session.newThread();
    session.pickModel("gemma3:4b");
    void session.send("hello");
    await until(() => store.getState().threadId === "fresh", 2000, "the new chat");
    expect(store.getState().threadModels["fresh"]).toBe("gemma3:4b");
    session.newThread();
    session.pickModel("qwen3:14b");
    session.openThread("fresh");
    expect(store.getState().model).toBe("gemma3:4b");
  });

  it("a reply saved in a chat that is not open replays over its load in flight, and the chat is read again", async () => {
    const U = "elsewhere";
    const question: Message = { id: "q-u", threadId: U, role: "user", content: "hi", createdAt: 1 };
    const reply: Message = { id: "r-u", threadId: U, role: "assistant", content: "Theirs", createdAt: 2 };
    browser.server.answer("threads.get", ({ threadId }) => ({ thread: threadRow(threadId), messages: [question] }));
    session.openThread(U);
    await until(() => store.getState().messages[U] !== undefined, 1000, "the chat loaded");
    session.newThread();
    const olderHold = browser.server.hold("threads.get");
    session.reloadThread(U);
    const older = await olderHold;
    const before = readsOf(U);
    const nextHold = browser.server.hold("threads.get");
    browser.server.push("turn", { turnId: "theirs", threadId: U, event: { type: "start", model: "gemma3:4b", userMessage: question } });
    browser.server.push("turn", { turnId: "theirs", threadId: U, event: { type: "done", message: reply, stopReason: "stop" } });
    await until(() => readsOf(U) === before + 1, 1000, "the chat read after the reply");
    const next = await nextHold;
    older.respond({ thread: threadRow(U), messages: [question] });
    await tick();
    expect(store.getState().messages[U]?.map((m) => m.id)).toEqual(["q-u", "r-u"]);
    next.respond({ thread: threadRow(U), messages: [question, reply] });
    await tick();
    expect(store.getState().messages[U]?.map((m) => m.id)).toEqual(["q-u", "r-u"]);
  });

  it("a picture saved into a chat that is only on screen, with nothing cached after its load failed, reads it again", async () => {
    browser.server.answer("threads.get", () => { throw failingWith("internal", "store busy"); });
    session.openThread("shown");
    await until(() => store.getState().loadErrors["shown"] !== undefined, 1000, "the failure");
    expect(store.getState().messages["shown"]).toBeUndefined();
    browser.server.answer("threads.get", ({ threadId }) => ({ thread: threadRow(threadId), messages: [] }));
    browser.server.push("image.event", { jobId: "j1", threadId: "shown", state: "running" });
    await until(() => store.getState().messages["shown"] !== undefined, 1000, "the chat read again");
    expect(readsOf("shown")).toBe(2);
  });

  it("a picture saved into a chat still loading in the background reads it again", async () => {
    const holding = browser.server.hold("threads.get");
    session.openThread("loading");
    await holding;
    session.newThread();
    expect(store.getState().messages["loading"]).toBeUndefined();
    browser.server.push("image.event", { jobId: "j1", threadId: "loading", state: "running" });
    await until(() => readsOf("loading") === 2, 1000, "the chat read again");
  });

  it("a picture saved into a chat this window has never seen reads nothing", async () => {
    await openLong();
    browser.server.push("image.event", { jobId: "j1", threadId: "unseen", state: "running" });
    browser.server.push("image.event", { jobId: "j2", threadId: T, state: "running" });
    await until(() => readsOf(T) === 2, 1000, "the open chat read again");
    await tick();
    expect(readsOf("unseen")).toBe(0);
  });
});
