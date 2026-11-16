// The chat list and each chat at the client boundary. A pushed row applies when its list number is
// newer than the list and the row the window shows, so a list read before it never undoes it, and
// no push makes the window read the list again. A chat's messages are read only for the chat on
// screen when a push names a newer number for them; a reconnect reads the list once and a cached
// chat only if its number moved.
import { afterEach, expect, it, vi } from "vitest";
import { type Message, type MethodName, type Params, type SyncMetadata, type Thread, chatScope } from "@gates-local/contracts";
import { installBrowser, tick, until, type FakeServer } from "../../../test/harness.ts";

type Request = Parameters<FakeServer["handle"]>[1];
const row = (id: string, title = `Chat ${id}`): Thread => ({ id, title, createdAt: 1, updatedAt: 1 });
const said = (threadId: string, content: string, n: number): Message => ({ id: `${threadId}-${n}`, threadId, role: "user", content, createdAt: n });

/**
 * The thread store as the real server numbers it: every write takes the next list number, a write
 * to a chat's messages also becomes that chat's number, and each read answers with the numbers as
 * they were when it was handled (a held answer delivered late carries old ones).
 */
function threadStore(server: FakeServer, ids: readonly string[]) {
  let epoch = "first-process";
  server.epoch = epoch;
  let list = 0;
  const chat = new Map<string, number>();
  const rows = new Map<string, Thread>();
  const messages = new Map<string, Message[]>();
  const numbers = (chats: readonly string[]): SyncMetadata => ({ epoch, changes: [
    { scope: "threads", kind: "snapshot", rev: list },
    ...chats.map(id => ({ scope: chatScope(id), kind: "snapshot" as const, rev: chat.get(id) ?? 0 })),
  ] });
  const holds = new Map<MethodName, (send: () => void) => void>();
  const base = server.handle.bind(server);
  server.handle = (socket, request: Request) => {
    let result: unknown;
    let sync: SyncMetadata;
    if (request.method === "threads.list") {
      result = [...rows.values()];
      sync = numbers([...rows.keys()]);
    } else if (request.method === "threads.get") {
      const { threadId } = request.params as Params<"threads.get">;
      result = { thread: rows.get(threadId), messages: [...messages.get(threadId) ?? []] };
      sync = numbers([threadId]);
    } else return base(socket, request);
    server.log.push(request);
    const send = () => socket.frame({ type: "response", id: request.id, ok: true, result, sync });
    const held = holds.get(request.method);
    holds.delete(request.method);
    if (held) held(send);
    else send();
  };
  const push = (threadId: string) => {
    const sync = numbers([threadId]);
    server.push("threads.changed", { threadId, thread: rows.get(threadId) ?? null }, sync);
  };
  const write = (threadId: string, change: (n: number) => void, toMessages: boolean) => {
    list += 1;
    change(list);
    if (toMessages) chat.set(threadId, list);
    push(threadId);
  };
  for (const id of ids) {
    list += 1;
    rows.set(id, row(id));
    messages.set(id, [said(id, `first in ${id}`, list)]);
    chat.set(id, list);
  }
  return {
    /** Another window renames the chat: its row changes, its messages do not. */
    rename: (threadId: string, title: string) => write(threadId, () => rows.set(threadId, row(threadId, title)), false),
    /** Another window adds a message to the chat. */
    say: (threadId: string, content: string) => write(threadId, n => messages.set(threadId, [...messages.get(threadId) ?? [], said(threadId, content, n)]), true),
    /** Another window deletes the chat. */
    remove: (threadId: string) => write(threadId, () => { rows.delete(threadId); messages.delete(threadId); }, true),
    /** A write while no window is connected: nothing is pushed. */
    sayUnseen: (threadId: string, content: string) => {
      list += 1;
      messages.set(threadId, [...messages.get(threadId) ?? [], said(threadId, content, list)]);
      chat.set(threadId, list);
    },
    /** The server restarted: a new epoch, every number from the start. */
    restart: () => { epoch = "second-process"; server.epoch = epoch; },
    /** The next call of `method` is answered when the test says, with the numbers it was handled at. */
    hold: (method: "threads.list" | "threads.get") => new Promise<() => void>(resolve => holds.set(method, resolve)),
  };
}

let close: (() => void) | undefined;
let server: FakeServer | undefined;
afterEach(async () => {
  close?.(); close = undefined;
  if (server !== undefined) {
    server.accepting = false;
    for (const socket of server.sockets) socket.close();
  }
  await tick();
  vi.unstubAllGlobals();
});

async function boot(ids: readonly string[]) {
  const browser = installBrowser();
  server = browser.server;
  const store = threadStore(browser.server, ids);
  vi.resetModules();
  const session = await import("./index.ts");
  const state = await import("../store/store.ts");
  return { browser, store, session, state };
}

type World = Awaited<ReturnType<typeof boot>>;
const reads = (w: World, method: "threads.list" | "threads.get") => w.browser.server.calls(method).length;
const getsOf = (w: World, threadId: string) => w.browser.server.calls("threads.get").filter(r => (r.params as Params<"threads.get">).threadId === threadId).length;
const shown = (w: World, threadId: string) => w.state.getState().messages[threadId]?.map(m => m.content);

async function connected(w: World): Promise<void> {
  close = w.session.connect();
  await until(() => w.state.getState().conn.kind === "open" && w.state.getState().imageStatus !== undefined && w.state.getState().threads.length > 0, 4000, "hydrated");
}

async function open(w: World, threadId: string): Promise<void> {
  w.session.openThread(threadId);
  await until(() => w.state.getState().messages[threadId] !== undefined, 2000, `chat ${threadId} shown`);
  await tick();
}

/** Drop the socket and wait for the next one's hydrate to have read the list. */
async function reconnect(w: World): Promise<void> {
  const sockets = w.browser.server.sockets.length;
  const lists = reads(w, "threads.list");
  w.browser.server.socket.close();
  await until(() => w.browser.server.sockets.length > sockets && reads(w, "threads.list") > lists && w.state.getState().conn.kind === "open", 4000, "reconnected");
  await tick(); await tick();
}

it("a rename in another window applies its row and makes no threads.list or threads.get call here", async () => {
  const w = await boot(["a", "b"]);
  await connected(w);
  await open(w, "a");
  const before = { lists: reads(w, "threads.list"), gets: reads(w, "threads.get") };
  w.store.rename("b", "Renamed in window 2");
  w.store.rename("a", "The open one renamed");
  await until(() => w.state.getState().threads.some(t => t.title === "Renamed in window 2"), 2000, "row applied");
  await tick();
  expect(w.state.getState().threads.find(t => t.id === "a")?.title).toBe("The open one renamed");
  expect({ lists: reads(w, "threads.list"), gets: reads(w, "threads.get") }).toEqual(before);
});

it("a list read before a pushed row never undoes it, and a deleted chat stays deleted", async () => {
  const w = await boot(["a", "b", "c"]);
  const listing = w.store.hold("threads.list");
  close = w.session.connect();
  const answer = await listing;
  // the list was handled at its number; these rows come after it
  w.store.rename("a", "Renamed after the read");
  w.store.remove("b");
  await tick();
  answer();
  await until(() => w.state.getState().imageStatus !== undefined && w.state.getState().threads.length > 0, 4000, "hydrated");
  await tick();
  const threads = w.state.getState().threads;
  expect(threads.map(t => t.id).toSorted()).toEqual(["a", "c"]);
  expect(threads.find(t => t.id === "a")?.title).toBe("Renamed after the read");
});

it("a message written in another window reads the open chat once, and another chat only when it is opened", async () => {
  const w = await boot(["a", "b"]);
  await connected(w);
  await open(w, "b");
  await open(w, "a");
  const gets = { a: getsOf(w, "a"), b: getsOf(w, "b") };
  w.store.say("a", "new in a");
  await until(() => shown(w, "a")?.includes("new in a") === true, 2000, "the open chat read again");
  w.store.say("b", "new in b");
  w.store.rename("b", "b renamed");
  await tick(); await tick();
  expect({ a: getsOf(w, "a"), b: getsOf(w, "b") }, "the closed chat is not read when it changes").toEqual({ a: gets.a + 1, b: gets.b });
  await open(w, "b");
  await until(() => shown(w, "b")?.includes("new in b") === true, 2000, "b read on its visit");
  expect(getsOf(w, "b")).toBe(gets.b + 1);
  // back to a, which did not move: its copy is used
  await open(w, "a");
  expect(getsOf(w, "a")).toBe(gets.a + 1);
});

it("a reconnect with ten chats loaded reads the list once and a chat only if its number moved", async () => {
  const ids = Array.from({ length: 10 }, (_, i) => `c${i}`);
  const w = await boot(ids);
  await connected(w);
  for (const id of ids) await open(w, id);
  const at = { lists: reads(w, "threads.list"), gets: reads(w, "threads.get") };

  await reconnect(w);
  for (const id of ids) await open(w, id);
  const unchanged = { lists: reads(w, "threads.list") - at.lists, gets: reads(w, "threads.get") - at.gets };
  expect(unchanged, "nothing changed while the socket was down").toEqual({ lists: 1, gets: 0 });

  w.store.sayUnseen("c3", "written while this window was away");
  const again = { lists: reads(w, "threads.list"), gets: reads(w, "threads.get") };
  await reconnect(w);
  for (const id of ids) await open(w, id);
  expect({ lists: reads(w, "threads.list") - again.lists, gets: reads(w, "threads.get") - again.gets }, "one chat changed while away").toEqual({ lists: 1, gets: 1 });
  expect(shown(w, "c3")).toContain("written while this window was away");
});

it("after the server restarted, every cached chat is read again on its visit", async () => {
  const w = await boot(["a", "b"]);
  await connected(w);
  await open(w, "b");
  await open(w, "a");
  const gets = reads(w, "threads.get");
  w.store.restart();
  await reconnect(w);
  await open(w, "b");
  await open(w, "a");
  expect(reads(w, "threads.get") - gets).toBe(2);
});
