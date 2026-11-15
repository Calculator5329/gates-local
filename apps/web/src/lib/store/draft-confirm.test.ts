import { afterEach, expect, it, vi } from "vitest";
import { installBrowser, tick, until } from "../../../test/harness.ts";

afterEach(() => vi.unstubAllGlobals());
it("R5: late confirmation restores the words from before the queued edit", async () => {
  vi.resetModules(); const browser = installBrowser();
  const store = await import("./store.ts"), drafts = await import("./drafts.ts"), session = await import("../session/index.ts");
  const disconnect = session.connect();
  try {
    await until(() => store.getState().conn.kind === "open" && store.getState().models !== undefined, 2000, "connected");
    session.openThread("A");
    store.setState({ queued: [{ id: "q", messageId: "M", threadId: "A", text: "queued words", at: 1, held: true, waitFor: "reply" }] });
    drafts.editDraft("my unfinished words"); session.editQueued("q");
    browser.server.push("chat.event", { turnId: "late", threadId: "A", event: { type: "start", model: "qwen3:14b", userMessage: { id: "M", threadId: "A", role: "user", content: "queued words", createdAt: 1 } } });
    await until(() => store.getState().editingQueued === null, 2000, "confirmed");
    expect(drafts.getDraft("A").text).toBe("my unfinished words");
    expect(store.getState().queued).toEqual([]);
  } finally { disconnect(); browser.server.accepting = false; for (const socket of browser.server.sockets) socket.close(); await tick(); }
});

it("late confirmation of a reworded queued edit keeps the new words and drops a paste or dictation still arriving for the edit", async () => {
  vi.resetModules(); const browser = installBrowser();
  const store = await import("./store.ts"), drafts = await import("./drafts.ts"), session = await import("../session/index.ts");
  const disconnect = session.connect();
  try {
    await until(() => store.getState().conn.kind === "open" && store.getState().models !== undefined, 2000, "connected");
    session.openThread("A");
    store.setState({ queued: [{ id: "q", messageId: "M", threadId: "A", text: "queued words", at: 1, held: true, waitFor: "reply" }] });
    session.editQueued("q"); drafts.editDraft("queued words, reworded");
    // a paste or dictation checks this before it lands (paste.ts, Voice.tsx)
    const held = drafts.getDraft("A").version;
    browser.server.push("chat.event", { turnId: "late", threadId: "A", event: { type: "start", model: "qwen3:14b", userMessage: { id: "M", threadId: "A", role: "user", content: "queued words", createdAt: 1 } } });
    await until(() => store.getState().editingQueued === null, 2000, "confirmed");
    expect(drafts.getDraft("A").text).toBe("queued words, reworded");
    expect(drafts.getDraft("A").version, "the edit it was meant for has ended").not.toBe(held);
  } finally { disconnect(); browser.server.accepting = false; for (const socket of browser.server.sockets) socket.close(); await tick(); }
});
