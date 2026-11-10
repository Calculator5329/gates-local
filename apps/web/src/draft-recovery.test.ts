import { afterEach, expect, it, vi } from "vitest";
import { draftDatabase } from "./draft-persistence-testing.ts";
import { installBrowser, tick, until } from "../test/harness.ts";

const settled = () => new Promise<void>(resolve => setImmediate(resolve));
async function fresh() {
  vi.resetModules();
  return { ...await import("./store.ts"), ...await import("./drafts.ts"), ...await import("./draft-persistence.ts") };
}
async function drain(fixture: ReturnType<typeof draftDatabase>) {
  while (fixture.pending.length) { fixture.pending[0]!.finish(); await settled(); }
}
afterEach(() => vi.unstubAllGlobals());

it("TD-13: reload preserves stranded edited words and sending them reveals the backup", async () => {
  const fixture = draftDatabase(), a = await fresh();
  a.setState({ threadId: "A", view: "thread" });
  const stop = await a.watchDraft("stranded");
  const backup = { text: "my unfinished words", images: ["backup image"], sendId: "backup-id" };
  a.replaceDraft("A", backup); a.beginQueuedDraft("A", "queued words", [], "M");
  a.editDraft("queued words, edited"); await drain(fixture); stop();
  const b = await fresh(); b.setState({ threadId: "A", view: "thread" });
  const browser = installBrowser();
  Object.assign(fixture.document, { documentElement: document.documentElement, querySelector: () => null });
  vi.stubGlobal("window", fixture.window); vi.stubGlobal("document", fixture.document);
  const resume = await b.watchDraft("stranded");
  let disconnect: (() => void) | undefined;
  try {
    expect(b.getState().editingQueued).toBeNull();
    expect(b.getDraft("A")).toMatchObject({ text: "queued words, edited", beforeEdit: backup });
    const session = await import("./session.ts"); disconnect = session.connect();
    await until(() => b.getState().conn.kind === "open" && b.getState().models !== undefined, 2000, "connected");
    await session.send("queued words, edited");
    expect(browser.server.calls("chat.send").at(-1)?.params).toMatchObject({ content: "queued words, edited" });
    expect(b.getDraft("A")).toMatchObject(backup);
    expect(b.getDraft("A").beforeEdit).toBeUndefined();
  } finally {
    disconnect?.(); browser.server.accepting = false; for (const socket of browser.server.sockets) socket.close();
    await tick(); await drain(fixture); resume();
  }
});

it("TD-14: recovery preserves a cleared editor and never replaces its marker with another saved edit", async () => {
  const fixture = draftDatabase(), a = await fresh();
  const saved = { id: "saved", threadId: "A", text: "queued A", at: 1, waitFor: "reply" as const };
  const active = { id: "active", threadId: "B", text: "queued B", at: 2, waitFor: "reply" as const };
  fixture.records.set(JSON.stringify("cleared-editor"), { draft: "edited A", images: [], threadId: "A", editing: "saved", queued: [saved], slots: [{ key: "A", draft: { text: "edited A", images: [], sendId: null, beforeEdit: { text: "before A", images: [], sendId: null } } }] });
  a.setState({ threadId: "A" });
  const transaction = fixture.db.transaction.bind(fixture.db);
  let started = false;
  fixture.db.transaction = (name, mode) => {
    const tx = transaction(name, mode);
    if (mode === undefined && !started) {
      started = true; a.replaceDraft("B", { text: "before B" }); a.beginQueuedDraft("B", "queued B", [], null);
      a.replaceDraft("B", { text: "" }, true); a.setState({ queued: [saved, active], editingQueued: "active" });
    }
    return tx;
  };
  const stop = await a.watchDraft("cleared-editor");
  expect(a.getState().editingQueued).toBe("active");
  expect(a.getDraft("B")).toMatchObject({ text: "", beforeEdit: { text: "before B" } });
  expect(a.getDraft("A").text).toBe("before A"); stop();
});

it("R1: typing during recovery preserves the other chats on disk", async () => {
  const fixture = draftDatabase(), a = await fresh();
  const stop = await a.watchDraft("r1");
  a.setState({ threadId: "A" }); a.editDraft("A words"); await drain(fixture);
  a.setState({ threadId: "B" }); a.editDraft("B words"); await drain(fixture); stop();
  const b = await fresh();
  b.setState({ threadId: "C", view: "thread" });
  const transaction = fixture.db.transaction.bind(fixture.db);
  let typed = false;
  fixture.db.transaction = (name, mode) => {
    const tx = transaction(name, mode);
    if (mode === undefined && !typed) { typed = true; b.editDraft("C while reading"); }
    return tx;
  };
  const resume = await b.watchDraft("r1");
  b.editDraft("C while reading!"); await drain(fixture); resume();
  const c = await fresh(), again = await c.watchDraft("r1");
  expect(Object.fromEntries(["A", "B", "C"].map(key => [key, c.getDraft(key).text]))).toEqual({ A: "A words", B: "B words", C: "C while reading!" });
  again();
});

it.each(["before opening", "while opening"])("R3: memory wins for the same chat %s", async timing => {
  const fixture = draftDatabase(), a = await fresh();
  const stop = await a.watchDraft("r3");
  a.setState({ threadId: "C" }); a.editDraft("old C"); await drain(fixture); stop();
  const b = await fresh(); b.setState({ threadId: "C", view: "thread" });
  if (timing === "before opening") b.editDraft("new C");
  const loading = b.watchDraft("r3");
  if (timing === "while opening") b.editDraft("new C");
  const resume = await loading;
  expect(b.getDraft("C").text).toBe("new C"); resume();
});

it("R7: an editor restored off screen returns to its earlier draft", async () => {
  const fixture = draftDatabase(), a = await fresh();
  a.setState({ threadId: "A", queued: [{ id: "q", messageId: "M", threadId: "A", text: "queued", at: 1, waitFor: "reply" }] });
  a.replaceDraft("A", { text: "before edit" });
  const stop = await a.watchDraft("r7");
  a.beginQueuedDraft("A", "queued", [], "M"); a.setState({ editingQueued: "q" });
  await drain(fixture); stop();
  const b = await fresh(); b.setState({ threadId: "B", view: "thread" });
  const resume = await b.watchDraft("r7");
  expect({ editing: b.getState().editingQueued, text: b.getDraft("A").text, id: b.getDraft("A").sendId, queued: b.getState().queued.map(q => q.messageId) }).toEqual({ editing: null, text: "before edit", id: null, queued: ["M"] });
  resume();
});

it("R7: saved editing cannot capture words typed before the read", async () => {
  const fixture = draftDatabase();
  fixture.records.set(JSON.stringify("marker"), { draft: "saved queued edit", images: [], editing: "q", threadId: "A", queued: [{ id: "q", threadId: "A", text: "queued", at: 1 }] });
  const a = await fresh(); a.setState({ threadId: "A" }); a.editDraft("new words");
  const stop = await a.watchDraft("marker");
  expect({ text: a.getDraft("A").text, editing: a.getState().editingQueued }).toEqual({ text: "new words", editing: null }); stop();
});

it("R7: recovery leaves a different active editor alone", async () => {
  const fixture = draftDatabase(), a = await fresh();
  const saved = { id: "saved", threadId: "A", text: "queued A", at: 1, waitFor: "reply" as const };
  const active = { id: "active", threadId: "B", text: "queued B", at: 2, waitFor: "reply" as const };
  fixture.records.set(JSON.stringify("other-editor"), { draft: "edited A", images: [], threadId: "A", editing: "saved", queued: [saved], slots: [{ key: "A", draft: { text: "edited A", images: [], sendId: null, beforeEdit: { text: "before A", images: [], sendId: null } } }] });
  a.setState({ threadId: "B" });
  const transaction = fixture.db.transaction.bind(fixture.db);
  let started = false;
  fixture.db.transaction = (name, mode) => {
    const tx = transaction(name, mode);
    if (mode === undefined && !started) {
      started = true; a.setState({ queued: [saved, active], editingQueued: "active" });
      a.beginQueuedDraft("B", "editing B", [], null);
    }
    return tx;
  };
  const stop = await a.watchDraft("other-editor");
  expect(a.getState().editingQueued).toBe("active");
  expect(a.getDraft("A").text).toBe("before A");
  expect(a.getDraft("B").text).toBe("editing B");
  expect(a.getState().queued.map(q => q.id)).toEqual(["saved", "active"]); stop();
});

it("R8: reading the open chat before recovery does not make it oldest", async () => {
  const d = await fresh(); d.getDraft("X");
  const saved = Array.from({ length: 31 }, (_, i) => ({ key: `s${i}`, draft: { text: `t${i}`, images: [], sendId: null } }));
  saved.push({ key: "X", draft: { text: "X newest", images: [], sendId: null } });
  d.restoreDrafts(saved);
  d.replaceDraft("Z", { text: "new words" });
  expect(d.savedDrafts().map(s => s.key)).toEqual([...Array.from({ length: 30 }, (_, i) => `s${i + 1}`), "X", "Z"]);
});

it("X17b: memory typed during recovery survives the next bounded save of 32 slots", async () => {
  const fixture = draftDatabase(), a = await fresh();
  const slots = Array.from({ length: 32 }, (_, i) => ({ key: `saved-${i}`, draft: { text: `words ${i}`, images: [], sendId: null } }));
  fixture.records.set(JSON.stringify("full"), { draft: "words 31", images: [], threadId: "saved-31", editing: null, queued: [], slots });
  a.setState({ threadId: "typed" });
  const transaction = fixture.db.transaction.bind(fixture.db);
  let typed = false;
  fixture.db.transaction = (name, mode) => {
    const tx = transaction(name, mode);
    if (mode === undefined && !typed) { typed = true; a.editDraft("typed during recovery"); }
    return tx;
  };
  const stop = await a.watchDraft("full");
  a.setState({ queued: [] }); await drain(fixture); stop();
  const b = await fresh(), resume = await b.watchDraft("full");
  expect(b.getDraft("typed").text).toBe("typed during recovery");
  expect(b.savedDrafts().map(slot => slot.key)).toEqual([...Array.from({ length: 31 }, (_, i) => `saved-${i + 1}`), "typed"]);
  resume();
});

it.each([true, false])("X19: main's single-draft format migrates into its own slot (editing: %s)", async editing => {
  const fixture = draftDatabase(), a = await fresh();
  const queued = editing ? [{ id: "q", messageId: "copy-id", threadId: "A", text: "queued words", at: 1 }] : [];
  fixture.records.set(JSON.stringify("upgrade"), { format: 2, attachmentsRevision: "old", draft: "saved words", queued, editing: editing ? "q" : null, sendId: "copy-id", sendThreadId: "A" });
  fixture.records.set(JSON.stringify(["upgrade", "attachments"]), { images: ["saved image"], queued: editing ? { q: ["queued image"] } : {} });
  a.setState({ threadId: "B" });
  const transaction = fixture.db.transaction.bind(fixture.db);
  fixture.db.transaction = (name, mode) => { const tx = transaction(name, mode); if (mode === undefined) a.setState({ threadId: "A" }); return tx; };
  const stop = await a.watchDraft("upgrade");
  expect(a.getDraft("A")).toMatchObject({ text: "saved words", images: ["saved image"], sendId: "copy-id" });
  expect(a.getDraft("B").text).toBe("");
  expect(a.getState().editingQueued).toBe(editing ? "q" : null);
  expect(a.getDraft("A").beforeEdit).toEqual(editing ? { text: "", images: [], sendId: null } : undefined);
  if (editing) expect(a.getState().queued).toMatchObject([{ id: "q", images: ["queued image"], held: true }]);
  else expect(a.getState().queued).toEqual([]);
  stop();
});
