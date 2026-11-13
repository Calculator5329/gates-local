import { expect, it, vi } from "vitest";
import type { AttachedFile } from "@gates-local/contracts";

const file = (n: string): AttachedFile => ({ path: `files/att-${n.repeat(8)}-0000-0000-0000-${"0".repeat(12)}`, name: `${n}.txt`, size: 1, type: "text/plain" });

async function fresh() {
  vi.resetModules();
  const holds = await import("./file-holds.ts");
  const drafts = await import("./drafts.ts");
  const store = await import("./store.ts");
  const chat = await import("./session/chat.ts");
  const calls: Array<[string, unknown]> = [];
  holds.setFileCalls(((method: string, params: unknown) => { calls.push([method, params]); return Promise.resolve(method === "files.keep" ? { missing: [] } : {}); }) as never);
  return { holds, drafts, store, chat, calls };
}

// Chat row 35: a removed chip gives its copy up at once, unless something else here still names it.
it("releasing a chip sends only the paths no other draft, earlier words or queued message names", async () => {
  const { holds, drafts, store, calls } = await fresh();
  const [a, b, c, d] = [file("a"), file("b"), file("c"), file("d")];
  drafts.replaceDraft("other", { text: "x", files: [b] });
  drafts.replaceDraft("edited", { text: "y", files: [c] });
  drafts.beginQueuedDraft("edited", "y2", [], null, []);
  store.setState({ queued: [{ id: "q1", threadId: "t", text: "z", at: 0, images: [], files: [d], waitFor: "reply" }] as never });
  holds.releaseFiles([a.path, b.path, c.path, d.path]);
  expect(calls).toEqual([["files.release", { paths: [a.path] }]]);
});

it("removing a queued message releases its files; a draft that still names one keeps that one", async () => {
  const { drafts, store, chat, calls } = await fresh();
  const [a, b] = [file("a"), file("b")];
  drafts.replaceDraft("t", { text: "again", files: [b] });
  store.setState({ queued: [{ id: "q1", threadId: "t", text: "z", at: 0, images: [], files: [a, b], waitFor: "reply" }] as never });
  chat.removeQueued("q1");
  expect(calls).toEqual([["files.release", { paths: [a.path] }]]);
});

it("keep names every file the drafts, their earlier words and the queue hold, and nothing when none", async () => {
  const { holds, drafts, store, calls } = await fresh();
  await holds.keepHeldFiles();
  expect(calls).toEqual([]);
  const [a, b, c] = [file("a"), file("b"), file("c")];
  drafts.replaceDraft("one", { text: "x", files: [a] });
  drafts.beginQueuedDraft("one", "x2", [], null, []);
  store.setState({ queued: [{ id: "q1", threadId: "t", text: "z", at: 0, images: [], files: [b, c], waitFor: "reply" }] as never });
  await holds.keepHeldFiles();
  expect(calls).toEqual([["files.keep", { paths: [a.path, b.path, c.path] }]]);
});
