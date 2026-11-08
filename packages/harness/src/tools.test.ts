import { describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createTools, type LibraryFs } from "./tools.ts";

describe("Library tools", () => {
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
  it("filesystem failures name the virtual path and never a host path (T2-02)", async () => {
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
      await expect(tools.execute({ name: "read", input: { path: "/library/f/../x" } }, signal)).rejects.toThrow("Path is outside your Library source");
      await expect(tools.execute({ name: "read", input: { path: "/library/nope/x" } }, signal)).rejects.toThrow("Path is outside your Library; use /library/<source id>");
    } finally { chmodSync(path.join(docs, "shut"), 0o700); chmodSync(path.join(docs, "locked.txt"), 0o600); }
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
    const queueImage = vi.fn(async () => ({ jobId: "job-7" }));
    const signal = new AbortController().signal;
    const on = createTools({ sources: [], queueImage, image: true });
    expect(on.definitions.map(t => t.function.name)).toContain("image");
    const result = await on.execute({ name: "image", input: { prompt: "cat" } }, signal);
    // The model reads that the picture is not made yet, so it cannot claim it is.
    expect(result).toEqual({ output: expect.stringMatching(/^Queued image job job-7\..*not made yet/), summary: "Queued an image" });
    expect(queueImage).toHaveBeenCalledWith("cat", signal);
    queueImage.mockClear();
    for (const off of [createTools({ sources: [], queueImage }), createTools({ sources: [], image: true })]) {
      expect(off.definitions.map(t => t.function.name)).not.toContain("image");
      await expect(off.execute({ name: "image", input: { prompt: "cat" } }, signal)).rejects.toThrow(TypeError);
    }
    expect(queueImage).not.toHaveBeenCalled();
  });
  it("stops a runaway query at its timer while the event loop keeps running", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "gl-sql-slow-"));
    const snapshotPath = path.join(root, "slow.db");
    const db = new DatabaseSync(snapshotPath); db.exec("CREATE TABLE t(n)"); db.close();
    const tools = createTools({ platform: "win32", sqlTimeoutMs: 1500, sources: [{ id: "slow", kind: "sqlite", path: "live", snapshotPath, label: "slow.db" }] });
    let ticks = 0;
    const interval = setInterval(() => { ticks++; }, 50);
    const started = Date.now();
    try {
      await expect(tools.execute({ name: "sql", input: { source: "slow", query: "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c) SELECT count(*) FROM c" } }, new AbortController().signal))
        .rejects.toThrow("The query ran longer than 1.5 s and was stopped.");
    } finally { clearInterval(interval); }
    expect(Date.now() - started).toBeLessThan(3000);
    expect(ticks).toBeGreaterThan(5);
  });
  it("a query child does not outlive a parent that dies mid-query", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "gl-sql-orphan-"));
    const snapshotPath = path.join(root, "slow.db");
    const db = new DatabaseSync(snapshotPath); db.exec("CREATE TABLE t(n)"); db.close();
    // A unique timer shows up in the child's argv; the watchdog would also kill it at the timer + 1 s.
    const timeoutMs = 3000 + Math.floor(Math.random() * 900);
    const sql = new URL("./sql.ts", import.meta.url).href;
    const parent = spawn(process.execPath, ["--input-type=module", "-e",
      `import { runSnapshotQuery } from ${JSON.stringify(sql)}; runSnapshotQuery({ file: ${JSON.stringify(snapshotPath)}, query: "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c) SELECT count(*) FROM c", limit: 1, signal: new AbortController().signal, timeoutMs: ${timeoutMs} }).catch(() => {}); setTimeout(() => process.exit(0), 400);`], { stdio: "ignore" });
    await once(parent, "exit");
    const children = () => readdirSync("/proc").filter(pid => /^\d+$/.test(pid)).filter(pid => {
      try { const cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8"); return cmd.includes("node:sqlite") && cmd.includes(`\0${timeoutMs}`); } catch { return false; }
    });
    await vi.waitFor(() => expect(children()).toEqual([]), { timeout: 1500, interval: 100 });
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
});
