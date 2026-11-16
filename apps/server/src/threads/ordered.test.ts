// The chat list and each chat are ordered data: every write to the thread store takes the next
// list number, a write to a chat's messages also becomes that chat's number, and every answer and
// push about the list or a chat carries the numbers of what it holds.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createClient, type Payload, type SocketLike, type SyncChange, type SyncMetadata } from "@gates-local/contracts";
import { WebSocket } from "ws";
import { startWsServer, type HandlerContext, type WsServer } from "../ws/server.ts";
import { openThreadStore, type ThreadStore } from "./store.ts";
import { chatRead, listRead, threadChanged } from "./sync.ts";

const cleanup: Array<() => unknown> = [];
afterEach(async () => { for (const close of cleanup.splice(0).toReversed()) await close(); });
function scratchStore(): ThreadStore {
  const root = mkdtempSync(path.join(tmpdir(), "ordered-threads-"));
  let t = 1_000;
  const store = openThreadStore(path.join(root, "threads.db"), { now: () => (t += 10) });
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  cleanup.push(() => store.close());
  return store;
}
const revs = (changes: readonly SyncChange[] | undefined) => changes?.map(change => change.kind === "snapshot" ? [change.scope, change.rev] : change);
function captured<T>(run: (ctx: HandlerContext) => T): { value: T; changes: readonly SyncChange[] | undefined } {
  let changes: readonly SyncChange[] | undefined;
  const value = run({ clientId: 1, capture: c => { changes = c; } });
  return { value, changes };
}

it("each of the store's twelve writes takes the next list number; a write to a chat's messages is also that chat's number", () => {
  const store = scratchStore();
  const at = (threadId: string) => [store.numbers.list(), store.numbers.chat(threadId)];
  expect(store.numbers.list()).toBe(0);
  const a = store.createThread({ title: "First" });
  expect(at(a.id), "createThread").toEqual([1, 1]);
  store.renameThread(a.id, "Renamed");
  expect(at(a.id), "renameThread: the row only").toEqual([2, 1]);
  store.setImageChoice(a.id, { preset: "moss-image", width: 1024, height: 1024 });
  expect(at(a.id), "setImageChoice: the row only").toEqual([3, 1]);
  expect(store.fillImageChoice(a.id, { preset: "moss-image", width: 512, height: 512 })).toBe(false);
  expect(at(a.id), "fillImageChoice that kept nothing wrote nothing").toEqual([3, 1]);
  const b = store.createThread({ title: "Second" });
  expect(at(b.id), "a second createThread").toEqual([4, 4]);
  expect(store.fillImageChoice(b.id, { preset: "moss-image", width: 512, height: 512 })).toBe(true);
  expect(at(b.id), "fillImageChoice: the row only").toEqual([5, 4]);
  store.setImageCount(a.id, 2);
  expect(at(a.id), "setImageCount: the row only").toEqual([6, 1]);
  const question = store.appendMessage({ threadId: a.id, role: "user", content: "q" });
  expect(at(a.id), "appendMessage").toEqual([7, 7]);
  store.stampTimes(a.id, question.id, { startedAt: 1_000, spans: [], callsAt: {}, ended: { reason: "failed", at: 1_400 } });
  expect(at(a.id), "stampTimes").toEqual([8, 8]);
  store.saveImageJob({ jobId: "j1", threadId: a.id, state: "error", choice: { preset: "moss-image", width: 1024, height: 1024 } }, "a tree");
  expect(at(a.id), "saveImageJob").toEqual([9, 9]);
  store.claimImageRetry(a.id, "j1", "j2", { preset: "moss-image", width: 1024, height: 1024 });
  expect(at(a.id), "claimImageRetry").toEqual([10, 10]);
  store.interruptImageJobs();
  expect(at(a.id), "interruptImageJobs: the queued retry ended").toEqual([11, 11]);
  store.deleteMessage(a.id, question.id);
  expect(at(a.id), "deleteMessage").toEqual([12, 12]);
  store.deleteThread(b.id);
  expect(at(b.id), "deleteThread").toEqual([13, 13]);
  expect(store.numbers.chat(a.id), "another chat's write leaves this chat's number").toBe(12);
});

it("threads.list and threads.get answer with the numbers of what they read, and a push carries the row as it is now", () => {
  const store = scratchStore();
  const a = store.createThread({ title: "First" });
  const b = store.createThread({ title: "Second" });
  store.appendMessage({ threadId: a.id, role: "user", content: "q" });
  const listed = captured(ctx => listRead(store, ctx));
  expect(listed.value.map(t => t.id).toSorted()).toEqual([a.id, b.id].toSorted());
  expect(revs(listed.changes)?.toSorted()).toEqual([["threads", 3], [`thread:${a.id}`, 3], [`thread:${b.id}`, 2]].toSorted());
  expect(revs(captured(ctx => chatRead(store, b.id, ctx)).changes)).toEqual([["threads", 3], [`thread:${b.id}`, 2]]);

  store.renameThread(b.id, "Renamed");
  const answered = captured(ctx => threadChanged(store, b.id, ctx));
  const [channel, payload, changes] = answered.value;
  expect(channel).toBe("threads.changed");
  expect(payload).toEqual({ threadId: b.id, thread: expect.objectContaining({ id: b.id, title: "Renamed" }) });
  expect(revs(changes), "a rename moves the list, not the chat's messages").toEqual([["threads", 4], [`thread:${b.id}`, 2]]);
  expect(answered.changes, "the action answers with the push's numbers").toEqual(changes);

  store.deleteThread(b.id);
  const [, gone, goneChanges] = threadChanged(store, b.id);
  expect(gone, "a deleted chat is a row too").toEqual({ threadId: b.id, thread: null });
  expect(revs(goneChanges)).toEqual([["threads", 5], [`thread:${b.id}`, 5]]);
});

it("the socket server refuses a threads answer or push without the list's number or the chat's", async () => {
  const store = scratchStore();
  const a = store.createThread({ title: "First" });
  const b = store.createThread({ title: "Second" });
  let server: WsServer | undefined;
  server = await startWsServer({
    port: 0, token: "fixture", allowedOrigins: [],
    handlers: {
      "threads.list": (_params: unknown, ctx: HandlerContext) => listRead(store, ctx),
      "threads.get": ({ threadId }: { threadId: string }, ctx: HandlerContext) => {
        // the second chat's read numbers the list but not the chat it answers about
        if (threadId === b.id) ctx.capture?.([{ scope: "threads", kind: "snapshot", rev: store.numbers.list() }]);
        else chatRead(store, threadId, ctx);
        return store.getThread(threadId);
      },
      "threads.rename": ({ threadId, title }: { threadId: string; title: string }, ctx: HandlerContext) => {
        const thread = store.renameThread(threadId, title);
        server?.push(...threadChanged(store, threadId, ctx));
        return thread;
      },
      "threads.create": () => store.createThread({}),
    } as never,
  });
  cleanup.push(() => server?.close());
  const client = createClient(new WebSocket(`ws://127.0.0.1:${server.port}/?token=fixture`) as unknown as SocketLike);
  cleanup.push(() => client.close());
  expect(await client.negotiate()).toMatchObject({ epoch: expect.any(String) });
  const pushes: Array<{ payload: Payload<"threads.changed">; sync: SyncMetadata | undefined }> = [];
  client.subscribe("threads.changed", (payload, sync) => pushes.push({ payload, sync }));

  let read: SyncMetadata | undefined;
  await client.call("threads.get", { threadId: a.id }, { onMetadata: sync => { read = sync; } });
  expect(revs(read?.changes)).toEqual([["threads", 2], [`thread:${a.id}`, 1]]);
  await expect(client.call("threads.get", { threadId: b.id }), "a chat's read must carry the chat's number").rejects.toMatchObject({ code: "bad-result", message: `threads.get did not capture thread:${b.id} metadata` });
  let renamed: SyncMetadata | undefined;
  await client.call("threads.rename", { threadId: a.id, title: "Numbered list" }, { onMetadata: sync => { renamed = sync; } });
  expect(revs(renamed?.changes)).toEqual([["threads", 3], [`thread:${a.id}`, 1]]);
  await vi.waitFor(() => expect(pushes).toHaveLength(1));
  expect(pushes[0]?.payload).toEqual({ threadId: a.id, thread: expect.objectContaining({ title: "Numbered list" }) });
  expect(pushes[0]?.sync?.changes).toEqual(renamed?.changes);
  await expect(client.call("threads.create", {}), "an action on the list must answer with its number").rejects.toMatchObject({ code: "bad-result", message: "threads.create did not capture threads metadata" });

  expect(() => server?.push("threads.changed", { threadId: a.id, thread: null }), "no number").toThrow(/did not capture threads metadata/);
  expect(() => server?.push("threads.changed", { threadId: a.id, thread: null }, [{ scope: "threads", kind: "snapshot", rev: 9 }]), "the list's number alone")
    .toThrow(new RegExp(`did not capture thread:${a.id} metadata`));
  expect(() => server?.push("threads.changed", { threadId: a.id, thread: null }, [{ scope: "threads", kind: "snapshot", rev: 9 }, { scope: "thread:other", kind: "snapshot", rev: 9 }]), "another chat's number")
    .toThrow(new RegExp(`did not capture thread:${a.id} metadata`));
});
