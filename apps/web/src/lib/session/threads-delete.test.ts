import { afterEach, expect, it, vi } from "vitest";
import type { Message, Params, ResultOf, Thread } from "@gates-local/contracts";
import { installBrowser, tick, until, type Browser } from "../../../test/harness.ts";

const row = (id: string): Thread => ({ id, title: `Chat ${id}`, createdAt: 1, updatedAt: 1 });
const said = (threadId: string, content: string): Message => ({ id: `${threadId}-said`, threadId, role: "user", content, createdAt: 1 });
const history = (threadId: string, content: string): ResultOf<"threads.get"> => ({ thread: row(threadId), messages: [said(threadId, content)] });

let browser: Browser | undefined;
let disconnect: (() => void) | undefined;

afterEach(async () => {
  disconnect?.(); disconnect = undefined;
  if (browser !== undefined) {
    browser.server.accepting = false;
    for (const socket of browser.server.sockets) socket.close();
  }
  browser = undefined;
  await tick();
  vi.unstubAllGlobals();
});

async function boot(ids: readonly string[]) {
  const b = installBrowser();
  browser = b;
  b.server.answer("threads.list", () => ids.map(row));
  b.server.answer("threads.get", ({ threadId }) => history(threadId, `saved in ${threadId}`));
  vi.resetModules();
  const session = await import("./index.ts");
  const store = await import("../store/store.ts");
  return { server: b.server, session, store };
}

type World = Awaited<ReturnType<typeof boot>>;

async function connect(w: World): Promise<void> {
  disconnect = w.session.connect();
  await until(() => w.store.getState().conn.kind === "open" && w.store.getState().imageStatus !== undefined && w.store.getState().threads.length > 0, 4000, "hydrated");
}

const getsOf = (w: World, threadId: string) =>
  w.server.calls("threads.get").filter((r) => (r.params as Params<"threads.get">).threadId === threadId).length;

const deletedElsewhere = (w: World, threadId: string) => w.server.push("threads.changed", { threadId, thread: null });

async function opened(w: World, threadId: string): Promise<void> {
  w.session.openThread(threadId);
  await until(() => w.store.getState().messages[threadId] !== undefined, 2000, `chat ${threadId} shown`);
  await tick();
}

it("a chat deleted in another window takes its load error with it", async () => {
  const w = await boot(["a", "b"]);
  await connect(w);
  w.server.answer("threads.get", () => { throw { code: "internal", message: "disk unreadable" }; });
  w.session.openThread("a");
  await until(() => w.store.getState().loadErrors["a"] !== undefined, 2000, "the load error shown");
  deletedElsewhere(w, "a");
  await until(() => !w.store.getState().threads.some((t) => t.id === "a"), 2000, "row gone");
  await tick();
  expect(w.store.getState().loadErrors["a"]).toBeUndefined();
});

it("a chat deleted in another window drops the history its hover read ahead, so it is never shown", async () => {
  const w = await boot(["a", "b"]);
  await connect(w);
  await opened(w, "a");
  w.session.preloadThread("b");
  await until(() => getsOf(w, "b") === 1, 2000, "b read ahead");
  await tick();
  expect(w.store.getState().messages["b"]).toBeUndefined();
  deletedElsewhere(w, "b");
  await until(() => !w.store.getState().threads.some((t) => t.id === "b"), 2000, "row gone");
  w.server.answer("threads.get", () => { throw { code: "thread-not-found", message: "gone" }; });
  w.session.openThread("b");
  await until(() => getsOf(w, "b") === 2, 2000, "b read on its visit");
  await tick();
  expect(w.store.getState().messages["b"]).toBeUndefined();
});

it("a chat on screen deleted in another window cannot come back from its read still on the way", async () => {
  const w = await boot(["a", "b"]);
  await connect(w);
  const holding = w.server.hold("threads.get");
  w.session.openThread("a");
  const held = await holding;
  deletedElsewhere(w, "a");
  await until(() => !w.store.getState().threads.some((t) => t.id === "a"), 2000, "row gone");
  held.respond(history("a", "from before the delete"));
  await tick();
  expect(w.store.getState().messages["a"]).toBeUndefined();
  expect(w.store.getState().threads.map((t) => t.id)).toEqual(["b"]);
});

it("a chat on screen deleted in another window leaves the screen for a new chat", async () => {
  const w = await boot(["a", "b"]);
  await connect(w);
  await opened(w, "a");
  expect(w.store.getState()).toMatchObject({ view: "thread", threadId: "a" });
  deletedElsewhere(w, "a");
  await until(() => !w.store.getState().threads.some((t) => t.id === "a"), 2000, "row gone");
  expect(w.store.getState()).toMatchObject({ view: "new", threadId: null });
});

it("a chat the list leaves out loses its model pick", async () => {
  const w = await boot(["a"]);
  w.store.setState({ threadModels: { a: "qwen3.5:9b", b: "gemma4:12b" } });
  await connect(w);
  await tick();
  expect(w.store.getState().threadModels).toEqual({ a: "qwen3.5:9b" });
});

it("the chat on screen keeps its model pick though the list leaves it out", async () => {
  const w = await boot(["a"]);
  w.store.setState({ view: "thread", threadId: "c", threadModels: { a: "qwen3.5:9b", c: "llama3.2:3b" } });
  w.server.answer("threads.get", ({ threadId }) => ({ thread: row(threadId), messages: [] }));
  await connect(w);
  await tick();
  expect(w.store.getState().threadModels["c"]).toBe("llama3.2:3b");
});

it("a saved image that cancels a hover read a click joined reads the chat again instead of waiting on its own reload", async () => {
  const w = await boot(["a", "b"]);
  await connect(w);
  await opened(w, "b");
  w.server.answer("threads.get", ({ threadId }) => history(threadId, "after the image"));
  const ahead = w.server.hold("threads.get");
  const reload = w.server.hold("threads.get");
  w.session.preloadThread("a");
  const hovered = await ahead;
  w.session.openThread("a");
  w.server.push("image.event", { jobId: "j1", threadId: "a", state: "running", progress: 0.4 });
  await reload;
  hovered.respond(history("a", "before the image"));
  await until(() => w.store.getState().messages["a"] !== undefined, 2000, "a shown");
  expect(w.store.getState().messages["a"]?.map((m) => m.content)).toEqual(["after the image"]);
});

it("a read ahead nobody opened is dropped when a newer number was named for its chat, not read again", async () => {
  const w = await boot(["a", "b"]);
  await connect(w);
  await opened(w, "b");
  const ahead = w.server.hold("threads.get");
  w.session.preloadThread("a");
  const hovered = await ahead;
  w.server.chatWritten("a");
  w.server.push("threads.changed", { threadId: "a", thread: row("a") });
  await tick();
  hovered.respond(history("a", "older than the push"));
  await tick(); await tick();
  expect(getsOf(w, "a")).toBe(1);
  expect(w.store.getState().messages["a"]).toBeUndefined();
  w.server.answer("threads.get", ({ threadId }) => history(threadId, "current"));
  await opened(w, "a");
  expect(getsOf(w, "a")).toBe(2);
  expect(w.store.getState().messages["a"]?.map((m) => m.content)).toEqual(["current"]);
});

it("a chat read before the connection's numbers were agreed counts as being at the newest number named for it", async () => {
  const w = await boot(["a", "b"]);
  w.server.chatWritten("a");
  await connect(w);
  const negotiating = w.server.hold("sync.negotiate");
  w.server.socket.close();
  await negotiating;
  const first = w.server.hold("threads.get");
  void w.server.hold("threads.get");
  w.session.openThread("a");
  const held = await first;
  held.respond(history("a", "read before the numbers"));
  await tick(); await tick();
  expect(getsOf(w, "a")).toBe(1);
  expect(w.store.getState().messages["a"]?.map((m) => m.content)).toEqual(["read before the numbers"]);
});
