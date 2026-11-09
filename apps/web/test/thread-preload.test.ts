import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Message } from "@gates-local/contracts";
import { methodSamples } from "@gates-local/contracts/testing";
import { installBrowser, tick, until, type Browser } from "./harness.ts";

let browser: Browser;
let session: typeof import("../src/session.ts");
let store: typeof import("../src/store.ts");
let disconnect: () => void;
const message = (threadId: string, content = threadId): Message => ({ id: `m-${threadId}`, threadId, role: "user", content, createdAt: 1 });
const snapshot = (threadId: string, content = threadId) => ({ thread: { ...methodSamples["threads.create"].result, id: threadId }, messages: [message(threadId, content)] });

beforeEach(async () => {
  browser = installBrowser();
  vi.resetModules();
  session = await import("../src/session.ts");
  store = await import("../src/store.ts");
  disconnect = session.connect();
  await until(() => store.getState().imageStatus !== undefined && store.getState().conn.kind === "open");
  browser.server.answer("threads.get", ({ threadId }) => snapshot(threadId));
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});

afterEach(async () => {
  vi.clearAllTimers(); vi.useRealTimers();
  disconnect(); browser.server.accepting = false;
  for (const socket of browser.server.sockets) socket.close();
  await tick(); vi.unstubAllGlobals();
});

const dwell = () => vi.advanceTimersByTimeAsync(180);
const gets = () => browser.server.calls("threads.get").map(call => {
  const params = call.params;
  if (typeof params !== "object" || params === null || !("threadId" in params) || typeof params.threadId !== "string") throw new Error("Invalid history request");
  return { threadId: params.threadId };
});

it("TC-01: a completed hover read installs fresh history over a stale visited thread after reconnect", async () => {
  browser.server.answer("threads.list", () => [snapshot("a").thread, snapshot("b").thread]);
  browser.server.answer("threads.get", ({ threadId }) => snapshot(threadId, threadId === "a" ? "old truth" : "b"));
  session.openThread("a"); await vi.advanceTimersByTimeAsync(0);
  session.openThread("b"); await vi.advanceTimersByTimeAsync(0);
  expect(store.getState().messages["a"]?.[0]?.content).toBe("old truth");

  browser.server.answer("threads.get", ({ threadId }) => snapshot(threadId, threadId === "a" ? "new truth" : "b"));
  vi.useRealTimers();
  const sockets = browser.server.sockets.length;
  browser.server.socket.close();
  await until(() => browser.server.sockets.length > sockets && gets().filter(params => params.threadId === "b").length === 2);
  await tick();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

  session.preloadThread("a"); await dwell();
  expect(gets().filter(params => params.threadId === "a")).toHaveLength(2);
  expect(store.getState().messages["a"]?.[0]?.content).toBe("old truth");
  session.openThread("a"); await vi.advanceTimersByTimeAsync(0);
  expect(store.getState().messages["a"]?.[0]?.content).toBe("new truth");
  expect(gets().filter(params => params.threadId === "a")).toHaveLength(2);
});

it("a clicked preload uses the click's navigation when its missing-thread failure arrives", async () => {
  const holding = browser.server.hold("threads.get");
  session.preloadThread("gone"); await dwell();
  const held = await holding;
  session.openThread("gone");
  held.fail("thread-not-found", "gone"); await vi.advanceTimersByTimeAsync(0);
  expect(store.getState()).toMatchObject({ view: "new", threadId: null });
});

it("does not fetch during a sweep or for the active thread, and keeps hover history outside the displayed store", async () => {
  store.setState({ view: "thread", threadId: "active", messages: { active: [] } });
  session.preloadThread("active"); await dwell();
  session.preloadThread("a"); await vi.advanceTimersByTimeAsync(80);
  session.preloadThread("b"); await vi.advanceTimersByTimeAsync(80);
  session.preloadThread(null); await dwell();
  expect(gets()).toEqual([]);
  session.preloadThread("a"); await dwell();
  expect(gets()).toEqual([{ threadId: "a" }]);
  expect(store.getState().messages["a"]).toBeUndefined();
  session.openThread("a"); await vi.advanceTimersByTimeAsync(0);
  expect(gets()).toEqual([{ threadId: "a" }]);
  expect(store.getState().messages["a"]).toEqual([message("a")]);
});

it.each([true, false])("a thread menu suppresses hover work (menu opened before hover: %s)", async (alreadyOpen) => {
  const openMenu = () => store.setState({ pop: { id: "thread", thread: "a", kb: false } });
  if (alreadyOpen) openMenu();
  session.preloadThread("a");
  if (!alreadyOpen) { await vi.advanceTimersByTimeAsync(80); openMenu(); }
  await dwell();
  expect(gets()).toEqual([]);
  store.setState({ pop: null }); await dwell();
  expect(gets()).toEqual([]);
  session.preloadThread("a"); await dwell();
  expect(gets()).toEqual([{ threadId: "a" }]);
});

it.each([true, false])("an export's deletion wait settles after the thread's action (delete succeeds: %s)", async (succeeds) => {
  store.setState({ threads: [snapshot("a").thread] });
  const holding = browser.server.hold("threads.delete");
  const deletion = session.deleteThread("a");
  const held = await holding;
  let settled = false;
  const waiting = session.waitForThreadDeletion("a").then(() => { settled = true; });
  await session.waitForThreadDeletion("other");
  await vi.advanceTimersByTimeAsync(0);
  expect(settled).toBe(false);
  if (succeeds) held.respond({ threadId: "a" });
  else held.fail("internal", "delete failed");
  await deletion; await waiting;
  expect(settled).toBe(true);
  expect(store.getState().threads.some(t => t.id === "a")).toBe(!succeeds);
  await session.waitForThreadDeletion("a");
});

it("joins an in-flight preload on click, but only one speculative request can be outstanding", async () => {
  const holding = browser.server.hold("threads.get");
  session.preloadThread("a"); await dwell();
  const held = await holding;
  session.openThread("a");
  session.preloadThread("b"); await dwell();
  expect(gets()).toEqual([{ threadId: "a" }]);
  held.respond(snapshot("a")); await vi.advanceTimersByTimeAsync(0);
  expect(store.getState().messages["a"]).toEqual([message("a")]);
});

it("cancels an unused request's result on leave and does not retain it", async () => {
  const holding = browser.server.hold("threads.get");
  session.preloadThread("a"); await dwell();
  const held = await holding;
  session.preloadThread(null);
  held.respond(snapshot("a", "unused")); await vi.advanceTimersByTimeAsync(0);
  session.openThread("a"); await vi.advanceTimersByTimeAsync(0);
  expect(gets()).toEqual([{ threadId: "a" }, { threadId: "a" }]);
  expect(store.getState().messages["a"]).toEqual([message("a")]);
});

it("retains at most two speculative histories and rejects an oversized history", async () => {
  for (const id of ["a", "b", "c"]) { session.preloadThread(id); await dwell(); }
  session.openThread("a"); await vi.advanceTimersByTimeAsync(0);
  expect(gets().filter(params => params["threadId"] === "a")).toHaveLength(2);
  browser.server.answer("threads.get", ({ threadId }) => snapshot(threadId, "x".repeat(1_000_001)));
  session.preloadThread("huge"); await dwell();
  browser.server.answer("threads.get", ({ threadId }) => snapshot(threadId));
  session.openThread("huge"); await vi.advanceTimersByTimeAsync(0);
  expect(gets().filter(params => params["threadId"] === "huge")).toHaveLength(2);
  expect(store.getState().messages["huge"]).toEqual([message("huge")]);
});

it("thread changes invalidate completed and in-flight speculative history", async () => {
  session.preloadThread("a"); await dwell();
  browser.server.push("threads.changed", { threadId: "a" }); await vi.advanceTimersByTimeAsync(0);
  browser.server.answer("threads.get", ({ threadId }) => snapshot(threadId, "new truth"));
  session.openThread("a"); await vi.advanceTimersByTimeAsync(0);
  expect(store.getState().messages["a"]?.[0]?.content).toBe("new truth");
  const holding = browser.server.hold("threads.get");
  session.preloadThread("b"); await dwell();
  const held = await holding;
  session.openThread("b");
  browser.server.push("threads.changed", { threadId: "b" }); await vi.advanceTimersByTimeAsync(0);
  held.respond(snapshot("b", "old truth")); await vi.advanceTimersByTimeAsync(0);
  expect(store.getState().messages["b"]?.[0]?.content).toBe("new truth");
});

it("a new message invalidates a prefetched snapshot, and a confirmed delete cannot be resurrected by a pending load", async () => {
  session.preloadThread("a"); await dwell();
  browser.server.push("chat.event", { threadId: "a", turnId: "other", event: { type: "start", model: "gemma3:4b", userMessage: message("a", "new question") } });
  await vi.advanceTimersByTimeAsync(0);
  browser.server.answer("threads.get", ({ threadId }) => snapshot(threadId, "new question"));
  session.openThread("a"); await vi.advanceTimersByTimeAsync(0);
  expect(store.getState().messages["a"]?.[0]?.content).toBe("new question");
  const holding = browser.server.hold("threads.get");
  session.preloadThread("b"); await dwell(); const held = await holding;
  await session.deleteThread("b");
  held.respond(snapshot("b", "deleted")); await vi.advanceTimersByTimeAsync(0);
  expect(store.getState().messages["b"]).toBeUndefined();
});
