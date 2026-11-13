import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createTools, type LibraryFs } from "./tools.ts";
import { MAX_IMAGES_PER_TURN } from "./prompt.ts";

const processCleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of processCleanups.splice(0)) await cleanup(); });

function isQueryProcess(cmd: string, timeoutMs: number) {
  return cmd.includes("node:sqlite") && cmd.includes(`\0${timeoutMs}\0`);
}

describe("Library tools", () => {
  it("query cleanup matches the complete timer argument", () => {
    expect(isQueryProcess(["node", "-e", "require('node:sqlite')", "1234", "5678", ""].join("\0"), 1234)).toBe(true);
    expect(isQueryProcess(["node", "-e", "require('node:sqlite')", "12345", "5678", ""].join("\0"), 1234)).toBe(false);
  });
  it("reads and lists approved sources with caps, refusing traversal and symlinks", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "gl-tools-"));
    const docs = path.join(root, "docs"); mkdirSync(docs);
    writeFileSync(path.join(docs, "note.txt"), "a".repeat(50000));
    writeFileSync(path.join(root, "private.txt"), "private");
    symlinkSync(path.join(root, "private.txt"), path.join(docs, "escape"));
    const tools = createTools({ sources: [{ id: "docs", label: "Docs", path: docs, kind: "folder" }] });
    expect((await tools.execute({ name: "read", input: { path: "/library/docs" } }, new AbortController().signal)).output).toContain("note.txt");
    expect((await tools.execute({ name: "read", input: { path: "/library/docs/note.txt", limit: 20 } }, new AbortController().signal)).output.length).toBeLessThan(150);
    for (const file of ["/library/docs/escape", "/library/docs/../private.txt", path.join(root, "private.txt")]) await expect(tools.execute({ name: "read", input: { path: file } }, new AbortController().signal)).rejects.toThrow();
    await expect(tools.execute({ name: "note", input: {} }, new AbortController().signal)).rejects.toThrow(/Unknown tool/);
  });
  // chmod 0o000 does not make a file unreadable on Windows.
  it.skipIf(process.platform === "win32")("filesystem failures name the virtual path and never a host path (T2-02)", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "gl-fserr-"));
    const docs = path.join(root, "docs"); mkdirSync(docs);
    writeFileSync(path.join(docs, "note.txt"), "hello");
    writeFileSync(path.join(docs, "locked.txt"), "secret"); chmodSync(path.join(docs, "locked.txt"), 0o000);
    mkdirSync(path.join(docs, "shut")); writeFileSync(path.join(docs, "shut", "x"), "x"); chmodSync(path.join(docs, "shut"), 0o000);
    writeFileSync(path.join(docs, "gone.txt"), "soon gone");
    // Removed after stat resolved it and before open: the race made deterministic.
    const raced: Partial<LibraryFs> = { open: (async (file: string, flags: number) => { if (file.endsWith("gone.txt")) rmSync(file); return open(file, flags); }) as LibraryFs["open"] };
    const tools = createTools({ sources: [{ id: "f", label: "Docs", path: docs, kind: "folder" }], fs: raced });
    const signal = new AbortController().signal;
    try {
      const cases: [string, string][] = [
        ["/library/f/absent", "/library/f/absent: no such file"],
        ["/library/f/note.txt/x", "/library/f/note.txt/x: not a folder"],
        ["/library/f/locked.txt", "/library/f/locked.txt: permission denied"],
        ["/library/f/shut/x", "/library/f/shut/x: permission denied"],
        ["/library/f/gone.txt", "/library/f/gone.txt: no such file"],
        [path.join(docs, "absent"), "/library/f/absent: no such file"],
      ];
      for (const [requested, message] of cases) {
        const error = await tools.execute({ name: "read", input: { path: requested } }, signal).then(() => undefined, (e: unknown) => e as Error);
        expect(error?.message, requested).toBe(message);
        for (const host of [root, process.cwd()]) expect(error?.message).not.toContain(host);
      }
      // Argument and containment errors keep their own messages.
      await expect(tools.execute({ name: "read", input: { path: "/library/nope/x" } }, signal)).rejects.toThrow("Path is outside your Library; use /library/<source id>");
    } finally { chmodSync(path.join(docs, "shut"), 0o700); chmodSync(path.join(docs, "locked.txt"), 0o600); }
  });
  const leavesEverywhere: [string, string][] = [
    ["absolute", "/etc/passwd"],
    ["double slash after the source id", "//etc/passwd"],
    ["parent", "../private.txt"],
    ["nested parent", "sub/../../private.txt"],
    ["backslash parent", "..\\private.txt"],
  ];
  const leavesOnWindows: [string, string][] = [
    ["drive", "C:\\Windows\\system.ini"],
    ["drive with forward slash", "C:/Windows/system.ini"],
    ["drive-relative", "C:system.ini"],
    ["UNC", "\\\\host\\share\\file.txt"],
    ["device", "\\\\?\\C:\\Windows\\system.ini"],
  ];
  describe.each([
    ["linux" as const, leavesEverywhere],
    ["win32" as const, [...leavesEverywhere, ...leavesOnWindows]],
  ])("a path that leaves the source by its text, on %s", (platform, rows) => {
    it.each(rows)("%s gets the missing-file refusal and touches nothing", async (_shape, relative) => {
      const touched: string[] = [];
      const fs = {
        stat: (async (file: string) => { touched.push(`stat ${file}`); throw new Error("touched"); }) as LibraryFs["stat"],
        opendir: (async (file: string) => { touched.push(`opendir ${file}`); throw new Error("touched"); }) as LibraryFs["opendir"],
        open: (async (file: string) => { touched.push(`open ${file}`); throw new Error("touched"); }) as LibraryFs["open"],
      };
      const realpath = async (file: string) => { touched.push(`realpath ${file}`); return file; };
      const tools = createTools({ platform, realpath, fs, sources: [{ id: "f", label: "Docs", path: "/srv/docs", kind: "folder" }] });
      const requested = `/library/f/${relative}`;
      await expect(tools.execute({ name: "read", input: { path: requested } }, new AbortController().signal)).rejects.toThrow(new Error(`${requested}: no such file`));
      expect(touched).toEqual([]);
    });
  });
  describe.skipIf(process.platform === "win32")("a file with a name only Windows would treat as a root, on Linux", () => {
    it.each([
      ["drive-like", "C:notes.txt"],
      ["leading backslash", "\\notes.txt"],
    ])("%s is the person's own file and reads", async (_shape, name) => {
      const docs = mkdtempSync(path.join(tmpdir(), "gl-tools-"));
      writeFileSync(path.join(docs, name), "kept in the Library");
      const tools = createTools({ platform: "linux", sources: [{ id: "f", label: "Docs", path: docs, kind: "folder" }] });
      const read = await tools.execute({ name: "read", input: { path: `/library/f/${name}` } }, new AbortController().signal);
      expect(read.output).toContain("kept in the Library");
    });
  });
  it("Windows ignores trailing dots and spaces, so a dressed-up parent is refused there and is only a name elsewhere", async () => {
    const realpath = vi.fn(async (file: string) => file);
    const sources = [{ id: "f", label: "Docs", path: "/srv/docs", kind: "folder" as const }];
    const signal = new AbortController().signal;
    await expect(createTools({ platform: "win32", realpath, sources }).execute({ name: "read", input: { path: "/library/f/.. /x" } }, signal)).rejects.toThrow(new Error("/library/f/.. /x: no such file"));
    expect(realpath).not.toHaveBeenCalled();
    await expect(createTools({ platform: "linux", realpath, sources, fs: { stat: (async () => { throw Object.assign(new Error("gone"), { code: "ENOENT" }); }) as LibraryFs["stat"] } }).execute({ name: "read", input: { path: "/library/f/.. /x" } }, signal)).rejects.toThrow(new Error("/library/f/.. /x: no such file"));
    expect(realpath).toHaveBeenCalled();
  });
  it("a path under a single-file source is refused like a missing file without touching the disk", async () => {
    const realpath = vi.fn(async (file: string) => file);
    const tools = createTools({ realpath, sources: [{ id: "f", label: "Doc", path: "/srv/doc.txt", kind: "file" }] });
    await expect(tools.execute({ name: "read", input: { path: "/library/f/x" } }, new AbortController().signal)).rejects.toThrow(new Error("/library/f/x: no such file"));
    expect(realpath).not.toHaveBeenCalled();
  });
  it("a symlink inside the source that points out is still refused after the disk check", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "gl-link-"));
    const docs = path.join(root, "docs"); mkdirSync(docs);
    writeFileSync(path.join(root, "private.txt"), "private");
    symlinkSync(path.join(root, "private.txt"), path.join(docs, "escape"));
    const tools = createTools({ sources: [{ id: "f", label: "Docs", path: docs, kind: "folder" }] });
    await expect(tools.execute({ name: "read", input: { path: "/library/f/escape" } }, new AbortController().signal)).rejects.toThrow(new Error("Symlink leaves your Library source"));
  });
  it("accepts a source whose native realpath differs only in case (Windows)", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "gl-case-"));
    const docs = path.join(root, "docs"); mkdirSync(docs);
    writeFileSync(path.join(docs, "note.txt"), "hello");
    // The registry stored one spelling; the OS's realpath answers with another, as Windows does.
    const stored = docs.toUpperCase();
    const realpath = async (file: string) => file.toLowerCase().startsWith(stored.toLowerCase()) ? docs + file.slice(stored.length) : file;
    const tools = createTools({ platform: "win32", realpath, sources: [{ id: "docs", label: "Docs", path: stored, kind: "folder" }] });
    expect((await tools.execute({ name: "read", input: { path: "/library/docs/note.txt" } }, new AbortController().signal)).output).toBe("hello");
  });
  it("offers the image tool only when the turn asked for it and generation is wired, and it queues rather than makes", async () => {
    const queueImage = vi.fn(async (_prompt: string, _signal: AbortSignal) => ({ jobId: "job-7" }));
    const signal = new AbortController().signal;
    const on = createTools({ sources: [], queueImage, image: true });
    expect(on.definitions.map(t => t.function.name)).toContain("image");
    const result = await on.execute({ name: "image", input: { prompts: ["cat"] } }, signal);
    // The model reads that the picture is not made yet, so it cannot claim it is.
    expect(result).toEqual({ output: expect.stringMatching(/^Queued image job job-7\..*not made yet/), summary: "Queued an image" });
    expect(queueImage).toHaveBeenCalledWith("cat", signal);
    // One job per prompt, in order; every call this turn counts toward one limit, and the result says
    // how many went and why the rest did not: never a silent cap.
    const many = await on.execute({ name: "image", input: { prompts: Array.from({ length: MAX_IMAGES_PER_TURN }, (_, i) => `p${i}`) } }, signal);
    expect(queueImage.mock.calls.slice(1).map(([prompt]) => prompt)).toEqual(Array.from({ length: MAX_IMAGES_PER_TURN - 1 }, (_, i) => `p${i}`));
    expect(many.output).toContain(`Not queued: 1 more, because one message makes at most ${MAX_IMAGES_PER_TURN} images.`);
    expect(many.summary).toBe(`Queued ${MAX_IMAGES_PER_TURN - 1} images`);
    await expect(on.execute({ name: "image", input: { prompts: ["one more"] } }, signal)).rejects.toThrow(/Queued no images\. Not queued: 1 more/);
    queueImage.mockClear();
    for (const off of [createTools({ sources: [], queueImage }), createTools({ sources: [], image: true })]) {
      expect(off.definitions.map(t => t.function.name)).not.toContain("image");
      await expect(off.execute({ name: "image", input: { prompts: ["cat"] } }, signal)).rejects.toThrow(TypeError);
    }
    expect(queueImage).not.toHaveBeenCalled();
  });
  it("stops a runaway query at its timer while the event loop keeps running", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "gl-sql-slow-"));
    const snapshotPath = path.join(root, "slow.db");
    const db = new DatabaseSync(snapshotPath); db.exec("CREATE TABLE t(n)"); db.close();
    const tools = createTools({ platform: "win32", sqlTimeoutMs: 1500, sources: [{ id: "slow", kind: "sqlite", path: "live", snapshotPath, label: "slow.db" }] });
    const ticks = [performance.now()];
    const interval = setInterval(() => { ticks.push(performance.now()); }, 50);
    try {
      await expect(tools.execute({ name: "sql", input: { source: "slow", query: "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c) SELECT count(*) FROM c" } }, new AbortController().signal))
        .rejects.toThrow("The query ran longer than 1.5 s and was stopped.");
    } finally { clearInterval(interval); }
    ticks.push(performance.now());
    const longestGap = Math.max(...ticks.slice(1).map((at, i) => at - ticks[i]!));
    expect(longestGap, "the query must not block the event loop for most of its timer").toBeLessThan(500);
  });
  it("a query child does not outlive a parent that dies mid-query", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "gl-sql-orphan-"));
    const snapshotPath = path.join(root, "slow.db");
    const db = new DatabaseSync(snapshotPath); db.exec("CREATE TABLE t(n)"); db.close();
    // The unique timer identifies this query. Its own watchdog must not be
    // what ends it during the test's 10-second wait for parent-death cleanup.
    const timeoutMs = 60_000 + process.pid;
    const sql = new URL("./sql.ts", import.meta.url).href;
    const parent = spawn(process.execPath, ["--input-type=module", "-e",
      `import { runSnapshotQuery } from ${JSON.stringify(sql)}; runSnapshotQuery({ file: ${JSON.stringify(snapshotPath)}, query: "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c) SELECT count(*) FROM c", limit: 1, signal: new AbortController().signal, timeoutMs: ${timeoutMs} }).catch(() => {});`], { stdio: "ignore" });
    const exited = once(parent, "exit");
    // Linux: /proc. Windows has none: one CIM query for the same command line.
    // (On Windows libuv's kill-on-close job for spawned children also ends it.)
    const children = () => process.platform === "win32"
      ? execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
        `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*node:sqlite*' -and $_.CommandLine -like '* ${timeoutMs} ${parent.pid}' } | ForEach-Object { $_.ProcessId }`],
      { encoding: "utf8", windowsHide: true }).split(/\r?\n/).filter(Boolean)
      : readdirSync("/proc").filter(pid => /^\d+$/.test(pid)).filter(pid => {
        try { return isQueryProcess(readFileSync(`/proc/${pid}/cmdline`, "utf8"), timeoutMs); } catch { return false; }
      });
    let cleaned = false;
    const cleanup = async () => {
      if (cleaned) return;
      cleaned = true;
      if (parent.exitCode === null && parent.signalCode === null) parent.kill("SIGKILL");
      const remaining = children();
      for (const pid of remaining) {
        try { process.kill(Number(pid), "SIGKILL"); } catch { /* The query already ended. */ }
      }
      await exited;
    };
    processCleanups.push(cleanup);
    try {
      await vi.waitFor(() => expect(children(), "query child readiness").toHaveLength(1), { timeout: 10_000 });
      parent.kill("SIGKILL");
      await exited;
      await vi.waitFor(() => expect(children(), "query child to exit after parent death").toEqual([]), { timeout: 10_000 });
    } finally {
      await cleanup();
    }
  });
  it("says 10 s by default", async () => {
    const tools = createTools({ platform: "win32", sources: [] });
    expect(tools.definitions.map(t => t.function.name)).toEqual(["read", "sql"]);
    const { SQL_TIMEOUT_MS } = await import("./sql.ts");
    expect(SQL_TIMEOUT_MS).toBe(10000);
  });
  it("uses read-only sql on injected Windows and never offers shell", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "gl-sql-"));
    const snapshotPath = path.join(root, "finances.db");
    const db = new DatabaseSync(snapshotPath); db.exec("CREATE TABLE money (n); INSERT INTO money VALUES (12)"); db.close();
    const tools = createTools({ platform: "win32", sources: [{ id: "finances", kind: "sqlite", path: "never-open-this-live-db", snapshotPath, label: "finances.db" }] });
    expect(tools.definitions.map(t => t.function.name)).toEqual(["read", "sql"]);
    const signal = new AbortController().signal;
    expect(await tools.execute({ name: "sql", input: { source: "finances", query: "SELECT * FROM money" } }, signal)).toMatchObject({ output: expect.stringContaining("12"), summary: "Read 1 row from finances.db" });
    const copy = path.join(root, "copy.db");
    for (const query of ["WITH c AS (SELECT 1) DELETE FROM money", "PRAGMA user_version=7", "ATTACH DATABASE ':memory:' AS other", "PRAGMA query_only=OFF", "SELECT 1; DELETE FROM money", `VACUUM INTO '${copy}'`, `SELECT 1; VACUUM INTO '${copy}'`])
      await expect(tools.execute({ name: "sql", input: { source: "finances", query } }, signal)).rejects.toThrow();
    expect(existsSync(copy)).toBe(false);
    await expect(tools.execute({ name: "shell", input: { command: "whoami" } }, signal)).rejects.toThrow(/Windows/);
  });
  it("takes the SQLite source by id, file name or /data path on Windows, and says which ids exist when it is wrong", async () => {
    // A Windows model first tried source "books.db" and read /library/books ten times (Windows test, 2026-11-07).
    const root = mkdtempSync(path.join(tmpdir(), "gl-sql-names-"));
    const snapshotPath = path.join(root, "books.db");
    const db = new DatabaseSync(snapshotPath); db.exec("CREATE TABLE pages (n); INSERT INTO pages VALUES (691)"); db.close();
    const tools = createTools({ platform: "win32", sources: [{ id: "books", kind: "sqlite", path: "live", snapshotPath, label: "books.db" }] });
    const signal = new AbortController().signal;
    for (const source of ["books", "books.db", "/data/books.db"])
      expect(await tools.execute({ name: "sql", input: { source, query: "SELECT n FROM pages" } }, signal)).toMatchObject({ output: expect.stringContaining("691") });
    await expect(tools.execute({ name: "sql", input: { source: "other", query: "SELECT 1" } }, signal)).rejects.toThrow('SQLite snapshot was not found in your Library; use source "books"');
    await expect(tools.execute({ name: "read", input: { path: "/library/books" } }, signal)).rejects.toThrow('books is a SQLite source; use sql with source "books"');
  });
  it("points a read of a SQLite source at sqlite3 on Linux", async () => {
    const tools = createTools({ platform: "linux", sources: [{ id: "books", kind: "sqlite", path: "live", snapshotPath: "snap", label: "books.db" }] });
    await expect(tools.execute({ name: "read", input: { path: "/library/books" } }, new AbortController().signal)).rejects.toThrow("books is a SQLite source; use shell with sqlite3 /data/books.db");
  });
});
