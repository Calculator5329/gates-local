import { afterEach, expect, it, vi } from "vitest";
import { recoverDraft, watchDraft } from "./draft-persistence.ts";
import { draftDatabase } from "./draft-persistence-testing.ts";
import { editDraft, getState, setState } from "./store.ts";

const initial = getState();
const settled = () => new Promise<void>(resolve => setImmediate(resolve));
async function freshWatcher() {
  vi.resetModules();
  const store = await import("./store.ts");
  const persistence = await import("./draft-persistence.ts");
  return { ...store, watchDraft: persistence.watchDraft };
}

afterEach(() => { vi.unstubAllGlobals(); setState(initial); });

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
  setState(initial);
  const fixture = draftDatabase();
  const stop = await watchDraft("scope");
  try {
    const images = Array.from({ length: 8 }, (_, i) => "data:image/png;base64," + String(i).repeat(10 * 1024 * 1024));
    const queuedImage = "data:image/png;base64," + "q".repeat(10 * 1024 * 1024);
    setState({ draftImages: images, queued: [{ id: "q", threadId: "t", text: "queued", images: [queuedImage], at: 1, waitFor: "reply" }] });
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
    expect(reloaded.getState()).toMatchObject({ draft: "", draftImages: [], queued: [] });
    const resume = await reloaded.watchDraft("scope");
    expect(reloaded.getState()).toMatchObject({ draft: "edit 9", draftImages: images, queued: [expect.objectContaining({ images: [queuedImage] })] });
    resume();
  } finally { stop(); }
});

it("CI-02: hiding the page requests an early commit of the active write", async () => {
  setState(initial);
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
  setState(initial);
  const fixture = draftDatabase();
  const image = "data:image/png;base64," + "a".repeat(32_000);
  fixture.records.set(JSON.stringify("legacy"), { draft: "old", images: [image], queued: [{ id: "q", threadId: "t", text: "queued", images: [image], model: "vision", at: 1 }], editing: "q", sendId: "retry", sendThreadId: "t" });
  const stop = await watchDraft("legacy");
  expect(getState()).toMatchObject({ draft: "old", draftImages: [image], draftSendId: "retry", editingQueued: "q", queued: [expect.objectContaining({ images: [image], held: true, model: "vision" })] });
  editDraft("new");
  fixture.pending[0]!.finish(); await settled();
  const count = fixture.writes.length;
  const bytes = fixture.writes.reduce((n, put) => n + put.bytes, 0);
  setState(s => ({ queued: s.queued.map(q => ({ ...q, text: "edited queue" })) }));
  fixture.pending[0]!.finish(); await settled();
  expect(fixture.writes.length - count).toBe(1);
  expect(fixture.writes.reduce((n, put) => n + put.bytes, 0) - bytes).toBeLessThan(1024);
  stop(); setState(initial);
  const resume = await watchDraft("legacy");
  expect(getState()).toMatchObject({ draft: "new", draftImages: [image], editingQueued: "q", queued: [expect.objectContaining({ text: "edited queue", images: [image], held: true })] });
  resume();
});

it("an aborted write cannot cache attachments or strand the pending latest edit", async () => {
  setState(initial);
  const fixture = draftDatabase();
  const stop = await watchDraft("abort");
  setState({ draftImages: ["first"] });
  setState({ draftImages: ["latest"] }); editDraft("last edit");
  fixture.pending[0]!.abort(); await settled();
  expect(fixture.pending).toHaveLength(1);
  fixture.pending[0]!.finish(); await settled();
  expect(fixture.maximum).toBe(1);
  stop(); setState(initial);
  const resume = await watchDraft("abort");
  expect(getState()).toMatchObject({ draft: "last edit", draftImages: ["latest"] });
  resume();
});

it("stopping drains the latest pending edit before closing the database", async () => {
  setState(initial);
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
    a.setState({ draft: "A words", draftImages: ["image-A"], queued: [{ id: "a", threadId: "t", text: "A queue", images: ["queued-A"], at: 1, waitFor: "reply" }] });
    fixture.pending[0]!.finish(); await settled();
    b.setState({ draft: "B words", draftImages: ["image-B"], queued: [{ id: "b", threadId: "t", text: "B queue", images: ["queued-B"], at: 2, waitFor: "reply" }] });
    fixture.pending[0]!.finish(); await settled();
    if (otherEdit === "cleared") {
      b.setState({ draft: "", draftImages: [], queued: [] });
      fixture.pending[0]!.finish(); await settled();
    }
    a.editDraft("A final words");
    fixture.pending[0]!.finish(); await settled();
    stopA(); stopB();
    const reloaded = await freshWatcher();
    expect(reloaded.getState()).toMatchObject({ draft: "", draftImages: [], queued: [] });
    const stopReloaded = await reloaded.watchDraft("shared");
    try {
      expect(reloaded.getState()).toMatchObject({ draft: "A final words", draftImages: ["image-A"], queued: [expect.objectContaining({ id: "a", images: ["queued-A"], held: true })] });
    } finally { stopReloaded(); }
  } finally { stopA(); stopB(); }
});

it("format-2 drafts without a revision migrate before metadata-only reuse", async () => {
  const fixture = draftDatabase();
  fixture.records.set(JSON.stringify("old-format-2"), { format: 2, draft: "old", queued: [], editing: null });
  fixture.records.set(JSON.stringify(["old-format-2", "attachments"]), { images: ["old-image"], queued: {} });
  const a = await freshWatcher();
  const stop = await a.watchDraft("old-format-2");
  expect(a.getState()).toMatchObject({ draft: "old", draftImages: ["old-image"] });
  a.editDraft("new"); fixture.pending[0]!.finish(); await settled();
  expect(fixture.writes).toHaveLength(2);
  expect(fixture.records.get(JSON.stringify("old-format-2"))).toMatchObject({ attachmentsRevision: expect.any(String) });
  stop();
  const reloaded = await freshWatcher();
  const stopReloaded = await reloaded.watchDraft("old-format-2");
  expect(reloaded.getState()).toMatchObject({ draft: "new", draftImages: ["old-image"] });
  const count = fixture.writes.length;
  reloaded.editDraft("newer"); fixture.pending[0]!.finish(); await settled();
  expect(fixture.writes.length - count).toBe(1);
  expect(fixture.reads.filter(read => read.mode === "readwrite")).toEqual([{ key: "old-format-2", mode: "readwrite" }]);
  stopReloaded();
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
  expect(reloaded.getState().draft).toBe("last");
  stopReloaded();
});
