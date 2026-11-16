import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installBrowser, tick, until } from "../../../test/harness.ts";
import { answerSends, heldOnServer, queuedOf } from "../../../test/queue.ts";

let browser: ReturnType<typeof installBrowser>;
let store: typeof import("./store.ts");
let drafts: typeof import("./drafts.ts");
let session: typeof import("../session/index.ts");
let disconnect: () => void;
beforeEach(async () => {
  vi.resetModules(); browser = installBrowser();
  store = await import("./store.ts"); drafts = await import("./drafts.ts"); session = await import("../session/index.ts");
  answerSends(browser.server);
  disconnect = session.connect();
  await until(() => store.getState().conn.kind === "open" && store.getState().models !== undefined, 2000, "connected");
});
afterEach(async () => { disconnect(); browser.server.accepting = false; for (const socket of browser.server.sockets) socket.close(); await tick(); vi.unstubAllGlobals(); });

it.each([
  { reason: "late confirmation", queued: true }, { reason: "late confirmation", queued: false },
  { reason: "vanished row", queued: true }, { reason: "vanished row", queued: false },
])("TD-13: $reason preserves the backup after sending changed words (queued: $queued)", async ({ reason, queued }) => {
  session.openThread("A");
  await heldOnServer(browser.server, store.getState, { id: "q", messageId: "M", threadId: "A", text: "queued words" });
  const backup = { text: "my unfinished words", images: ["backup image"], sendId: "backup-id" };
  // the Edit has not reached the server when another window acts on the message
  void browser.server.hold("reply.edit");
  drafts.replaceDraft("A", backup); session.editQueued("q"); drafts.editDraft("queued words, edited");
  if (reason === "late confirmation") {
    // Send now, pressed there: the server starts it and saves its question
    browser.server.queue.change("q", { now: true });
    await until(() => store.getState().editingQueued === null, 2000, "confirmed");
    const late = store.getState().turns["A"]?.turnId;
    expect(late).toBe("q");
    // and its reply ends
    browser.server.push("chat.event", { turnId: "sent-1", threadId: "A", event: { type: "done", message: { id: "late-reply", threadId: "A", role: "assistant", content: "ok", createdAt: 2 }, stopReason: "stop" } });
    await until(() => store.getState().turns["A"] === undefined, 2000, "the late reply ended");
  } else {
    // Remove, pressed there: the next Send here finds it gone
    browser.server.queue.remove("q");
    await session.send("queued words, edited");
  }
  expect(store.getState().editingQueued).toBeNull();
  expect(drafts.getDraft("A")).toMatchObject({ text: "queued words, edited", sendId: null, beforeEdit: backup });
  if (queued) store.setState({ runtime: { state: "installing", owner: "app", baseUrl: "http://runtime.invalid" } });
  await session.send("queued words, edited");
  if (queued) expect(queuedOf(store.getState())).toMatchObject([{ threadId: "A", text: "queued words, edited" }]);
  else expect(browser.server.calls("chat.send").at(-1)?.params).toMatchObject({ threadId: "A", content: "queued words, edited" });
  expect(drafts.getDraft("A")).toMatchObject(backup);
  expect(drafts.getDraft("A").beforeEdit).toBeUndefined();
});

it("X18: confirmation clears its ordinary source while another chat has an edit backup", async () => {
  session.openThread("B");
  await heldOnServer(browser.server, store.getState, { id: "edit-B", threadId: "B", text: "queued B" });
  drafts.editDraft("unfinished B"); session.editQueued("edit-B");
  drafts.replaceDraft("A", { text: "confirmed A", sendId: "M" });
  browser.server.push("chat.event", { turnId: "late-A", threadId: "A", event: { type: "start", model: "qwen3:14b", userMessage: { id: "M", threadId: "A", role: "user", content: "confirmed A", createdAt: 1 } } });
  await until(() => store.getState().turns["A"]?.userMessageId === "M", 2000, "A confirmed");
  expect(drafts.getDraft("A").text).toBe("");
  expect(store.getState().editingQueued).toBe("edit-B");
  expect(drafts.getDraft("B")).toMatchObject({ text: "queued B", beforeEdit: { text: "unfinished B" } });
});
