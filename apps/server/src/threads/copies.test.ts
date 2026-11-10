import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderStatusPage } from "../../../desktop/src/status-page.ts";
import { StoreCopyError } from "./errors.ts";
import { ensureMessageColumns, LATEST_VERSION, migrate, MIGRATIONS, type Migration } from "./migrations.ts";

let dir: string;
const connections: DatabaseSync[] = [];
// Read once: one test below pretends to be Windows.
const platform = process.platform;
const windows = platform === "win32";
beforeEach(() => {
  const cache = join(homedir(), ".cache");
  fs.mkdirSync(cache, { recursive: true });
  dir = fs.mkdtempSync(join(cache, "store-copy-test-"));
});
afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process, "platform", { value: platform });
  for (const db of connections.splice(0)) db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function connect(path: string, readOnly = false): DatabaseSync {
  const db = new DatabaseSync(path, { readOnly, timeout: 5_000 });
  connections.push(db);
  return db;
}
function version(db: DatabaseSync): unknown {
  return db.prepare("PRAGMA user_version").get()?.["user_version"];
}
function fixture(v: number): { db: DatabaseSync; path: string } {
  const path = join(dir, "threads.sqlite");
  const db = connect(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0");
  migrate(db, path, MIGRATIONS.slice(0, v));
  db.exec("INSERT INTO threads VALUES ('t', 'Before upgrade', 1, 1); INSERT INTO messages (id, thread_id, role, content, created_at) VALUES ('checkpointed', 't', 'user', 'On disk', 1); PRAGMA wal_checkpoint(TRUNCATE)");
  db.exec("INSERT INTO threads VALUES ('wal-thread', 'Only in WAL', 2, 2); INSERT INTO messages (id, thread_id, role, content, created_at) VALUES ('wal-message', 'wal-thread', 'assistant', 'Only in WAL', 2)");
  return { db, path };
}
function saved(v: number): DatabaseSync {
  return connect(join(dir, "store-copies", `threads.v${v}.sqlite`), true);
}
function files(): string[] {
  const folder = join(dir, "store-copies");
  return fs.existsSync(folder) ? fs.readdirSync(folder).toSorted() : [];
}

describe("copies before schema upgrades", () => {
  it.each([LATEST_VERSION - 1, LATEST_VERSION - 2])("durably saves every row, including WAL, at version %s before the first step", old => {
    const { db, path } = fixture(old);
    expect(fs.statSync(`${path}-wal`).size).toBeGreaterThan(0);
    const mainOnly = join(dir, "main-only.sqlite");
    fs.copyFileSync(path, mainOnly);
    expect(connect(mainOnly, true).prepare("SELECT count(*) AS n FROM messages").get()).toEqual({ n: 1 });
    const events: string[] = [];
    const sync = fs.fsyncSync;
    vi.spyOn(fs, "fsyncSync").mockImplementation(fd => {
      events.push(fs.fstatSync(fd).isDirectory() ? "directory sync" : "file sync");
      sync(fd);
    });
    const rename = fs.renameSync;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      events.push("rename"); rename(from, to);
    });
    const steps = MIGRATIONS.map(step => ({ ...step, up: (d: DatabaseSync) => {
      events.push("step");
      const copy = saved(old);
      expect(version(copy)).toBe(old);
      expect(copy.prepare("SELECT id FROM threads ORDER BY id").all()).toEqual([{ id: "t" }, { id: "wal-thread" }]);
      expect(copy.prepare("SELECT content FROM messages ORDER BY seq").all()).toEqual([{ content: "On disk" }, { content: "Only in WAL" }]);
      expect(events).toContain("file sync");
      expect(events.indexOf("file sync")).toBeLessThan(events.indexOf("rename"));
      // Windows cannot flush a folder. Elsewhere: the new folder's parent
      // before the rename, the folder itself after it.
      if (!windows) {
        expect(events.slice(0, events.indexOf("rename"))).toContain("directory sync");
        expect(events.slice(events.indexOf("rename") + 1, events.indexOf("step"))).toContain("directory sync");
      }
      step.up(d);
    } }));
    expect(migrate(db, path, steps)).toBe(LATEST_VERSION);
    expect(files()).toEqual([`threads.v${old}.sqlite`]);
    if (windows) return; // no owner-only modes there
    expect(fs.statSync(join(dir, "store-copies")).mode & 0o777).toBe(0o700);
    expect(fs.statSync(join(dir, "store-copies", `threads.v${old}.sqlite`)).mode & 0o777).toBe(0o600);
  });

  it.skipIf(windows)("closes a copies folder that was left open to other accounts", () => {
    const { db, path } = fixture(3);
    fs.mkdirSync(join(dir, "store-copies"), { mode: 0o755 });
    fs.chmodSync(join(dir, "store-copies"), 0o755);
    migrate(db, path);
    expect(fs.statSync(join(dir, "store-copies")).mode & 0o777).toBe(0o700);
  });

  it("saves the copy on Windows, where a folder cannot be flushed and a file only through a handle that may write", () => {
    const { db, path } = fixture(3);
    Object.defineProperty(process, "platform", { value: "win32" });
    const open = fs.openSync;
    const readOnly = new Set<number>();
    vi.spyOn(fs, "openSync").mockImplementation((file, flags, mode) => {
      const fd = open(file, flags, mode);
      if (flags === undefined || flags === "r") readOnly.add(fd); else readOnly.delete(fd);
      return fd;
    });
    const sync = fs.fsyncSync;
    vi.spyOn(fs, "fsyncSync").mockImplementation(fd => {
      if (readOnly.has(fd)) throw Object.assign(new Error("EPERM: operation not permitted, fsync"), { code: "EPERM" });
      sync(fd);
    });
    expect(migrate(db, path)).toBe(LATEST_VERSION);
    expect(version(saved(3))).toBe(3);
    expect(saved(3).prepare("SELECT count(*) AS n FROM messages").get()).toEqual({ n: 2 });
  });

  it.each(["another.sqlite", "gone.sqlite"])("refuses to upgrade a real store when the path it was given names %s", name => {
    const { db } = fixture(3);
    const supplied = join(dir, "elsewhere", name);
    fs.mkdirSync(join(dir, "elsewhere"));
    if (name === "another.sqlite") connect(supplied).exec("CREATE TABLE unrelated (n INTEGER)");
    const step = vi.fn((d: DatabaseSync) => MIGRATIONS[3]!.up(d));
    expect(() => migrate(db, supplied, [...MIGRATIONS.slice(0, 3), { version: 4, up: step }, MIGRATIONS[4]!]))
      .toThrow("because the chat database file is not where it was opened.");
    expect(step).not.toHaveBeenCalled();
    expect(version(db)).toBe(3);
    expect(fs.existsSync(join(dir, "store-copies"))).toBe(false);
    expect(fs.existsSync(join(dir, "elsewhere", "store-copies"))).toBe(false);
  });

  it.each([5, 261])("says another program is using the chats when SQLite reports busy (%s)", errcode => {
    const { db, path } = fixture(3);
    const exec = db.exec.bind(db);
    vi.spyOn(db, "exec").mockImplementation(sql => {
      if (sql.startsWith("VACUUM INTO")) throw Object.assign(new Error("database is locked"), { code: "ERR_SQLITE_ERROR", errcode });
      exec(sql);
    });
    expect(() => migrate(db, path)).toThrow("Gates Local could not save a copy of your chats before upgrading them, because another program, most likely another copy of Gates Local, is using your chats. Close it and start Gates Local again. Nothing was changed.");
    expect(version(db)).toBe(3);
    expect(files()).toEqual([]);
  });

  it("reports the first cause when the unfinished temporary file cannot be removed either", () => {
    const { db, path } = fixture(3);
    const exec = db.exec.bind(db);
    vi.spyOn(db, "exec").mockImplementation(sql => {
      if (sql.startsWith("VACUUM INTO")) throw Object.assign(new Error("injected failure"), { code: "ENOSPC" });
      exec(sql);
    });
    vi.spyOn(fs, "unlinkSync").mockImplementation(() => { throw Object.assign(new Error("injected failure"), { code: "EPERM" }); });
    expect(() => migrate(db, path)).toThrow("because the disk is full.");
    expect(version(db)).toBe(3);
    expect(files()).toEqual([expect.stringMatching(/^\.copy-.*\.sqlite$/)]);
  });

  it("keeps the raw failure as the cause, so the log names the call that failed", () => {
    const { db, path } = fixture(3);
    const raw = Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM", syscall: "rename" });
    vi.spyOn(fs, "renameSync").mockImplementation(() => { throw raw; });
    vi.spyOn(Atomics, "wait").mockReturnValue("timed-out");
    let thrown: unknown;
    try { migrate(db, path); } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(StoreCopyError);
    expect((thrown as StoreCopyError).message).toContain("because permission to save the copy was denied.");
    expect((thrown as StoreCopyError).cause).toBe(raw);
  });

  // Measured on Windows 11: with two openers saving the same copy name at
  // once, the final rename was refused with EPERM in 3 of 28 runs.
  it.each(["EPERM", "EACCES", "EBUSY"])("on Windows, tries a rename refused with %s again and saves the copy", code => {
    const { db, path } = fixture(3);
    Object.defineProperty(process, "platform", { value: "win32" });
    const waits = vi.spyOn(Atomics, "wait").mockReturnValue("timed-out");
    const rename = fs.renameSync;
    let refusals = 2;
    const calls = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (refusals-- > 0) throw Object.assign(new Error(`${code}: refused, rename`), { code });
      rename(from, to);
    });
    expect(migrate(db, path)).toBe(LATEST_VERSION);
    expect(calls).toHaveBeenCalledTimes(3);
    expect(waits).toHaveBeenCalledTimes(2);
    expect(version(saved(3))).toBe(3);
    expect(files()).toEqual(["threads.v3.sqlite"]);
  });

  it("on Windows, a rename still refused after two seconds stops the start with nothing changed", () => {
    const { db, path } = fixture(3);
    Object.defineProperty(process, "platform", { value: "win32" });
    let waited = 0;
    vi.spyOn(Atomics, "wait").mockImplementation(((_cells: unknown, _index: number, _value: unknown, ms?: number) => {
      waited += ms ?? 0;
      return "timed-out";
    }) as typeof Atomics.wait);
    const raw = Object.assign(new Error("EBUSY: resource busy or locked, rename"), { code: "EBUSY" });
    vi.spyOn(fs, "renameSync").mockImplementation(() => { throw raw; });
    let thrown: unknown;
    try { migrate(db, path); } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(StoreCopyError);
    expect((thrown as StoreCopyError).cause).toBe(raw);
    expect(waited).toBeGreaterThanOrEqual(2_000);
    expect(waited).toBeLessThan(2_500);
    expect(version(db)).toBe(3);
    expect(files()).toEqual([]);
  });

  it("on Windows, does not wait on a failure that waiting cannot fix", () => {
    const { db, path } = fixture(3);
    Object.defineProperty(process, "platform", { value: "win32" });
    const waits = vi.spyOn(Atomics, "wait").mockReturnValue("timed-out");
    const calls = vi.spyOn(fs, "renameSync").mockImplementation(() => { throw Object.assign(new Error("ENOSPC: no space left on device, rename"), { code: "ENOSPC" }); });
    expect(() => migrate(db, path)).toThrow("because the disk is full.");
    expect(calls).toHaveBeenCalledTimes(1);
    expect(waits).not.toHaveBeenCalled();
  });

  it.skipIf(windows)("away from Windows, a refused rename is a real permission problem and is not tried again", () => {
    const { db, path } = fixture(3);
    const waits = vi.spyOn(Atomics, "wait").mockReturnValue("timed-out");
    const calls = vi.spyOn(fs, "renameSync").mockImplementation(() => { throw Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" }); });
    expect(() => migrate(db, path)).toThrow("because permission to save the copy was denied.");
    expect(calls).toHaveBeenCalledTimes(1);
    expect(waits).not.toHaveBeenCalled();
  });

  it("starts when a copy that turned out not to be needed cannot be removed", () => {
    const { db, path } = fixture(3);
    const other = connect(path);
    const exec = db.exec.bind(db);
    let raced = false;
    vi.spyOn(db, "exec").mockImplementation(sql => {
      if (!raced && sql.startsWith("VACUUM INTO")) {
        raced = true;
        migrate(other, path);
        vi.spyOn(fs, "unlinkSync").mockImplementation(() => { throw Object.assign(new Error("injected failure"), { code: "EBUSY" }); });
      }
      exec(sql);
    });
    expect(migrate(db, path)).toBe(LATEST_VERSION);
    expect(files()).toEqual([expect.stringMatching(/^\.copy-.*\.sqlite$/), "threads.v3.sqlite"]);
    expect(version(saved(3))).toBe(3);
  });

  it.each(["vacuum", "read-back", "rename", "file-sync", ...(windows ? [] : ["directory-sync"])])("stops before any step and removes only its temporary file on %s failure", point => {
    const { db, path } = fixture(3);
    const folder = join(dir, "store-copies");
    fs.mkdirSync(folder);
    fs.writeFileSync(join(folder, "unrelated"), "keep");
    fs.writeFileSync(join(folder, "threads.v2.sqlite"), "older copy");
    const failure = Object.assign(new Error("injected failure"), { code: point === "vacuum" ? "ENOSPC" : "EACCES" });
    if (point === "vacuum") {
      const exec = db.exec.bind(db);
      vi.spyOn(db, "exec").mockImplementation(sql => {
        if (sql.startsWith("VACUUM INTO")) throw failure;
        exec(sql);
      });
    } else if (point === "read-back") {
      const prepare = DatabaseSync.prototype.prepare;
      vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (this: DatabaseSync, sql) {
        if (this.location()?.includes(".copy-")) throw failure;
        return prepare.call(this, sql);
      });
    } else if (point === "rename") {
      vi.spyOn(fs, "renameSync").mockImplementation(() => { throw failure; });
      vi.spyOn(Atomics, "wait").mockReturnValue("timed-out");
    } else {
      const sync = fs.fsyncSync;
      vi.spyOn(fs, "fsyncSync").mockImplementation(fd => {
        if (fs.fstatSync(fd).isDirectory() === (point === "directory-sync")) throw failure;
        sync(fd);
      });
    }
    const step = vi.fn((d: DatabaseSync) => MIGRATIONS[3]!.up(d));
    let error: unknown;
    try { migrate(db, path, [...MIGRATIONS.slice(0, 3), { version: 4, up: step }, MIGRATIONS[4]!]); }
    catch (caught) { error = caught; }
    expect(error).toMatchObject({ name: "StoreCopyError", code: "store-copy-failed", dbPath: path });
    expect(error).toBeInstanceOf(StoreCopyError);
    if (point === "vacuum") expect(error).toHaveProperty("message", "Gates Local could not save a copy of your chats before upgrading them, because the disk is full. Free some space and start it again. Nothing was changed.");
    else expect(error).toHaveProperty("message", expect.stringContaining("permission"));
    expect(version(db)).toBe(3);
    expect(step).not.toHaveBeenCalled();
    expect(files()).toEqual(point === "directory-sync" ? ["threads.v2.sqlite", "threads.v3.sqlite", "unrelated"] : ["threads.v2.sqlite", "unrelated"]);
    expect(fs.readFileSync(join(folder, "threads.v2.sqlite"), "utf8")).toBe("older copy");
    if (point === "directory-sync") expect(version(saved(3))).toBe(3);
  });

  it("retains the original and intermediate copies after a committed step and a later failure", () => {
    const { db, path } = fixture(3);
    const bad: Migration = { version: 5, up: () => { throw new Error("later step failed"); } };
    expect(() => migrate(db, path, [...MIGRATIONS.slice(0, 4), bad])).toThrow("later step failed");
    expect(version(db)).toBe(4);
    const reopened = connect(path);
    expect(migrate(reopened, path)).toBe(LATEST_VERSION);
    expect(files()).toEqual(["threads.v3.sqlite", "threads.v4.sqlite"]);
    for (const v of [3, 4]) {
      const copy = saved(v);
      expect(version(copy)).toBe(v);
      expect(copy.prepare("SELECT count(*) AS n FROM messages").get()).toEqual({ n: 2 });
    }
  });

  it("names a racing copy by its snapshot and discards a snapshot already at latest", () => {
    const { db, path } = fixture(3);
    const other = connect(path);
    const exec = db.exec.bind(db);
    let raced = false;
    vi.spyOn(db, "exec").mockImplementation(sql => {
      if (!raced && sql.startsWith("VACUUM INTO")) {
        raced = true;
        migrate(other, path, MIGRATIONS.slice(0, 4));
      }
      exec(sql);
    });
    migrate(db, path);
    expect(files()).toEqual(["threads.v3.sqlite", "threads.v4.sqlite"]);
    expect(version(saved(3))).toBe(3);
    expect(version(saved(4))).toBe(4);
    // Repeat with an additional step: the other connection finishes it before VACUUM.
    const next = [...MIGRATIONS, { version: 6, up: (d: DatabaseSync) => d.exec("CREATE TABLE extra (n INTEGER)") }];
    raced = false;
    vi.mocked(db.exec).mockImplementation(sql => {
      if (!raced && sql.startsWith("VACUUM INTO")) { raced = true; migrate(other, path, next); }
      exec(sql);
    });
    expect(migrate(db, path, next)).toBe(6);
    expect(files()).toEqual(["threads.v3.sqlite", "threads.v4.sqlite", "threads.v5.sqlite"]);
    expect(version(saved(5))).toBe(5);
  });

  it("two simultaneous connections both copy and never run a step twice", async () => {
    const { path } = fixture(3);
    const barrier = new SharedArrayBuffer(4);
    const source = `
      const { workerData } = require('node:worker_threads');
      const { DatabaseSync } = require('node:sqlite');
      (async () => {
        const { migrate, MIGRATIONS } = await import(workerData.module);
        const db = new DatabaseSync(workerData.path, { timeout: 5000 });
        const barrier = new Int32Array(workerData.barrier);
        const exec = db.exec.bind(db);
        db.exec = sql => {
          exec(sql);
          if (sql.startsWith('VACUUM INTO')) {
            Atomics.add(barrier, 0, 1); Atomics.notify(barrier, 0);
            while (Atomics.load(barrier, 0) < 2) {
              if (Atomics.wait(barrier, 0, 1, 5000) === 'timed-out') throw Error('copy barrier timed out');
            }
          }
        };
        const steps = [...MIGRATIONS.slice(0, 3),
          { version: 4, up: d => d.exec('CREATE TABLE once_only (version INTEGER PRIMARY KEY); INSERT INTO once_only VALUES (4)') },
          { version: 5, up: d => d.exec('INSERT INTO once_only VALUES (5)') }];
        migrate(db, workerData.path, steps); db.close();
      })().catch(error => { console.error(error); process.exitCode = 1; });
    `;
    await Promise.all([1, 2].map(() => new Promise<void>((resolve, reject) => {
      const worker = new Worker(source, { eval: true, workerData: { path, barrier, module: new URL("./migrations.ts", import.meta.url).href } });
      worker.once("error", reject);
      worker.once("exit", code => code === 0 ? resolve() : reject(new Error(`migration worker exit ${code}`)));
    })));
    expect(new Int32Array(barrier)[0]).toBe(2);
    const db = connect(path);
    expect(version(db)).toBe(LATEST_VERSION);
    expect(db.prepare("SELECT version FROM once_only ORDER BY version").all()).toEqual([{ version: 4 }, { version: 5 }]);
    expect(version(saved(3))).toBe(3);
    expect(files()).toEqual(["threads.v3.sqlite"]);
  });

  it("copies an unversioned database with existing tables before its first step", () => {
    const path = join(dir, "threads.sqlite");
    const db = connect(path);
    db.exec("CREATE TABLE legacy (content TEXT); INSERT INTO legacy VALUES ('Keep this')");
    const step: Migration = { version: 1, up: d => {
      expect(version(saved(0))).toBe(0);
      expect(saved(0).prepare("SELECT * FROM legacy").all()).toEqual([{ content: "Keep this" }]);
      MIGRATIONS[0]!.up(d);
    } };
    expect(migrate(db, path, [step])).toBe(1);
  });

  it("fresh and already-latest databases make no folder, including nullable repairs", () => {
    const path = join(dir, "threads.sqlite");
    const db = connect(path);
    migrate(db, path);
    migrate(db, path);
    ensureMessageColumns(db);
    expect(fs.existsSync(join(dir, "store-copies"))).toBe(false);
  });

  it("keeps crash leftovers and replaces an older complete copy only after saving the new one", () => {
    const { db, path } = fixture(3);
    const folder = join(dir, "store-copies");
    fs.mkdirSync(folder);
    const stale = join(folder, ".copy-from-earlier-attempt.sqlite");
    fs.writeFileSync(stale, "unfinished");
    fs.utimesSync(stale, new Date(0), new Date(0));
    fs.copyFileSync(path, join(folder, "threads.v3.sqlite"));
    migrate(db, path);
    expect(version(saved(3))).toBe(3);
    expect(saved(3).prepare("SELECT count(*) AS n FROM messages").get()).toEqual({ n: 2 });
    expect(fs.readFileSync(stale, "utf8")).toBe("unfinished");
    expect(files()).toEqual([".copy-from-earlier-attempt.sqlite", "threads.v3.sqlite"]);
  });

  it("rejects a copy that cannot open and reports its cause without SQLite text", () => {
    const { db, path } = fixture(3);
    const exec = db.exec.bind(db);
    vi.spyOn(db, "exec").mockImplementation(sql => {
      exec(sql);
      if (sql.startsWith("VACUUM INTO")) {
        const temporary = files().find(name => name.startsWith(".copy-"));
        expect(temporary).toBeDefined();
        fs.writeFileSync(join(dir, "store-copies", temporary!), "not a sqlite file");
      }
    });
    expect(() => migrate(db, path)).toThrow("because the saved copy could not be opened or read.");
    expect(version(db)).toBe(3);
    expect(files()).toEqual([]);
  });

  it("SQLite disk-full errors reach the existing startup error page with recovery instructions", () => {
    const { path } = fixture(3);
    const main = new URL("../main.ts", import.meta.url).href;
    const source = `
      import { DatabaseSync } from 'node:sqlite';
      import { randomUUID } from 'node:crypto';
      const exec = DatabaseSync.prototype.exec;
      DatabaseSync.prototype.exec = function(sql) {
        if (sql.startsWith('VACUUM INTO')) throw Object.assign(new Error('database or disk is full'), { code: 'ERR_SQLITE_ERROR', errcode: 13 });
        if (sql.startsWith('BEGIN')) throw new Error('migration reached a step without a saved copy');
        return exec.call(this, sql);
      };
      process.argv = [process.execPath, '--port', '0', '--data-dir', ${JSON.stringify(dir)}];
      process.env.GATES_LOCAL_SERVER_TOKEN = randomUUID();
      const { main } = await import(${JSON.stringify(main)});
      await main();
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", source], {
      env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GATES_LOCAL_"))), GATES_LOCAL_RUNTIME: "discover-only", GATES_LOCAL_OLLAMA_BINARY: "none" },
      encoding: "utf8", timeout: 10_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(1);
    const message = "Gates Local could not save a copy of your chats before upgrading them, because the disk is full. Free some space and start it again. Nothing was changed.";
    expect(result.stderr).toContain(message);
    // The raw cause is in the server's output, on its own line before the sentence.
    const lines = result.stderr.trim().split("\n");
    const cause = lines.findIndex(line => line === "[server] thread store: database or disk is full");
    expect(cause, result.stderr).toBeGreaterThanOrEqual(0);
    expect(lines.findIndex(line => line.includes(message))).toBeGreaterThan(cause);
    expect(renderStatusPage({ kind: "server", state: {
      status: "crashed", launch: 1, reason: { kind: "exit", code: 1, signal: null },
      stderrTail: result.stderr.trim().split("\n"), restartBlockedUntil: null,
    } })).toContain(message);
    expect(version(connect(path))).toBe(3);
    expect(files()).toEqual([]);
  });

  it.each([":memory:", "", "missing.sqlite"])("makes no copy for a non-file path %s", supplied => {
    const db = connect(":memory:");
    migrate(db, ":memory:", MIGRATIONS.slice(0, 3));
    expect(migrate(db, supplied === "missing.sqlite" ? join(dir, supplied) : supplied)).toBe(LATEST_VERSION);
    expect(fs.existsSync(join(dir, "store-copies"))).toBe(false);
  });

  it("copies a real store opened through a directory link", () => {
    fixture(3);
    const alias = join(dir, "alias");
    fs.symlinkSync(dir, alias, process.platform === "win32" ? "junction" : "dir");
    const path = join(alias, "threads.sqlite");
    expect(migrate(connect(path), path)).toBe(LATEST_VERSION);
    expect(version(saved(3))).toBe(3);
    expect(saved(3).prepare("SELECT count(*) AS n FROM messages").get()).toEqual({ n: 2 });
  });
});
