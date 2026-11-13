import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { MAX_FILE_BYTES, fileLifecycle, saveFile } from "./files.ts";

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
