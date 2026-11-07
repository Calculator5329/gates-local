import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createSources } from "./index.ts";
const children: ChildProcess[] = [];
// One prerequisite probe; do not mistake an unsupported nested process for a snapshot failure.
const writerProbe = spawnSync(process.execPath, ["--version"], { encoding: "utf8", timeout: 2000 });
const writerUnavailable = writerProbe.error && ["EPERM", "EACCES"].includes((writerProbe.error as NodeJS.ErrnoException).code ?? "");
if (writerProbe.error && !writerUnavailable) throw writerProbe.error;
afterEach(() => { for (const child of children.splice(0)) child.kill(); });
const setup = () => {
  const root = mkdtempSync(path.join(tmpdir(), "gl-sources-"));
  const dataDir = path.join(root, "app");
  return { root, dataDir, sources: createSources({ dataDir }) };
};
describe("Library registry", () => {
  it("starts empty, persists explicit additions, refreshes and removes with pushes", async () => {
    const { root, dataDir, sources } = setup();
    expect(sources.list()).toEqual([]);
    const changes: unknown[] = [];
    sources.onChange(list => changes.push(list));
    const file = path.join(root, "notes.txt"); writeFileSync(file, "hello");
    const source = await sources.add({ kind: "file", path: file });
    expect(source).toMatchObject({ sizeBytes: 5, state: "ready", kind: "file" });
    expect(createSources({ dataDir }).list()).toEqual([source]);
    writeFileSync(file, "hello world");
    expect(await sources.refresh(source.id)).toMatchObject({ sizeBytes: 11 });
    sources.remove(source.id);
    expect(sources.list()).toEqual([]);
    expect(changes.length).toBeGreaterThanOrEqual(3);
  });
  it("refuses missing paths, wrong kinds, its own data and aliases or ancestors of it", async () => {
    const { root, dataDir, sources } = setup();
    const alias = path.join(root, "alias"); symlinkSync(dataDir, alias);
    await expect(sources.add({ kind: "file", path: path.join(root, "missing") })).rejects.toThrow();
    await expect(sources.add({ kind: "file", path: root })).rejects.toThrow();
    for (const candidate of [dataDir, alias, root, path.parse(dataDir).root]) await expect(sources.add({ kind: "folder", path: candidate })).rejects.toThrow(/app.*data/i);
    const docs = path.join(root, "docs"); mkdirSync(docs);
    expect(await sources.add({ kind: "folder", path: docs })).toMatchObject({ state: "ready" });
  });
  it("reads only the snapshot until an explicit refresh, retaining the old snapshot", async () => {
    const { root, dataDir, sources } = setup();
    const file = path.join(root, "live.db");
    const live = new DatabaseSync(file);
    live.exec("PRAGMA journal_mode=WAL; CREATE TABLE t(n); INSERT INTO t VALUES(1)");
    try {
      const source = await sources.add({ kind: "sqlite", path: file });
      const read = () => {
        const snapshot = new DatabaseSync(sources.entries()[0]!.snapshotPath!, { readOnly: true });
        try { return snapshot.prepare("SELECT * FROM t").get()?.n; } finally { snapshot.close(); }
      };
      expect(read()).toBe(1);
      live.exec("UPDATE t SET n=2");
      expect(read()).toBe(1);
      await sources.refresh(source.id);
      expect(read()).toBe(2);
      expect(createSources({ dataDir }).list()).toEqual(sources.list());
    } finally { live.close(); }
  });
  it.skipIf(writerUnavailable)(`snapshots a live WAL database consistently while a separate process writes${writerUnavailable ? ` [SKIP: writer process unavailable: ${writerProbe.error?.message}]` : ""}`, async () => {
    const { root, sources } = setup();
    const file = path.join(root, "live.db");
    const db = new DatabaseSync(file);
    db.exec("PRAGMA journal_mode=WAL; CREATE TABLE pair (id INTEGER PRIMARY KEY, value INTEGER); INSERT INTO pair VALUES (1,0),(2,0)");
    const child = spawn(process.execPath, ["--input-type=module", "-e", `import {DatabaseSync} from 'node:sqlite'; const db=new DatabaseSync(process.argv[1]); let n=0; const write=()=>{db.exec('BEGIN IMMEDIATE'); db.prepare('UPDATE pair SET value=?').run(++n); db.exec('COMMIT');}; write(); process.stdout.write('ready\\n'); setInterval(write,1);`, file], { stdio: ["ignore", "pipe", "pipe"] });
    children.push(child);
    let stderr = "";
    child.stderr!.on("data", data => { stderr += String(data); });
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([once(child.stdout!, "data"), once(child, "exit").then(([code]) => { throw new Error(`WAL writer exited ${code}: ${stderr}`); }), new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error(`WAL writer did not become ready (${process.execPath}, pid ${child.pid}): ${stderr}`)), 1500); })]);
    } finally { clearTimeout(deadline); }
    try {
      const source = await sources.add({ kind: "sqlite", path: file });
      for (let i = 0; i < 5; i++) {
        const refreshed = await sources.refresh(source.id);
        expect(refreshed.snapshotAt).toBeTypeOf("number");
        expect(refreshed.sizeBytes).toBeGreaterThan(0);
        const snapshot = new DatabaseSync(sources.entries()[0]!.snapshotPath!, { readOnly: true });
        try { expect(snapshot.prepare("SELECT COUNT(DISTINCT value) AS n FROM pair").get()?.n).toBe(1); expect(snapshot.prepare("PRAGMA integrity_check").get()?.integrity_check).toBe("ok"); }
        finally { snapshot.close(); }
      }
      expect(db.prepare("SELECT value FROM pair LIMIT 1").get()?.value).toBeGreaterThan(0);
    } finally { db.close(); child.kill(); }
  });
});
