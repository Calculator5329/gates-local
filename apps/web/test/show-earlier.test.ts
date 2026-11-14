// Show earlier against a reload of the same chat: whichever answer lands last, the reader keeps
// the earlier page they asked for.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Message } from "@gates-local/contracts";
import { methodSamples } from "@gates-local/contracts/testing";
import { installBrowser, tick, until, type Browser } from "./harness.ts";

let browser: Browser;
let session: typeof import("../src/session.ts");
let store: typeof import("../src/store.ts");
let disconnect: () => void;

const T = "long";
const saved: Message[] = Array.from({ length: 600 }, (_, i) => ({ id: `m${i}`, threadId: T, role: i % 2 ? "assistant" : "user", content: `message ${i}`, createdAt: i }));
/** The server's page: up to `limit` before `before`, from a question, and how many come before it. */
function page({ before, limit }: { before?: string; limit?: number }) {
  const end = before === undefined ? saved.length : saved.findIndex((m) => m.id === before);
  let start = limit === undefined ? 0 : Math.max(0, end - limit);
  while (start > 0 && saved[start]?.role !== "user") start--;
  return { thread: { ...methodSamples["threads.create"].result, id: T }, messages: saved.slice(start, end), earlier: start };
}

beforeEach(async () => {
  browser = installBrowser();
  vi.resetModules();
  session = await import("../src/session.ts");
  store = await import("../src/store.ts");
  disconnect = session.connect();
  await until(() => store.getState().imageStatus !== undefined && store.getState().conn.kind === "open");
  browser.server.answer("threads.list", () => [page({}).thread]);
  browser.server.answer("threads.get", (params) => page(params));
});

afterEach(async () => {
  disconnect(); browser.server.accepting = false;
  for (const socket of browser.server.sockets) socket.close();
  await tick(); vi.unstubAllGlobals();
});

const loaded = () => store.getState().messages[T]?.length ?? 0;

it.each(["the earlier page", "the reload"])("a reload asked while Show earlier is on its way keeps the earlier page when %s lands first", async (first) => {
  session.openThread(T);
  await until(() => loaded() === 200);
  expect(session.earlierOf(T)).toBe(400);
  const earlierAsk = browser.server.hold("threads.get");
  const reloadAsk = browser.server.hold("threads.get");
  const shown = session.loadEarlier(T);
  session.reloadThread(T);
  const [a, b] = await Promise.all([earlierAsk, reloadAsk]);
  expect(a.params).toMatchObject({ before: "m400" });
  expect(b.params).toMatchObject({ limit: 200 });
  if (first === "the earlier page") { a.respond(page(a.params)); await shown; b.respond(page(b.params)); }
  else { b.respond(page(b.params)); await tick(); a.respond(page(a.params)); await shown; }
  await until(() => loaded() === 400 && store.getState().messages[T]?.[0]?.id === "m200", 2000, "the earlier page kept");
  await tick();
  expect(loaded()).toBe(400);
  expect(store.getState().messages[T]?.map((m) => m.id)).toEqual(saved.slice(200).map((m) => m.id));
  expect(session.earlierOf(T)).toBe(200);
});
