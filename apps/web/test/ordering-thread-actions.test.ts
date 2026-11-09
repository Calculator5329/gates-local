import { expect, it, vi } from "vitest";
import type { Message, Thread } from "@gates-local/contracts";
import { installBrowser, type Held } from "./harness.ts";
import { drain } from "./ordering-world.ts";
import { replay } from "./ordering-replay.ts";

const original: Thread = { id: "t1", title: "Saved title", createdAt: 1, updatedAt: 2 };
const other: Thread = { ...original, id: "t2", title: "Other conversation", updatedAt: 1 };
const user: Message = { id: "u1", threadId: "t1", role: "user", content: "Question", createdAt: 1 };
const reply: Message = { ...user, id: "a1", role: "assistant", content: "Finished reply", model: "gemma3:4b", createdAt: 2 };

async function create() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const browser = installBrowser();
  browser.server.answer("threads.list", () => [original, other]);
  vi.resetModules();
  const session = await import("../src/session.ts");
  const store = await import("../src/store.ts");
  const close = session.connect();
  await drain();
  if (store.getState().imageStatus === undefined) throw new Error("Hydration did not finish");
  const loading = browser.server.hold("threads.get");
  session.openThread(original.id);
  await drain();
  const load = await loading;
  browser.server.push("chat.event", { threadId: "t1", turnId: "turn-1", event: { type: "start", model: "gemma3:4b", userMessage: user } });
  await drain();
  const renaming = browser.server.hold("threads.rename");
  void session.renameThread(original.id, "Rejected title");
  await drain();
  const rename = await renaming;
  const deleting = browser.server.hold("threads.delete");
  void session.deleteThread(original.id);
  await drain();
  const remove: Held<"threads.delete"> = await deleting;
  store.setState({ threadModels: { t1: "gemma3:4b" }, queued: [{ id: "q1", threadId: "t1", text: "Next question", at: 1, waitFor: "reply", held: true }] });
  return { browser, store, close, load, rename, remove };
}

it("failed thread actions preserve an open streaming/loading conversation across newer pushes", async () => {
  await replay({
    name: "thread actions: rejected rename/delete, history, finish and index push",
    create,
    events: [
      { name: "load.response", run: async w => { w.load.respond({ thread: original, messages: [] }); await drain(); } },
      { name: "rename.failure", run: async w => { w.rename.fail("internal", "rename refused"); await drain(); } },
      { name: "delete.failure", run: async w => { w.remove.fail("internal", "delete refused"); await drain(); } },
      { name: "index.push", run: async w => {
        w.browser.server.answer("threads.list", () => [{ ...original, title: "Other window's title" }, other]);
        w.browser.server.push("threads.changed", { threadId: original.id });
        await drain();
      } },
      { name: "reply.done", run: async w => {
        w.browser.server.push("chat.event", { threadId: "t1", turnId: "turn-1", event: { type: "done", message: reply, stopReason: "stop" } });
        await drain();
      } },
    ],
    check(w, order) {
      const state = w.store.getState();
      expect(state.threads.map(t => t.id), "a rejected delete must keep index order").toEqual(["t1", "t2"]);
      expect(state).toMatchObject({ view: "thread", threadId: "t1", threadModels: { t1: "gemma3:4b" }, queued: [{ id: "q1", text: "Next question" }] });
      expect(state.threads[0]?.title).toBe(order.includes("index.push") ? "Other window's title" : "Saved title");
      const lastFailure = order.findLast(name => name.endsWith("failure"));
      if (lastFailure) expect(state.notice).toContain(lastFailure === "delete.failure" ? "Couldn't delete this conversation" : "Couldn't rename this conversation");
      if (order.includes("reply.done")) expect(state.messages["t1"]?.find(m => m.id === reply.id)).toEqual(reply);
      else expect(state.turns["t1"]?.end).toBeUndefined();
    },
    async dispose(w) {
      w.close();
      w.browser.server.accepting = false;
      for (const socket of w.browser.server.sockets) socket.close();
      await drain();
      vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals();
    },
  }, { limit: 64, order: process.env["REPLAY_ORDER"] });
});
