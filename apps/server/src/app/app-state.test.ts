import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createApp, type Push } from "../app.ts";
import type { ModelCatalog } from "../runtime/models.ts";
import type { ModelInfo, RuntimeState, RuntimeStatus } from "../runtime/types.ts";
import { openThreadStore } from "../threads/store.ts";
import { MODEL, chatCatalog, rig, settle, until } from "../../test/send-rig.ts";
import { endOf, sendTaken } from "../chat/send-started.ts";

const sweep = vi.hoisted(() => ({ hold: undefined as Promise<void> | undefined, release: undefined as (() => void) | undefined }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...fs,
    readdir: async (...a: Parameters<typeof fs.readdir>) => {
      if (sweep.hold !== undefined && /[\\/]images$/.test(String(a[0]))) await sweep.hold;
      return fs.readdir(...a);
    },
  };
});

const CHAT_MODEL: ModelInfo = { name: MODEL, digest: "d", sizeBytes: 6_600_000_000, modifiedAt: "2026-11-01T00:00:00Z", capabilities: ["completion"] };
const ctx = { clientId: 1 };

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  sweep.release?.();
  sweep.hold = undefined;
  sweep.release = undefined;
  for (const clean of cleanups.splice(0).toReversed()) await clean();
});

function holdSweep(): () => void {
  sweep.hold = new Promise<void>((done) => { sweep.release = done; });
  return () => {
    sweep.release?.();
    sweep.hold = undefined;
  };
}

function appRig({ state, catalog = chatCatalog(), push = () => {}, log = () => {} }: {
  readonly state: () => RuntimeState;
  readonly catalog?: ModelCatalog;
  readonly push?: Push;
  readonly log?: (line: string) => void;
}) {
  const root = path.join(os.homedir(), ".cache", "gates-local-tests");
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(path.join(root, "app-state-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const db = openThreadStore(path.join(dir, "threads.sqlite"));
  const status = (): RuntimeStatus => ({ state: state(), owner: "external", baseUrl: "http://fake" });
  const app = createApp({
    store: db,
    runtime: { status, baseUrl: () => "http://fake", onChange: () => () => {}, ensure: async () => status(), lookIfDown: async () => status() },
    catalog, push, log,
  });
  cleanups.push(async () => { await app.shutdown(); db.close(); });
  return { app, db, h: app.handlers };
}

it("the model list answers with the runtime as it stands once the list is read, not as it stood when the call came in", async () => {
  let state: RuntimeState = "starting";
  let read!: (models: readonly ModelInfo[]) => void;
  const refreshing = new Promise<{ models: readonly ModelInfo[]; changed: boolean }>((done) => { read = (models) => done({ models, changed: true }); });
  const r = appRig({ state: () => state, catalog: { current: () => undefined, refresh: () => refreshing, onChange: () => () => {}, stop: () => {} } });
  const listed = r.h["models.list"]({}, ctx);
  state = "ready";
  read([CHAT_MODEL]);
  expect(await listed).toEqual({ runtime: { state: "ready", owner: "external", baseUrl: "http://fake" }, models: [CHAT_MODEL] });
});

it("a window that cannot be told about a change does not fail the call that made it; the failure is logged", async () => {
  const logged: string[] = [];
  const r = appRig({ state: () => "ready", push: () => { throw new Error("the window is gone"); }, log: (line) => logged.push(line) });
  const thread = await r.h["threads.create"]({ title: "B" }, ctx);
  expect(thread).toMatchObject({ title: "B" });
  expect(logged.some((line) => /^push threads\.\w+ failed: the window is gone$/.test(line)), logged.join("\n")).toBe(true);
});

it("reading the fit table while a reply streams leaves that reply running to its end", async () => {
  const r = rig({ drip: true });
  r.open();
  const { turnId, ended } = await sendTaken(r.app, { threadId: r.thread.id, content: "first", model: MODEL, numCtx: 16384 });
  await until(() => r.events(turnId).some((e) => e.type === "delta"), "the reply's first words");
  await r.h["fit.table"]({}, ctx);
  await settle();
  expect(r.app.activeTurns(), "the reply still runs").toBe(1);
  r.finish();
  await ended;
  expect(r.events(turnId).at(-1)).toMatchObject({ type: "done" });
});

it("once a message has been deleted, the next message in that chat is sent as usual", async () => {
  const r = rig();
  r.open();
  await (await sendTaken(r.app, { threadId: r.thread.id, content: "first", model: MODEL, numCtx: 16384 })).ended;
  const first = r.db.getThread(r.thread.id).messages.find((m) => m.role === "user");
  if (first === undefined) throw new Error("the first question was not saved");
  await r.h["messages.delete"]({ threadId: r.thread.id, messageId: first.id }, ctx);
  await r.h["reply.send"](r.entry("q1", "second"), ctx);
  await endOf(r.app, "q1");
  expect(r.db.getMessage("m-q1")?.content).toBe("second");
});

it("a send waits for the start-up sweep of pasted images before its question is saved", async () => {
  const release = holdSweep();
  const r = rig();
  r.open();
  await r.h["reply.send"](r.entry("q1", "hello"), ctx);
  const ended = endOf(r.app, "q1");
  await settle();
  expect(r.starts(), "nothing started while the sweep runs").toEqual([]);
  expect(r.db.getMessage("m-q1")).toBeUndefined();
  release();
  await ended;
  expect(r.db.getMessage("m-q1")?.content).toBe("hello");
});

it("a chat delete waits for the start-up sweep of pasted images before the chat leaves the store", async () => {
  const release = holdSweep();
  const r = rig();
  let answered = false;
  const deleting = Promise.resolve(r.h["threads.delete"]({ threadId: r.thread.id }, ctx)).then(() => { answered = true; });
  await settle();
  expect(r.db.listThreads().some((t) => t.id === r.thread.id), "the chat is kept while the sweep runs").toBe(true);
  expect(answered).toBe(false);
  release();
  await deleting;
  expect(r.db.listThreads().some((t) => t.id === r.thread.id)).toBe(false);
});

it("a message delete waits for the start-up sweep of pasted images before the message leaves the store", async () => {
  const release = holdSweep();
  const r = rig();
  const message = r.db.appendMessage({ threadId: r.thread.id, role: "user", content: "kept" });
  let answered = false;
  const deleting = Promise.resolve(r.h["messages.delete"]({ threadId: r.thread.id, messageId: message.id }, ctx)).then(() => { answered = true; });
  await settle();
  expect(r.db.getMessage(message.id), "the message is kept while the sweep runs").toBeDefined();
  expect(answered).toBe(false);
  release();
  await deleting;
  expect(r.db.getMessage(message.id)).toBeUndefined();
});
