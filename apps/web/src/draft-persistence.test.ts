import { afterEach, expect, it, vi } from "vitest";
import { recoverDraft, watchDraft } from "./draft-persistence.ts";
import { draftDatabase } from "./draft-persistence-testing.ts";
import { getState, setState } from "./store.ts";
import { clearDraft, editDraft, getDraft, replaceDraft, type Draft } from "./drafts.ts";
import type { State } from "./store.ts";

// Combine independent sources only for compact assertions, never in the app store.
const observation = (state: State, draft: Draft) => ({ ...state, draft: draft.text, draftImages: draft.images, draftSendId: draft.sendId });
const observed = () => observation(getState(), getDraft());
const savedSlot = (key: string) => ({ key, draft: { text: key, images: [], sendId: null } });

const initial = getState();
const settled = () => new Promise<void>(resolve => setImmediate(resolve));
async function freshWatcher() {
  vi.resetModules();
  const store = await import("./store.ts");
  const persistence = await import("./draft-persistence.ts");
  const drafts = await import("./drafts.ts");
  return { ...store, ...drafts, watchDraft: persistence.watchDraft, observed: () => observation(store.getState(), drafts.getDraft()) };
}

const reset = () => { clearDraft(null); clearDraft("t"); setState(initial); };
afterEach(() => { vi.unstubAllGlobals(); reset(); });

it("TD-10: the active text is stored once and both slots reload", async () => {
  const fixture = draftDatabase(), a = await freshWatcher();
  a.replaceDraft("B", { text: "other chat" }); a.setState({ threadId: "A" });
  const stop = await a.watchDraft("one-copy"), text = "x".repeat(50_000);
  a.editDraft(text); fixture.pending[0]!.finish(); await settled(); stop();
  const metadata = JSON.stringify(fixture.records.get(JSON.stringify("one-copy")));
  expect(metadata.split(text).length - 1).toBe(1);
  const b = await freshWatcher(); b.setState({ threadId: "A" });
  const resume = await b.watchDraft("one-copy");
  expect(b.getDraft("A").text).toBe(text);
  expect(b.getDraft("B").text).toBe("other chat"); resume();
});

it.each([{ key: 42, draft: { text: "bad", images: [], sendId: null } }, { key: "bad", draft: { text: 42, images: [], sendId: null } }, { key: "bad", draft: { text: "bad", images: [], sendId: null, beforeEdit: { text: 42 } } }])("TD-12: a malformed slot does not discard other drafts or the queue: %j", invalid => {
  const recovered = recoverDraft({ draft: "A", images: [], queued: [{ id: "q", threadId: "A", text: "queued words", at: 1 }], slots: [savedSlot("A"), invalid, savedSlot("B")] });
  expect(recovered?.slots?.map(s => s.key)).toEqual(["A", "B"]);
  expect(recovered?.queued).toMatchObject([{ id: "q", text: "queued words", held: true }]);
});

it("reload keeps both threads' words and deletion removes the saved draft", async () => {
  const fixture = draftDatabase();
  const a = await freshWatcher();
  a.setState({ view: "thread", threadId: "A", threads: [{ id: "A", title: "A", createdAt: 1, updatedAt: 1 }, { id: "B", title: "B", createdAt: 1, updatedAt: 1 }] });
  const stop = await a.watchDraft("both");
  a.editDraft("A words");
  fixture.pending[0]!.finish(); await settled();
  a.setState({ threadId: "B" }); a.editDraft("B words");
  while (fixture.pending.length) { fixture.pending[0]!.finish(); await settled(); }
  stop();
  const b = await freshWatcher();
  const resume = await b.watchDraft("both");
  b.setState({ threadId: "A", view: "thread" });
  expect(b.getDraft().text).toBe("A words");
  b.setState({ threadId: "B" });
  expect(b.getDraft().text).toBe("B words");
  b.setState({ threads: [{ id: "A", title: "A", createdAt: 1, updatedAt: 1 }, { id: "B", title: "B", createdAt: 1, updatedAt: 1 }] });
  b.setState({ threads: [{ id: "B", title: "B", createdAt: 1, updatedAt: 1 }] });
  while (fixture.pending.length) { fixture.pending[0]!.finish(); await settled(); }
  resume();
  const c = await freshWatcher();
  const again = await c.watchDraft("both");
  c.setState({ threadId: "A", view: "thread" });
  expect(c.getDraft().text).toBe("");
  c.setState({ threadId: "B" });
  expect(c.getDraft().text).toBe("B words");
  again();
});

it("an old single draft uses its known thread rather than the new-chat slot", async () => {
  const fixture = draftDatabase();
  fixture.records.set(JSON.stringify("old-thread"), { draft: "recover A", images: [], queued: [], sendThreadId: "A", sendId: "retry" });
  const a = await freshWatcher();
  const stop = await a.watchDraft("old-thread");
  expect(a.getDraft().text).toBe("");
  a.setState({ view: "thread", threadId: "A" });
  expect(a.observed()).toMatchObject({ draft: "recover A", draftSendId: "retry" });
  stop();
});

it("stores 32 recent drafts, retaining images in only the newest two slots", async () => {
  const fixture = draftDatabase();
  const a = await freshWatcher();
  for (let i = 0; i < 34; i++) { a.setState({ threadId: String(i) }); a.replaceDraft(String(i), { text: `words ${i}`, images: [`image ${i}`] }); }
  const stop = await a.watchDraft("bounded");
  a.editDraft("words 33 final");
  fixture.pending[0]!.finish(); await settled(); stop();
  const b = await freshWatcher();
  const resume = await b.watchDraft("bounded");
  for (let i = 0; i < 34; i++) {
    b.setState({ threadId: String(i) });
    expect(b.getDraft().text).toBe(i < 2 ? "" : i === 33 ? "words 33 final" : `words ${i}`);
    expect(b.getDraft().images).toEqual(i < 32 ? [] : [`image ${i}`]);
  }
  resume();
});

it("reload preserves the draft saved before a queued edit", async () => {
  const fixture = draftDatabase();
  const a = await freshWatcher();
  const drafts = await import("./drafts.ts");
  a.setState({ threadId: "A", queued: [{ id: "q", threadId: "A", text: "queued", at: 1, waitFor: "reply" }] });
  a.replaceDraft("A", { text: "before edit", images: ["before-image"] });
  const stop = await a.watchDraft("edit");
  drafts.beginQueuedDraft("A", "changed queue", ["edit-image"], "send");
  a.setState({ editingQueued: "q" });
  while (fixture.pending.length) { fixture.pending[0]!.finish(); await settled(); }
  stop();
  const b = await freshWatcher();
  b.setState({ threadId: "A" });
  const resume = await b.watchDraft("edit");
  expect(b.observed()).toMatchObject({ draft: "changed queue", draftImages: ["edit-image"], editingQueued: "q" });
  (await import("./drafts.ts")).cancelQueuedDraft("A");
  expect(b.observed()).toMatchObject({ draft: "before edit", draftImages: ["before-image"] });
  resume();
});

it("opening a queued editor makes an old draft recent enough to persist its images", async () => {
  vi.resetModules();
  const drafts = await import("./drafts.ts");
  for (let i = 0; i < 34; i++) drafts.replaceDraft(String(i), { text: `words ${i}`, images: [`image ${i}`] });
  drafts.beginQueuedDraft("0", "queued edit", ["edit-image"], null);
  expect(drafts.savedDrafts().at(-1)).toMatchObject({ key: "0", draft: { text: "queued edit", images: ["edit-image"], beforeEdit: { text: "words 0", images: ["image 0"] } } });
});

it("keeps a restored draft or queued copy's saved-message identity for a safe retry", () => {
  expect(recoverDraft({ draft: "retry words", images: [], sendId: "draft-send", sendThreadId: "A", queued: [{ id: "q", messageId: "queued-send", threadId: "t", text: "queued words", images: [], at: 1 }] })).toMatchObject({ sendId: "draft-send", sendThreadId: "A", queued: [expect.objectContaining({ messageId: "queued-send" })] });
});

it("restores image drafts and queued attachments on hold without losing their model or order", () => {
  const images = ["data:image/png;base64,eA=="];
  expect(recoverDraft({ draft: "look", images, editing: "q-first", queued: [{ id: "q-first", threadId: "t", text: "first", images, at: 1, model: "vision", waitFor: "reply", now: true }, { id: "q-second", threadId: "t", text: "second", at: 2, waitFor: "download" }] })).toEqual({
    draft: "look", images, editing: "q-first", queued: [{ id: "q-first", threadId: "t", text: "first", images, at: 1, model: "vision", waitFor: "reply", held: true }, { id: "q-second", threadId: "t", text: "second", images: [], at: 2, waitFor: "reply", held: true }],
  });
});

it("ignores invalid persisted values instead of starting a broken queue", () => {
  for (const value of [undefined, null, {}, { draft: "", images: [42], queued: [] }, { draft: "", images: [], queued: [{ text: "bad" }] }]) expect(recoverDraft(value)).toBeUndefined();
});

it("CI-01: ten edits retain one in-flight write and submit unchanged attachments only once", async () => {
  reset();
  const fixture = draftDatabase();
  const images = Array.from({ length: 8 }, (_, i) => "data:image/png;base64," + String(i).repeat(10 * 1024 * 1024));
  const queuedImage = "data:image/png;base64," + "q".repeat(10 * 1024 * 1024);
  replaceDraft(null, { images }); setState({ queued: [{ id: "q", threadId: "t", text: "queued", images: [queuedImage], at: 1, waitFor: "reply" }] });
  const stop = await watchDraft("scope");
  try {
    editDraft("initial");
    const initialBytes = fixture.writes.reduce((n, put) => n + put.bytes, 0);
    for (let i = 0; i < 10; i++) editDraft(`edit ${i}`);
    process.stdout.write("DRAFT_WRITE_SUBMITTED " + JSON.stringify({ edits: 10, puts: fixture.writes.length, bytes: fixture.writes.reduce((n, put) => n + put.bytes, 0), initialBytes, maximumInFlight: fixture.maximum }) + "\n");
    expect(fixture.maximum, "at most one transaction can be in flight").toBe(1);
    expect(fixture.pending).toHaveLength(1);
    fixture.pending[0]!.finish();
    await settled();
    expect(fixture.pending).toHaveLength(1);
    fixture.pending[0]!.finish();
    await settled();
    expect(fixture.pending).toHaveLength(0);
    const extra = fixture.writes.reduce((n, put) => n + put.bytes, 0) - initialBytes;
    expect(extra, "latest text must not clone the 90 MiB of attachments").toBeLessThan(1024);
    expect(fixture.writes).toHaveLength(3);
    expect(fixture.reads.filter(read => read.mode === "readwrite")).toEqual([{ key: "scope", mode: "readwrite" }]);
    process.stdout.write("DRAFT_WRITE_BOUND " + JSON.stringify({ edits: 10, puts: fixture.writes.length, bytes: fixture.writes.reduce((n, put) => n + put.bytes, 0), initialBytes, textBytes: extra, maximumInFlight: fixture.maximum }) + "\n");
    stop();
    const reloaded = await freshWatcher();
    expect(reloaded.observed()).toMatchObject({ draft: "", draftImages: [], queued: [] });
    const resume = await reloaded.watchDraft("scope");
    expect(reloaded.observed()).toMatchObject({ draft: "edit 9", draftImages: images, queued: [expect.objectContaining({ images: [queuedImage] })] });
    resume();
  } finally { stop(); }
});

it("CI-02: hiding the page requests an early commit of the active write", async () => {
  reset();
  const fixture = draftDatabase();
  const stop = await watchDraft("scope");
  try {
    editDraft("final edit");
    fixture.document.visibilityState = "hidden";
    fixture.document.dispatchEvent(new Event("visibilitychange"));
    expect(fixture.pending[0]!.commit).toHaveBeenCalledOnce();
    fixture.window.dispatchEvent(new Event("pagehide"));
    expect(fixture.pending[0]!.commit).toHaveBeenCalledTimes(2);
    fixture.pending[0]!.finish();
    await settled();
  } finally { stop(); }
});

it("legacy drafts migrate atomically, and queued text changes reuse their attachments", async () => {
  reset();
  setState({ threadId: "t", view: "thread" });
  const fixture = draftDatabase();
  const image = "data:image/png;base64," + "a".repeat(32_000);
  fixture.records.set(JSON.stringify("legacy"), { draft: "old", images: [image], queued: [{ id: "q", threadId: "t", text: "queued", images: [image], model: "vision", at: 1 }], editing: "q", sendId: "retry", sendThreadId: "t" });
  const stop = await watchDraft("legacy");
  expect(observed()).toMatchObject({ draft: "old", draftImages: [image], draftSendId: "retry", editingQueued: "q", queued: [expect.objectContaining({ images: [image], held: true, model: "vision" })] });
  editDraft("new");
  fixture.pending[0]!.finish(); await settled();
  const count = fixture.writes.length;
  const bytes = fixture.writes.reduce((n, put) => n + put.bytes, 0);
  setState(s => ({ queued: s.queued.map(q => ({ ...q, text: "edited queue" })) }));
  fixture.pending[0]!.finish(); await settled();
  expect(fixture.writes.length - count).toBe(1);
  expect(fixture.writes.reduce((n, put) => n + put.bytes, 0) - bytes).toBeLessThan(1024);
  stop(); reset(); setState({ threadId: "t", view: "thread" });
  const resume = await watchDraft("legacy");
  expect(observed()).toMatchObject({ draft: "new", draftImages: [image], editingQueued: "q", queued: [expect.objectContaining({ text: "edited queue", images: [image], held: true })] });
  resume();
});

it("an aborted write cannot cache attachments or strand the pending latest edit", async () => {
  reset();
  const fixture = draftDatabase();
  const stop = await watchDraft("abort");
  replaceDraft(null, { images: ["first"] });
  replaceDraft(null, { images: ["latest"] }); editDraft("last edit");
  fixture.pending[0]!.abort(); await settled();
  expect(fixture.pending).toHaveLength(1);
  fixture.pending[0]!.finish(); await settled();
  expect(fixture.maximum).toBe(1);
  stop(); reset();
  const resume = await watchDraft("abort");
  expect(observed()).toMatchObject({ draft: "last edit", draftImages: ["latest"] });
  resume();
});

it("stopping drains the latest pending edit before closing the database", async () => {
  reset();
  const fixture = draftDatabase();
  const stop = await watchDraft("stop");
  editDraft("first"); editDraft("last"); stop();
  expect(fixture.db.close).not.toHaveBeenCalled();
  fixture.pending[0]!.finish(); await settled();
  expect(fixture.pending).toHaveLength(1);
  fixture.pending[0]!.finish(); await settled();
  expect(fixture.db.close).toHaveBeenCalledOnce();
  expect(fixture.maximum).toBe(1);
});

it.each(["replaced", "cleared"])("CI-03: completed %s attachments in another watcher cannot mix with the last writer's words", async (otherEdit) => {
  const fixture = draftDatabase();
  const a = await freshWatcher();
  const b = await freshWatcher();
  const stopA = await a.watchDraft("shared");
  const stopB = await b.watchDraft("shared");
  try {
    a.replaceDraft(null, { text: "A words", images: ["image-A"] }); a.setState({ queued: [{ id: "a", threadId: "t", text: "A queue", images: ["queued-A"], at: 1, waitFor: "reply" }] });
    while (fixture.pending.length) { fixture.pending[0]!.finish(); await settled(); }
    b.replaceDraft(null, { text: "B words", images: ["image-B"] }); b.setState({ queued: [{ id: "b", threadId: "t", text: "B queue", images: ["queued-B"], at: 2, waitFor: "reply" }] });
    while (fixture.pending.length) { fixture.pending[0]!.finish(); await settled(); }
    if (otherEdit === "cleared") {
      b.clearDraft(null); b.setState({ queued: [] });
      while (fixture.pending.length) { fixture.pending[0]!.finish(); await settled(); }
    }
    a.editDraft("A final words");
    fixture.pending[0]!.finish(); await settled();
    stopA(); stopB();
    const reloaded = await freshWatcher();
    expect(reloaded.observed()).toMatchObject({ draft: "", draftImages: [], queued: [] });
    const stopReloaded = await reloaded.watchDraft("shared");
    try {
      expect(reloaded.observed()).toMatchObject({ draft: "A final words", draftImages: ["image-A"], queued: [expect.objectContaining({ id: "a", images: ["queued-A"], held: true })] });
    } finally { stopReloaded(); }
  } finally { stopA(); stopB(); }
});

it("format-2 drafts without a revision migrate before metadata-only reuse", async () => {
  const fixture = draftDatabase();
  fixture.records.set(JSON.stringify("old-format-2"), { format: 2, draft: "old", queued: [], editing: null });
  fixture.records.set(JSON.stringify(["old-format-2", "attachments"]), { images: ["old-image"], queued: {} });
  const a = await freshWatcher();
  const stop = await a.watchDraft("old-format-2");
  expect(a.observed()).toMatchObject({ draft: "old", draftImages: ["old-image"] });
  a.editDraft("new"); fixture.pending[0]!.finish(); await settled();
  expect(fixture.writes).toHaveLength(2);
  expect(fixture.records.get(JSON.stringify("old-format-2"))).toMatchObject({ attachmentsRevision: expect.any(String) });
  stop();
  const reloaded = await freshWatcher();
  const stopReloaded = await reloaded.watchDraft("old-format-2");
  expect(reloaded.observed()).toMatchObject({ draft: "new", draftImages: ["old-image"] });
  const count = fixture.writes.length;
  reloaded.editDraft("newer"); fixture.pending[0]!.finish(); await settled();
  expect(fixture.writes.length - count).toBe(1);
  expect(fixture.reads.filter(read => read.mode === "readwrite")).toEqual([{ key: "old-format-2", mode: "readwrite" }]);
  stopReloaded();
});

const file = (n: number) => ({ path: `files/att-0f8b5c1e-3a2d-4c7e-9b1a-2d3e4f5a6b7${n}`, name: `notes-${n}.txt`, size: n, type: "text/plain" });
it("attached files reload in the open draft, another chat's draft and a queued message (chat row 3)", async () => {
  const fixture = draftDatabase(), a = await freshWatcher();
  a.replaceDraft("B", { text: "other", files: [file(2)] }); a.setState({ threadId: "A" });
  const stop = await a.watchDraft("files");
  a.replaceDraft("A", { text: "open", files: [file(1)] });
  a.setState({ queued: [{ id: "q", threadId: "A", text: "queued", at: 1, waitFor: "reply", files: [file(3)] }] });
  while (fixture.pending.length) { fixture.pending[0]!.finish(); await settled(); }
  stop();
  const b = await freshWatcher(); b.setState({ threadId: "A" });
  const resume = await b.watchDraft("files");
  expect(b.getDraft("A").files).toEqual([file(1)]);
  expect(b.getDraft("B").files).toEqual([file(2)]);
  expect(b.getState().queued.map(q => q.files)).toEqual([[file(3)]]);
  resume();
});

it("a stored attached file that is not one of the server's own names is dropped, never sent", () => {
  const recovered = recoverDraft({ draft: "", images: [], queued: [{ id: "q", threadId: "A", text: "x", at: 1, files: [{ path: "../secret", name: "s", size: 1, type: "" }] }] });
  expect(recovered?.queued[0]?.files).toBeUndefined();
});

it("a lifecycle commit waits for the metadata read to submit its writes", async () => {
  const fixture = draftDatabase();
  const a = await freshWatcher();
  const stop = await a.watchDraft("hide-during-read");
  a.editDraft("first"); fixture.pending[0]!.finish(); await settled();
  a.editDraft("last");
  fixture.window.dispatchEvent(new Event("pagehide"));
  expect(fixture.pending[0]!.commit).not.toHaveBeenCalled();
  await settled();
  expect(fixture.pending[0]!.commit).toHaveBeenCalledOnce();
  fixture.pending[0]!.finish(); await settled(); stop();
  const reloaded = await freshWatcher();
  const stopReloaded = await reloaded.watchDraft("hide-during-read");
  expect(reloaded.getDraft().text).toBe("last");
  stopReloaded();
});
