import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
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
