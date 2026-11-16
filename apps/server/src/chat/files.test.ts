import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AttachedFile } from "@gates-local/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { createApp } from "../app.ts";
import type { TurnSaid } from "../app/turn.ts";
import { createSources } from "../sources/index.ts";
import { openThreadStore } from "../threads/store.ts";
import { chatCatalog, until } from "../../test/send-rig.ts";
import { MAX_FILE_BYTES, checkFiles, fileLifecycle, fileSources, saveFile } from "./files.ts";
import { sendStarted } from "./send-started.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function tmp(): string {
  const base = path.join(os.homedir(), ".cache", "gates-local-tests");
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(path.join(base, "files-"));
  dirs.push(dir);
  return dir;
}

it("a file over 50 MB is refused in plain words and nothing is copied", async () => {
  const dir = tmp();
  const over = "A".repeat(Math.ceil(MAX_FILE_BYTES / 3) * 4 + 4);
  await expect(saveFile(dir, { name: "big.log", type: "", data: over })).rejects.toThrow("big.log is over 50 MB, so it was not attached.");
  expect(existsSync(path.join(dir, "files")) ? readdirSync(path.join(dir, "files")) : []).toEqual([]);
});

// Chat row 35 (3): a malformed upload is not "over 50 MB", and a failed write leaves nothing behind.
it("an upload that is not base64 says it could not be read, and nothing is copied", async () => {
  const dir = tmp();
  await expect(saveFile(dir, { name: "notes.txt", type: "text/plain", data: "not base64!" })).rejects.toThrow("notes.txt could not be read, so it was not attached.");
  expect(existsSync(path.join(dir, "files")) ? readdirSync(path.join(dir, "files")) : []).toEqual([]);
});

it("a write that fails part way leaves no partial copy", async () => {
  const dir = tmp();
  const full = Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
  await expect(saveFile(dir, { name: "notes.txt", type: "text/plain", data: "YQ==" }, async (handle) => { await handle.write(Buffer.from("a")); throw full; })).rejects.toBe(full);
  expect(readdirSync(path.join(dir, "files"))).toEqual([]);
});

it("the sweep also runs on a timer, not only at start-up, until stopped (chat row 35)", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  try {
    const dir = tmp();
    const loose = await saveFile(dir, { name: "b.txt", type: "text/plain", data: "Yg==" });
    const old = (Date.now() - 25 * 60 * 60 * 1000) / 1000;
    utimesSync(path.join(dir, loose.path), old, old);
    const files = fileLifecycle(dir, { fileReferences: () => new Map() }, { sweepEveryMs: 1000 });
    vi.advanceTimersByTime(1000);
    await vi.waitFor(() => expect(existsSync(path.join(dir, loose.path))).toBe(false));
    files.stop();
    const later = await saveFile(dir, { name: "c.txt", type: "text/plain", data: "Yw==" });
    utimesSync(path.join(dir, later.path), old, old);
    vi.advanceTimersByTime(5000);
    await new Promise(resolve => setImmediate(resolve));
    expect(existsSync(path.join(dir, later.path))).toBe(true);
  } finally { vi.useRealTimers(); }
});

it("keep starts a copy's day again so the sweep spares it, and answers the paths already gone (chat row 35)", async () => {
  const dir = tmp();
  const drafted = await saveFile(dir, { name: "a.txt", type: "text/plain", data: "YQ==" });
  const old = (Date.now() - 25 * 60 * 60 * 1000) / 1000;
  utimesSync(path.join(dir, drafted.path), old, old);
  const files = fileLifecycle(dir, { fileReferences: () => new Map() });
  const gone = `files/att-${"0".repeat(8)}-0000-0000-0000-${"0".repeat(12)}`;
  expect(await files.keep([drafted.path, gone, "../threads.sqlite"])).toEqual({ missing: [gone, "../threads.sqlite"] });
  await files.sweep();
  expect(existsSync(path.join(dir, drafted.path))).toBe(true);
});

it("release removes a copy at once, unless a message holds it or a send is carrying it (chat row 35)", async () => {
  const dir = tmp();
  const [loose, held, sending] = await Promise.all(["a", "b", "c"].map(n => saveFile(dir, { name: `${n}.txt`, type: "text/plain", data: "YQ==" })));
  const files = fileLifecycle(dir, { fileReferences: () => new Map([[held!.path, 1]]) });
  const sent = files.sending([sending!.path]);
  await files.release([loose!.path, held!.path, sending!.path]);
  expect([loose, held, sending].map(f => existsSync(path.join(dir, f!.path)))).toEqual([false, true, true]);
  // the send ended without saving it: the next release or sweep may take it
  sent();
  await files.release([sending!.path]);
  expect(existsSync(path.join(dir, sending!.path))).toBe(false);
});

it("the sweep removes a copy no message holds after a day, and keeps a held one and a fresh one", async () => {
  const dir = tmp();
  const held = await saveFile(dir, { name: "a.txt", type: "text/plain", data: "YQ==" });
  const loose = await saveFile(dir, { name: "b.txt", type: "text/plain", data: "Yg==" });
  const fresh = await saveFile(dir, { name: "c.txt", type: "text/plain", data: "Yw==" });
  const old = (Date.now() - 25 * 60 * 60 * 1000) / 1000;
  for (const f of [held, loose]) utimesSync(path.join(dir, f.path), old, old);
  await fileLifecycle(dir, { fileReferences: () => new Map([[held.path, 1]]) }).sweep();
  expect([held, loose, fresh].map(f => existsSync(path.join(dir, f.path)))).toEqual([true, false, true]);
});

const DAY_OLD = () => (Date.now() - 25 * 60 * 60 * 1000) / 1000;

it("a files folder that is a link out of the data folder is refused, and nothing is written where it points", async () => {
  const dir = tmp();
  const outside = tmp();
  symlinkSync(outside, path.join(dir, "files"));
  await expect(saveFile(dir, { name: "a.txt", type: "text/plain", data: "YQ==" })).rejects.toThrow("The attached-files folder is not available.");
  const planted = `att-${"0".repeat(8)}-0000-0000-0000-${"0".repeat(12)}`;
  writeFileSync(path.join(outside, planted), "a");
  await expect(checkFiles(dir, [{ path: `files/${planted}`, name: "a.txt", size: 1, type: "text/plain" }])).rejects.toThrow("The attached-files folder is not available.");
  expect(readdirSync(outside)).toEqual([planted]);
});

it("a sent file takes the size of the copy on disk, whatever size the window said", async () => {
  const dir = tmp();
  const saved = await saveFile(dir, { name: "a.txt", type: "text/plain", data: "YWJjZA==" });
  expect(await checkFiles(dir, [{ ...saved, size: 999 }])).toEqual([{ ...saved, size: 4 }]);
});

it("a file's Library id is its label in lower-case words, numbered on when the Library or another file already has it", async () => {
  const dir = tmp();
  const files = await Promise.all(["Notes.txt", "notes txt", "???"].map(name => saveFile(dir, { name, type: "text/plain", data: "YQ==" })));
  const library = [{ id: "notes-txt", kind: "file" as const, label: "notes.txt", path: "/elsewhere/notes.txt" }];
  const entries = await fileSources(dir, files, library);
  expect([...entries.values()].map(e => e.id)).toEqual(["notes-txt-2", "notes-txt-3", "file"]);
  expect(library.map(e => e.id)).toEqual(["notes-txt"]);
});

it("the first sweep waits the start-up delay before it removes a day-old loose copy", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const dir = tmp();
    const loose = await saveFile(dir, { name: "a.txt", type: "text/plain", data: "YQ==" });
    utimesSync(path.join(dir, loose.path), DAY_OLD(), DAY_OLD());
    const files = fileLifecycle(dir, { fileReferences: () => new Map() }, { firstSweepAfterMs: 1000 });
    vi.advanceTimersByTime(999);
    await files.keep([]);
    expect(existsSync(path.join(dir, loose.path))).toBe(true);
    vi.advanceTimersByTime(1);
    await files.keep([]);
    expect(existsSync(path.join(dir, loose.path))).toBe(false);
    files.stop();
  } finally { vi.useRealTimers(); }
});

it("a copy two saved messages hold stays until the last of them goes", async () => {
  const dir = tmp();
  const shared = await saveFile(dir, { name: "a.txt", type: "text/plain", data: "YQ==" });
  let messages = 2;
  const files = fileLifecycle(dir, { fileReferences: () => new Map(messages ? [[shared.path, messages]] : []) });
  utimesSync(path.join(dir, shared.path), DAY_OLD(), DAY_OLD());
  await files.sweep();
  expect(existsSync(path.join(dir, shared.path))).toBe(true);
  messages--;
  await files.collect([shared.path]);
  expect(existsSync(path.join(dir, shared.path))).toBe(true);
  messages--;
  await files.collect([shared.path]);
  expect(existsSync(path.join(dir, shared.path))).toBe(false);
});

it("collecting or releasing a path that is not a generated copy name removes nothing, inside the files folder or out of it", async () => {
  const dir = tmp();
  await saveFile(dir, { name: "a.txt", type: "text/plain", data: "YQ==" });
  const names = [path.join(dir, "x"), path.join(dir, "threads.sqlite"), path.join(dir, "files", "x"), path.join(dir, "files", "threads.sqlite")];
  for (const name of names) writeFileSync(name, "keep me");
  const files = fileLifecycle(dir, { fileReferences: () => new Map() });
  const stored = ["files/../x", "../threads.sqlite", "files/x", "files/threads.sqlite", "x"];
  await files.collect(stored);
  await files.release(stored);
  expect(names.map(name => existsSync(name))).toEqual([true, true, true, true]);
});

it("a day-old copy a send is carrying survives the sweep, and the sweep after the send settles removes it", async () => {
  const dir = tmp();
  const carried = await saveFile(dir, { name: "a.txt", type: "text/plain", data: "YQ==" });
  utimesSync(path.join(dir, carried.path), DAY_OLD(), DAY_OLD());
  const files = fileLifecycle(dir, { fileReferences: () => new Map() });
  const settled = files.sending([carried.path]);
  await files.sweep();
  expect(existsSync(path.join(dir, carried.path))).toBe(true);
  settled();
  await files.sweep();
  expect(existsSync(path.join(dir, carried.path))).toBe(false);
});

function heldBy(): { fileReferences: () => Map<string, number>; fileOwners: () => Map<string, string>; hold: (threadId: string, files: readonly AttachedFile[]) => string } {
  const owners = new Map<string, string>();
  return {
    fileReferences: () => new Map([...owners.keys()].map(file => [file, 1])),
    fileOwners: () => new Map(owners),
    hold: (threadId, files) => { for (const file of files) if (!owners.has(file.path)) owners.set(file.path, threadId); return threadId; },
  };
}

it("a release that comes while a message with copies is being saved leaves them all to that message", async () => {
  const dir = tmp();
  const attached = await Promise.all(Array.from({ length: 32 }, (_, n) => saveFile(dir, { name: `${n}.txt`, type: "text/plain", data: "YQ==" })));
  const store = heldBy();
  const files = fileLifecycle(dir, store);
  const saved = files.save(attached, () => store.hold("A", attached), "A");
  const released = files.release(attached.map(file => file.path));
  await expect(saved).resolves.toBe("A");
  await released;
  expect(attached.filter(file => !existsSync(path.join(dir, file.path)))).toEqual([]);
});

it("two chats saving one unsent copy at the same moment: the first keeps it and the second is told it is attached in another chat", async () => {
  const dir = tmp();
  const file = await saveFile(dir, { name: "plan.txt", type: "text/plain", data: "YQ==" });
  const store = heldBy();
  const files = fileLifecycle(dir, store);
  const results = await Promise.allSettled([files.save([file], () => store.hold("A", [file]), "A"), files.save([file], () => store.hold("B", [file]), "B")]);
  expect(results).toMatchObject([{ status: "fulfilled", value: "A" }, { status: "rejected", reason: { message: "plan.txt is attached in another chat. Attach it here again; your words are kept." } }]);
  expect(store.fileOwners()).toEqual(new Map([[file.path, "A"]]));
});

const SHOW: unknown = JSON.parse(readFileSync(new URL("../fit/fixtures/show-qwen3-5-9b.json", import.meta.url), "utf8"));
type ToolChat = { messages: { role: string; content: string }[] };
const toolLines = (items: unknown[]) => new Response(items.map(i => JSON.stringify(i)).join("\n") + "\n");

it("a chat's file reaches the read tool by its label for that chat's turn, and the shared Library does not gain it", async () => {
  const dir = tmp();
  const own = path.join(dir, "own.txt");
  writeFileSync(own, "the Library's own file");
  const sources = createSources({ dataDir: path.join(dir, "library") });
  await sources.add({ kind: "file", path: own });
  const before = sources.entries();
  const store = openThreadStore(path.join(dir, "threads.sqlite"));
  const bodies: ToolChat[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const where = new URL(String(url)).pathname;
    if (where === "/api/show") return Response.json(SHOW);
    if (where === "/api/ps") return Response.json({ models: [] });
    if (where === "/api/tags") return Response.json({ models: [{ name: "qwen3.5:9b", size: 6600000000, digest: "d", modified_at: "2026-11-01T00:00:00Z" }] });
    bodies.push(JSON.parse(String(init?.body)) as ToolChat);
    if (bodies.length === 1) return toolLines([{ message: { tool_calls: [{ function: { name: "read", arguments: { path: "/library/report-2026-txt" } } }] }, done: true }]);
    return toolLines([{ message: { content: "Read it." }, done: true }]);
  }));
  const said: TurnSaid[] = [];
  const app = createApp({
    store, dataDir: dir, sources, toolsEnabled: () => true, catalog: chatCatalog(),
    runtime: { status: () => ({ state: "ready", owner: "external", baseUrl: "http://fake" }), baseUrl: () => "http://fake", onChange: () => () => {}, ensure: async () => ({ state: "ready", owner: "external", baseUrl: "http://fake" }), lookIfDown: async () => ({ state: "ready", owner: "external", baseUrl: "http://fake" }) },
    push: () => {}, turnSaid: s => { said.push(s); },
    fit: { runNvidiaSmi: async args => args[0]?.startsWith("--query-gpu") ? "16384, 1024, 15360\n" : "", readMeminfo: async () => "MemAvailable: 32000000 kB\n" },
  });
  try {
    const file = await (app.handlers as Required<typeof app.handlers>)["files.attach"]({ name: "Report 2026.txt", type: "text/plain", data: Buffer.from("WORDS IN THE COPY").toString("base64") }, { clientId: 1 });
    const thread = store.createThread();
    const sent = await sendStarted(app, { threadId: thread.id, content: "what does it say?", model: "qwen3.5:9b", numCtx: 16384, tools: true, files: [file] });
    await until(() => said.some(s => s.turnId === sent.turnId && s.event.type === "done"), "the turn's end");
    expect(bodies[1]?.messages.at(-1)).toMatchObject({ role: "tool", content: expect.stringContaining("WORDS IN THE COPY") });
    expect(sources.entries()).toEqual(before);
    expect(sources.entries().map(e => e.path)).not.toContain(path.join(realpathSync(dir), file.path));
  } finally {
    await app.shutdown();
    store.close();
    vi.unstubAllGlobals();
  }
});
