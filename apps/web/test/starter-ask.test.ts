import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installBrowser, tick, until } from "./harness.ts";

// A Library question, pressed in Settings, over a new chat the person has half written:
// the real session, draft store and fake server; only the composer's focus is faked.
vi.mock("../src/Sidebar.tsx", () => ({ focusComposer: () => {} }));

let browser: ReturnType<typeof installBrowser>;
let store: typeof import("../src/store.ts");
let drafts: typeof import("../src/drafts.ts");
let session: typeof import("../src/session.ts");
let starter: typeof import("../src/starter.ts");
let disconnect: () => void;
const PICTURE = "data:image/png;base64,AAAA";
const QUESTION = "In Chinook: Which artist has the most albums?";
beforeEach(async () => {
  vi.resetModules(); browser = installBrowser();
  store = await import("../src/store.ts"); drafts = await import("../src/drafts.ts"); session = await import("../src/session.ts"); starter = await import("../src/starter.ts");
  disconnect = session.connect();
  await until(() => store.getState().conn.kind === "open" && store.getState().models !== undefined, 2000, "connected");
  session.newThread();
  drafts.replaceDraft(null, { text: "my half-written question", images: [PICTURE] });
  session.openSettings("library");
  await until(() => store.getState().view === "settings", 2000, "in Settings");
});
afterEach(async () => { disconnect(); browser.server.accepting = false; for (const socket of browser.server.sockets) socket.close(); await tick(); vi.unstubAllGlobals(); });

it("sends the question alone to a new chat and leaves the person's waiting words and picture as they were", async () => {
  starter.askWith(QUESTION);
  await until(() => browser.server.calls("chat.send").length === 1, 2000, "chat.send");
  const sent = browser.server.calls("chat.send")[0]!.params as { content: string; images?: unknown };
  expect(sent.content).toBe(QUESTION);
  expect(sent.images).toBeUndefined();
  const thread = store.getState().threadId;
  expect(store.getState().view).toBe("thread");
  expect(thread).not.toBeNull();
  expect(drafts.getDraft(thread).text).toBe("");
  expect(drafts.getDraft(null)).toMatchObject({ text: "my half-written question", images: [PICTURE] });
  session.newThread();
  expect(drafts.getDraft()).toMatchObject({ text: "my half-written question", images: [PICTURE] });
});

it("a question that waits for the runtime queues alone in its new chat and leaves the draft too", async () => {
  store.setState({ runtime: { state: "installing", owner: "app", baseUrl: "http://runtime.invalid" } });
  starter.askWith(QUESTION);
  await until(() => store.getState().queued.length === 1, 2000, "queued");
  const thread = store.getState().threadId;
  expect(store.getState().queued[0]).toMatchObject({ threadId: thread, text: QUESTION, images: [] });
  expect(drafts.getDraft(thread).text).toBe("");
  expect(drafts.getDraft(null)).toMatchObject({ text: "my half-written question", images: [PICTURE] });
});

it("a refused send leaves the person in the new chat, with the reason and their own draft", async () => {
  const creating = browser.server.hold("threads.create");
  starter.askWith(QUESTION);
  (await creating).fail("internal", "down");
  await until(() => store.getState().notice !== null, 2000, "a notice");
  expect(store.getState().view).toBe("new");
  // The question is not in the composer, so the reason does not say it is; it is still on its button in Settings, Library.
  expect(store.getState().notice).toBe("The message didn't send. Gates Local isn't answering.");
  expect(browser.server.calls("chat.send")).toHaveLength(0);
  expect(drafts.getDraft(null)).toMatchObject({ text: "my half-written question", images: [PICTURE] });
});
