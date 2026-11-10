import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installBrowser, tick, until } from "./harness.ts";

let browser: ReturnType<typeof installBrowser>;
let store: typeof import("../src/store.ts");
let drafts: typeof import("../src/drafts.ts");
let session: typeof import("../src/session.ts");
let disconnect: () => void;
beforeEach(async () => {
  vi.resetModules(); browser = installBrowser();
  store = await import("../src/store.ts"); drafts = await import("../src/drafts.ts"); session = await import("../src/session.ts");
  disconnect = session.connect();
  await until(() => store.getState().conn.kind === "open" && store.getState().models !== undefined, 2000, "connected");
});
afterEach(async () => { disconnect(); browser.server.accepting = false; for (const socket of browser.server.sockets) socket.close(); await tick(); vi.unstubAllGlobals(); });

it.each([
  { reason: "late confirmation", queued: true }, { reason: "late confirmation", queued: false },
  { reason: "vanished row", queued: true }, { reason: "vanished row", queued: false },
])("TD-13: $reason preserves the backup after sending changed words (queued: $queued)", async ({ reason, queued }) => {
  session.openThread("A");
  store.setState({ queued: [{ id: "q", messageId: "M", threadId: "A", text: "queued words", at: 1, held: true, waitFor: "reply" }] });
  const backup = { text: "my unfinished words", images: ["backup image"], sendId: "backup-id" };
  drafts.replaceDraft("A", backup); session.editQueued("q"); drafts.editDraft("queued words, edited");
  if (reason === "late confirmation") {
    browser.server.push("chat.event", { turnId: "late", threadId: "A", event: { type: "start", model: "qwen3:14b", userMessage: { id: "M", threadId: "A", role: "user", content: "queued words", createdAt: 1 } } });
    await until(() => store.getState().editingQueued === null, 2000, "confirmed");
  } else {
    store.setState({ queued: [] });
    await session.send("queued words, edited");
  }
  expect(store.getState().editingQueued).toBeNull();
  expect(drafts.getDraft("A")).toMatchObject({ text: "queued words, edited", sendId: null, beforeEdit: backup });
  store.setState({ turns: {}, ...(queued ? { runtime: { state: "installing", owner: "app", baseUrl: "http://runtime.invalid" } } : {}) });
  await session.send("queued words, edited");
  if (queued) expect(store.getState().queued).toMatchObject([{ threadId: "A", text: "queued words, edited" }]);
  else expect(browser.server.calls("chat.send").at(-1)?.params).toMatchObject({ threadId: "A", content: "queued words, edited" });
  expect(drafts.getDraft("A")).toMatchObject(backup);
  expect(drafts.getDraft("A").beforeEdit).toBeUndefined();
});

it("X18: confirmation clears its ordinary source while another chat has an edit backup", async () => {
  session.openThread("B");
  store.setState({ queued: [{ id: "edit-B", threadId: "B", text: "queued B", at: 1, held: true, waitFor: "reply" }] });
  drafts.editDraft("unfinished B"); session.editQueued("edit-B");
  drafts.replaceDraft("A", { text: "confirmed A", sendId: "M" });
  browser.server.push("chat.event", { turnId: "late-A", threadId: "A", event: { type: "start", model: "qwen3:14b", userMessage: { id: "M", threadId: "A", role: "user", content: "confirmed A", createdAt: 1 } } });
  await until(() => store.getState().turns["A"] !== undefined, 2000, "A confirmed");
  expect(drafts.getDraft("A").text).toBe("");
  expect(store.getState().editingQueued).toBe("edit-B");
  expect(drafts.getDraft("B")).toMatchObject({ text: "queued B", beforeEdit: { text: "unfinished B" } });
});
