import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installBrowser, tick, until } from "./harness.ts";

let browser: ReturnType<typeof installBrowser>;
let store: typeof import("../src/store.ts");
let drafts: typeof import("../src/drafts.ts");
let session: typeof import("../src/session.ts");
let disconnect: () => void;
beforeEach(async () => {
  vi.resetModules();
  browser = installBrowser();
  store = await import("../src/store.ts");
  drafts = await import("../src/drafts.ts");
  session = await import("../src/session.ts");
  disconnect = session.connect();
  await until(() => store.getState().conn.kind === "open" && store.getState().models !== undefined, 2000, "connected");
  session.openThread("A");
  store.setState({ threads: ["A", "B"].map(id => ({ id, title: id, createdAt: 1, updatedAt: 1 })) });
});
afterEach(async () => { disconnect(); browser.server.accepting = false; for (const socket of browser.server.sockets) socket.close(); await tick(); vi.unstubAllGlobals(); });

it("keeps A and B drafts separate and sending A leaves B untouched", async () => {
  drafts.editDraft("words for A");
  session.openThread("B");
  expect(drafts.getDraft().text).toBe("");
  drafts.editDraft("words for B");
  session.openThread("A");
  expect(drafts.getDraft().text).toBe("words for A");
  await session.send(drafts.getDraft().text);
  expect(drafts.getDraft().text).toBe("");
  session.openThread("B");
  expect(drafts.getDraft().text).toBe("words for B");
});

it("restores a refused A send to A while B is open, preserving its retry identity", async () => {
  drafts.editDraft("A refused");
  const waiting = browser.server.hold("chat.send");
  const sent = session.send(drafts.getDraft().text);
  const request = await waiting;
  session.openThread("B");
  drafts.editDraft("B stays");
  request.fail("timeout", "not confirmed");
  await sent;
  expect(drafts.getDraft().text).toBe("B stays");
  expect(store.getState().notice).toContain("draft in “A”");
  session.openThread("A");
  expect(drafts.getDraft().text).toBe("A refused");
  expect(drafts.getDraft().sendId).toBe(request.params.messageId);
  await session.send(drafts.getDraft().text);
  expect(browser.server.calls("chat.send").at(-1)?.params).toHaveProperty("messageId", request.params.messageId);
});

it("one typed character runs zero global listeners and their store selectors", () => {
  let publishes = 0;
  let selectors = 0;
  const off = store.subscribe(() => { publishes++; (() => { selectors++; return store.getState().threadId; })(); });
  drafts.editDraft("x");
  off();
  expect({ publishes, selectors }).toEqual({ publishes: 0, selectors: 0 });
});

it("Cancel and leaving a queued edit restore the draft that preceded it", () => {
  store.setState({ queued: [{ id: "q", threadId: "A", text: "queued words", at: 1, held: true, waitFor: "reply" }] });
  drafts.editDraft("unfinished A");
  session.editQueued("q");
  drafts.editDraft("edited queue");
  session.cancelQueuedEdit();
  expect(drafts.getDraft().text).toBe("unfinished A");
  session.editQueued("q");
  session.openThread("B");
  expect(drafts.getDraft().text).toBe("");
  session.openThread("A");
  expect(drafts.getDraft().text).toBe("unfinished A");
  expect(store.getState().queued[0]?.text).toBe("queued words");
});

it("deleting A discards its draft without touching B", async () => {
  drafts.editDraft("A deleted");
  session.openThread("B");
  drafts.editDraft("B retained");
  await session.deleteThread("A");
  expect(drafts.getDraft().text).toBe("B retained");
  session.openThread("A");
  expect(drafts.getDraft().text).toBe("");
});

it("a new chat's first send consumes its draft slot", async () => {
  session.newThread();
  drafts.editDraft("first send");
  await session.send(drafts.getDraft().text);
  session.newThread();
  expect(drafts.getDraft().text).toBe("");
});

it("New thread on the new-chat screen keeps its words and gives the draft a new identity", () => {
  session.newThread();
  drafts.editDraft("kept words");
  const arriving = drafts.getDraft().version; // what a paste or dictation still being read was started against
  session.newThread();
  expect(drafts.getDraft()).toMatchObject({ text: "kept words", images: [], sendId: null });
  expect(drafts.getDraft().version).not.toBe(arriving);
  expect(drafts.savedDrafts().map(d => d.key)).toEqual([null]);
});

it("M18: removing a queued editor restores the earlier draft and attachments", () => {
  store.setState({ queued: [{ id: "q", threadId: "A", text: "queued words", at: 1, held: true, waitFor: "reply" }] });
  drafts.replaceDraft("A", { text: "before edit", images: ["before-image"], sendId: "before-id" });
  session.editQueued("q"); drafts.editDraft("edited queue");
  session.removeQueued("q");
  expect(drafts.getDraft("A")).toMatchObject({ text: "before edit", images: ["before-image"], sendId: "before-id" });
  expect(store.getState().queued).toEqual([]);
  expect(store.getState().editingQueued).toBeNull();
});
