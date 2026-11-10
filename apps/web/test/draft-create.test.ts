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

it.each([false, true])("R4: newer words follow the created thread (queued: %s)", async queued => {
  session.newThread();
  if (queued) store.setState({ runtime: { state: "installing", owner: "app", baseUrl: "http://runtime.invalid" } });
  drafts.editDraft("first");
  const creating = browser.server.hold("threads.create"), sent = session.send("first");
  const request = await creating;
  drafts.editDraft("first and another thought");
  drafts.replaceDraft(null, { images: ["new-image"], sendId: "new-copy" }, true);
  request.respond({ id: "N", title: "first", createdAt: 1, updatedAt: 1 });
  await sent;
  expect(store.getState().threadId).toBe("N");
  expect(drafts.getDraft("N")).toMatchObject({ text: "first and another thought", images: ["new-image"], sendId: "new-copy" });
  expect(drafts.getDraft(null).text).toBe("");
  session.newThread(); expect(drafts.getDraft().text).toBe("");
});

it.each([false, true])("New thread pressed while the first chat is being created leaves no second copy of the words (queued: %s)", async queued => {
  session.newThread();
  if (queued) store.setState({ runtime: { state: "installing", owner: "app", baseUrl: "http://runtime.invalid" } });
  drafts.editDraft("only once");
  const creating = browser.server.hold("threads.create"), sent = session.send("only once");
  const request = await creating;
  session.newThread();
  request.respond({ id: "N", title: "only once", createdAt: 1, updatedAt: 1 });
  await sent;
  expect(store.getState().threadId).toBe("N");
  if (queued) expect(store.getState().queued.map(q => q.text)).toEqual(["only once"]);
  expect(drafts.getDraft("N").text).toBe("");
  expect(drafts.getDraft(null).text).toBe("");
});
