import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { realFileOps, type FileOps } from "./files.ts";
import { approve, readTransaction, transactionFile, UnreadableTransaction, writeIntent, type InstalledTransaction } from "./transaction.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function dataDir(): string {
  const root = mkdtempSync(path.join(tmpdir(), "iu-transaction-")); roots.push(root);
  mkdirSync(path.join(root, "updates"));
  return root;
}
const artifact = { platform: "linux", arch: "x64", kind: "appimage", file: "Gates-Local-1.5.0-x86_64.AppImage", size: 12, sha512: "a".repeat(128) } as const;
const record = (pid: number) => ({ pid, start: `boot:${pid}`, uptime: 100 });
function approved(dir: string): InstalledTransaction {
  return approve({ id: "t-1", copy: { program: "/apps/Gates-Local.AppImage", dataDir: dir }, from: "1.4.0", to: "1.5.0", listDigest: "b".repeat(128), artifact, uptime: 1000, boot: "boot-a", main: record(10), server: record(11) });
}

it("H: the approval carries the copy, versions, pins, deadline as uptime + 30 s with the boot id, and both process records", () => {
  const tx = approved("/d");
  expect(tx).toMatchObject({ version: 1, id: "t-1", intent: "approved", deadline: { uptime: 1030, boot: "boot-a" }, processes: { main: record(10), server: record(11) }, artifact, listDigest: "b".repeat(128) });
});

it("an intent reads back as written, including the later rows' fields", () => {
  const dir = dataDir(); const file = transactionFile(dir);
  const tx: InstalledTransaction = { ...approved(dir), intent: "launch-old", old: { size: 3, sha512: "c".repeat(128) }, new: { size: 12, sha512: "a".repeat(128) }, storeBefore: 4,
    t1: { token: "T1", boot: "boot-a", record: record(20) }, t2: { token: "T2", boot: "boot-a", spawnFailed: true } };
  writeIntent(file, tx);
  expect(readTransaction(file)).toEqual(tx);
});

it("writes the file, flushes it, renames it into place, then flushes the folder, in that order", () => {
  const dir = dataDir(); const file = transactionFile(dir); const calls: string[] = [];
  const ops: FileOps = { ...realFileOps,
    writeFile: (f, d, m) => { calls.push(`write ${path.basename(f)}`); realFileOps.writeFile(f, d, m); },
    rename: (a, b) => { calls.push(`rename ${path.basename(a)} ${path.basename(b)}`); realFileOps.rename(a, b); },
    fsyncDir: d => { calls.push(`flush ${path.relative(dir, d)}`); realFileOps.fsyncDir(d); } };
  writeIntent(file, approved(dir), ops);
  expect(calls).toEqual(["write installed-update.json.tmp", "rename installed-update.json.tmp installed-update.json", "flush updates"]);
});

it("a write that fails leaves the previous intent whole: a reader never sees half a file", () => {
  const dir = dataDir(); const file = transactionFile(dir);
  writeIntent(file, approved(dir));
  const before = readFileSync(file, "utf8");
  const failing: FileOps = { ...realFileOps, rename: () => { throw Object.assign(new Error("no space"), { code: "ENOSPC" }); } };
  expect(() => writeIntent(file, { ...approved(dir), intent: "identified", old: { size: 1, sha512: "d".repeat(128) }, new: { size: 12, sha512: "a".repeat(128) }, storeBefore: 1 }, failing)).toThrow("no space");
  expect(readFileSync(file, "utf8")).toBe(before);
  expect(readTransaction(file)?.intent).toBe("approved");
});

it("no file is no transaction; a file that does not decode is refused, never guessed at", () => {
  const dir = dataDir(); const file = transactionFile(dir);
  expect(readTransaction(file)).toBeNull();
  const bad = (value: unknown) => { writeFileSync(file, JSON.stringify(value)); return () => readTransaction(file); };
  const good = { ...approved(dir) };
  expect(bad({ ...good, intent: "replace" })).toThrow(UnreadableTransaction); // replace without old, new and storeBefore
  expect(bad({ ...good, intent: "launch-new", old: { size: 1, sha512: "d".repeat(128) }, new: { size: 1, sha512: "d".repeat(128) }, storeBefore: 1 })).toThrow(UnreadableTransaction); // no T1
  expect(bad({ ...good, intent: "cleanup" })).toThrow(UnreadableTransaction); // no ending
  expect(bad({ ...good, intent: "sideways" })).toThrow(UnreadableTransaction);
  expect(bad({ ...good, artifact: { ...artifact, sha512: "short" } })).toThrow(UnreadableTransaction);
  expect(bad({ ...good, processes: { main: record(10) } })).toThrow(UnreadableTransaction);
  expect(bad({ ...good, version: 2 })).toThrow(UnreadableTransaction);
  // The versions and the id name folders and files; none may lead out of them.
  expect(bad({ ...good, to: "../../elsewhere" })).toThrow(UnreadableTransaction);
  expect(bad({ ...good, from: "v1.4.0" })).toThrow(UnreadableTransaction);
  expect(bad({ ...good, id: "x/../../y" })).toThrow(UnreadableTransaction);
  // A saved process record always wins, so a launch that has one cannot also say its spawn failed.
  const ids = { old: { size: 1, sha512: "d".repeat(128) }, new: { size: 1, sha512: "d".repeat(128) }, storeBefore: 1 };
  expect(bad({ ...good, ...ids, intent: "stop-new", t1: { token: "T1", boot: "boot-a", record: record(20), spawnFailed: true } })).toThrow(UnreadableTransaction);
  writeFileSync(file, "{ half a fi");
  expect(() => readTransaction(file)).toThrow(UnreadableTransaction);
});
