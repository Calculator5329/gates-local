import { afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { createSources, SQLITE_FILE_REFUSED } from "./index.ts";
import { createTools, runLoop, type ModelMessage } from "../../../../packages/harness/src/index.ts";
const isSqliteFile = (file: string) => statSync(file).isFile() && readFileSync(file).subarray(0, 16).equals(Buffer.from("SQLite format 3\0", "latin1"));
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
  it("refuses a SQLite database added as a file", async () => {
    const { root, sources } = setup();
    const file = path.join(root, "notes.txt");
    const db = new DatabaseSync(file); db.exec("CREATE TABLE t(n)"); db.close();
    await expect(sources.add({ kind: "file", path: file })).rejects.toThrow(SQLITE_FILE_REFUSED);
    expect(SQLITE_FILE_REFUSED).toBe("This is a SQLite database; add it as a database source so the model reads a snapshot, never the live file.");
    const nearly = path.join(root, "nearly.txt"); writeFileSync(nearly, "SQLite format 3 but text");
    expect(await sources.add({ kind: "file", path: nearly })).toMatchObject({ state: "ready" });
  });
  it("keeps snapshots private and keeps one per source: 0600 files in a 0700 folder, replaced on refresh, deleted on remove", async () => {
    const { root, dataDir, sources } = setup();
    const file = path.join(root, "private.db");
    const live = new DatabaseSync(file); live.exec("CREATE TABLE t(n); INSERT INTO t VALUES(1)"); live.close();
    chmodSync(file, 0o600);
    const snapshots = path.join(dataDir, "snapshots");
    const source = await sources.add({ kind: "sqlite", path: file });
    for (let i = 0; i < 3; i++) await sources.refresh(source.id);
    expect(statSync(snapshots).mode & 0o777).toBe(0o700);
    expect(readdirSync(snapshots, { recursive: true })).toEqual([`${source.id}.db`]);
    expect(statSync(path.join(snapshots, `${source.id}.db`)).mode & 0o777).toBe(0o600);
    sources.remove(source.id);
    expect(readdirSync(snapshots, { recursive: true })).toEqual([]);
  });
  it("migrates the old snapshots/_archive/ layout: after refresh and remove no copy of the database is left (T-04)", async () => {
    const { root, dataDir, sources } = setup();
    const file = path.join(root, "private.db");
    const live = new DatabaseSync(file); live.exec("CREATE TABLE t(n); INSERT INTO t VALUES(1)"); live.close();
    const source = await sources.add({ kind: "sqlite", path: file });
    const keep = await sources.add({ kind: "sqlite", path: file });
    const snapshots = path.join(dataDir, "snapshots");
    // What the first build left: every refresh moved the previous copy to _archive/<id>.<uuid>.db,
    // and remove() left a removed source's copies behind.
    const archive = path.join(snapshots, "_archive"); mkdirSync(archive);
    for (const id of [source.id, source.id, keep.id, "0f9b6c1e-removed-earlier"]) copyFileSync(path.join(snapshots, `${source.id}.db`), path.join(archive, `${id}.${randomUUID()}.db`));
    // A registered source with no current snapshot keeps its newest archived copy.
    const newer = path.join(archive, `${keep.id}.${randomUUID()}.db`);
    const db = new DatabaseSync(newer); db.exec("CREATE TABLE t(n); INSERT INTO t VALUES(2)"); db.close();
    utimesSync(newer, new Date(), new Date(Date.now() + 60000));
    rmSync(path.join(snapshots, `${keep.id}.db`));
    const reopened = createSources({ dataDir });
    await reopened.refresh(source.id);
    reopened.remove(source.id);
    const copies = (readdirSync(dataDir, { recursive: true }) as string[]).map(name => path.join(dataDir, name)).filter(isSqliteFile);
    expect(copies).toEqual([path.join(snapshots, `${keep.id}.db`)]);
    expect(existsSync(archive)).toBe(false);
    const kept = new DatabaseSync(copies[0]!, { readOnly: true });
    try { expect(kept.prepare("SELECT n FROM t").get()?.n).toBe(2); } finally { kept.close(); }
    expect(statSync(copies[0]!).mode & 0o777).toBe(0o600);
  });
  for (const registry of ["corrupt", "missing"] as const) {
    it(`a ${registry} sources.json leaves an archive-only database copy untouched, set aside as _archive-unclaimed-* (T2-01)`, () => {
      const { dataDir } = setup();
      const snapshots = path.join(dataDir, "snapshots");
      const archive = path.join(snapshots, "_archive"); mkdirSync(archive, { recursive: true });
      // The live database and its current snapshot are gone; this is the last copy.
      const copy = path.join(archive, `${randomUUID()}.${randomUUID()}.db`);
      const db = new DatabaseSync(copy); db.exec("CREATE TABLE t(n); INSERT INTO t VALUES(7)"); db.close();
      chmodSync(copy, 0o644);
      const bytes = readFileSync(copy);
      // A current snapshot the registry can no longer claim stays too.
      const stray = path.join(snapshots, `${randomUUID()}.db`); writeFileSync(stray, "stray snapshot");
      if (registry === "corrupt") writeFileSync(path.join(dataDir, "sources.json"), "{not json");
      const log = vi.fn();
      const sources = createSources({ dataDir, now: () => 1234, log });
      expect(sources.list()).toEqual([]);
      const survivors = (readdirSync(dataDir, { recursive: true }) as string[]).filter(name => statSync(path.join(dataDir, name)).isFile() && readFileSync(path.join(dataDir, name)).equals(bytes));
      expect(survivors).toEqual([path.join("snapshots", "_archive-unclaimed-1234", path.basename(copy))]);
      const unclaimed = path.join(snapshots, "_archive-unclaimed-1234");
      expect(existsSync(archive)).toBe(false);
      expect(readFileSync(path.join(unclaimed, path.basename(copy)))).toEqual(bytes);
      expect(statSync(unclaimed).mode & 0o777).toBe(0o700);
      expect(statSync(path.join(unclaimed, path.basename(copy))).mode & 0o777).toBe(0o600);
      expect(existsSync(path.join(dataDir, "sources.json.bad-1234"))).toBe(registry === "corrupt");
      expect(readFileSync(stray, "utf8")).toBe("stray snapshot");
      expect(log).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`_archive-unclaimed-1234.*${registry === "corrupt" ? "could not be read" : "missing"}`)));
    });
  }
  it("later starts, adds and removes never touch an _archive-unclaimed-* folder (T2-01)", async () => {
    const { root, dataDir } = setup();
    const unclaimed = path.join(dataDir, "snapshots", "_archive-unclaimed-1234"); mkdirSync(unclaimed, { recursive: true });
    const copy = path.join(unclaimed, `${randomUUID()}.${randomUUID()}.db`);
    const db = new DatabaseSync(copy); db.exec("CREATE TABLE t(n)"); db.close();
    const bytes = readFileSync(copy);
    const file = path.join(root, "live.db");
    const live = new DatabaseSync(file); live.exec("CREATE TABLE t(n)"); live.close();
    for (const registry of ["missing", "[]", "{not json"]) {
      if (registry !== "missing") writeFileSync(path.join(dataDir, "sources.json"), registry);
      const sources = createSources({ dataDir });
      const source = await sources.add({ kind: "sqlite", path: file });
      await sources.refresh(source.id);
      sources.remove(source.id);
      rmSync(path.join(dataDir, "sources.json"), { force: true });
    }
    expect(readFileSync(copy)).toEqual(bytes);
  });
  it("a database removed between source capture and the tool call is named in the observation, with no host path (T-05)", async () => {
    const { root, dataDir, sources } = setup();
    const file = path.join(root, "ledger.db");
    const live = new DatabaseSync(file); live.exec("CREATE TABLE t(n); INSERT INTO t VALUES(1)"); live.close();
    const source = await sources.add({ kind: "sqlite", path: file, label: "Ledger" });
    const captured = sources.entries(); // what a turn holds from its start
    sources.remove(source.id);
    const calls = { linux: { name: "shell", arguments: { command: `sqlite3 /data/${source.id}.db "SELECT * FROM t"` } }, win32: { name: "sql", arguments: { source: source.id, query: "SELECT * FROM t" } } };
    for (const platform of ["linux", "win32"] as const) {
      const tools = createTools({ sources: captured, platform });
      const requests: ModelMessage[][] = [];
      const stream = async function* (messages: readonly ModelMessage[]) {
        requests.push([...messages]);
        yield { type: "complete" as const, content: requests.length === 1 ? "" : "Done.", calls: requests.length === 1 ? [calls[platform]] : [], stopReason: "stop" };
      };
      for await (const _ of runLoop({ messages: [], native: true, signal: new AbortController().signal, stream, execute: tools.execute })) { /* drain */ }
      const observation = requests[1]!.find(m => m.role === "tool")!.content;
      // The shell names the path the model used (T2-02); the Windows sql tool names the source.
      expect(observation, platform).toBe(platform === "linux" ? `/data/${source.id}.db: no longer available (the source was removed during this reply)` : "The source Ledger was removed during this reply.");
      expect(observation).not.toContain(dataDir);
      expect(observation).not.toContain("snapshots/");
    }
  });
  it("a failed snapshot leaves no pending file and records the error", async () => {
    const { root, dataDir, sources } = setup();
    const file = path.join(root, "live.db");
    const live = new DatabaseSync(file); live.exec("CREATE TABLE t(n)"); live.close();
    const source = await sources.add({ kind: "sqlite", path: file });
    const snapshots = path.join(dataDir, "snapshots");
    // A folder where the snapshot goes makes the final rename fail after VACUUM INTO wrote the pending copy.
    rmSync(path.join(snapshots, `${source.id}.db`)); mkdirSync(path.join(snapshots, `${source.id}.db`));
    expect(await sources.refresh(source.id)).toMatchObject({ state: "error" });
    expect(readdirSync(snapshots).filter(name => name.endsWith(".pending.db"))).toEqual([]);
  });
  it("a source mid-refresh loads back as its last good state", async () => {
    const { root, dataDir, sources } = setup();
    const file = path.join(root, "live.db");
    const live = new DatabaseSync(file); live.exec("CREATE TABLE t(n)"); live.close();
    const source = await sources.add({ kind: "sqlite", path: file });
    const refreshing = sources.refresh(source.id);
    expect(sources.list()[0]).toMatchObject({ state: "refreshing" });
    expect(createSources({ dataDir }).list()).toEqual([source]);
    await refreshing;
    // An older registry that did persist "refreshing" loads as ready while the snapshot exists.
    writeFileSync(path.join(dataDir, "sources.json"), JSON.stringify([{ ...source, state: "refreshing" }]));
    expect(createSources({ dataDir }).list()).toMatchObject([{ id: source.id, state: "ready" }]);
  });
  it("makes the snapshot off the event loop", async () => {
    const { root, sources } = setup();
    const file = path.join(root, "big.db");
    const live = new DatabaseSync(file);
    live.exec("CREATE TABLE t(b); WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM c WHERE i < 40) INSERT INTO t SELECT randomblob(1048576) FROM c");
    live.close();
    const source = await sources.add({ kind: "sqlite", path: file });
    let last = performance.now();
    let maxGap = 0;
    const tick = setInterval(() => { const t = performance.now(); maxGap = Math.max(maxGap, t - last); last = t; }, 1);
    const started = performance.now();
    try { await sources.refresh(source.id); } finally { clearInterval(tick); }
    const duration = performance.now() - started;
    maxGap = Math.max(maxGap, performance.now() - last);
    expect(duration).toBeGreaterThan(20);
    expect(maxGap).toBeLessThan(duration / 2);
  });
  it("keeps a corrupt sources.json aside and starts with no sources", () => {
    const { dataDir } = setup();
    writeFileSync(path.join(dataDir, "sources.json"), "{not json");
    const log = vi.fn();
    const sources = createSources({ dataDir, now: () => 1234, log });
    expect(sources.list()).toEqual([]);
    expect(readFileSync(path.join(dataDir, "sources.json.bad-1234"), "utf8")).toBe("{not json");
    expect(existsSync(path.join(dataDir, "sources.json"))).toBe(false);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("sources.json.bad-1234"));
  });
  it("reads only the snapshot until an explicit refresh", async () => {
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
    // ~2000 rows of 900 bytes span ~500 pages; every transaction rewrites all of them, adds rows,
    // and keeps meta.total equal to the row count. A torn snapshot breaks one of those two facts.
    db.exec(`PRAGMA journal_mode=WAL; CREATE TABLE rows (id INTEGER PRIMARY KEY, gen INTEGER, pad BLOB); CREATE TABLE meta (total INTEGER);
      WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM c WHERE i < 2000) INSERT INTO rows (gen, pad) SELECT 0, randomblob(900) FROM c;
      INSERT INTO meta VALUES (2000)`);
    const writer = `import {DatabaseSync} from 'node:sqlite'; const db=new DatabaseSync(process.argv[1]); let n=0;
      const write=()=>{ const k=1+(n++%7); db.exec('BEGIN IMMEDIATE'); db.exec('UPDATE rows SET gen=gen+1, pad=randomblob(900)');
        for (let i=0;i<k;i++) db.exec('INSERT INTO rows (gen, pad) VALUES ((SELECT gen FROM rows LIMIT 1), randomblob(900))');
        db.prepare('UPDATE meta SET total=total+?').run(k); db.exec('COMMIT'); };
      write(); process.stdout.write('ready\\n'); setInterval(write,1);`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", writer, file], { stdio: ["ignore", "pipe", "pipe"] });
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
        try {
          const { rows, total } = snapshot.prepare("SELECT (SELECT COUNT(*) FROM rows) AS rows, (SELECT total FROM meta) AS total").get()!;
          expect(total).toBe(rows);
          expect(snapshot.prepare("SELECT COUNT(DISTINCT gen) AS n FROM rows").get()?.n).toBe(1);
          expect(snapshot.prepare("PRAGMA integrity_check").get()?.integrity_check).toBe("ok");
        } finally { snapshot.close(); }
      }
      expect(db.prepare("SELECT gen FROM rows LIMIT 1").get()?.gen).toBeGreaterThan(0);
    } finally { db.close(); child.kill(); }
  });
});
