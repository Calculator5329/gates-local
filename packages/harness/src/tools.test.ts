import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createTools } from "./tools.ts";

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
    expect((await tools.execute({ name: "image", input: { prompt: "a cat" } }, new AbortController().signal)).output).toBe("Image generation is not set up");
    await expect(tools.execute({ name: "note", input: {} }, new AbortController().signal)).rejects.toThrow(/Unknown tool/);
  });
  it("injects image generation and forwards cancellation", async () => {
    const generateImage = vi.fn(async () => "images/cat.png");
    const signal = new AbortController().signal;
    const tools = createTools({ sources: [], generateImage });
    expect(await tools.execute({ name: "image", input: { prompt: "cat" } }, signal)).toMatchObject({ imagePath: "images/cat.png" });
    expect(generateImage).toHaveBeenCalledWith("cat", signal);
  });
  it("uses read-only sql on injected Windows and never offers shell", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "gl-sql-"));
    const snapshotPath = path.join(root, "finances.db");
    const db = new DatabaseSync(snapshotPath); db.exec("CREATE TABLE money (n); INSERT INTO money VALUES (12)"); db.close();
    const tools = createTools({ platform: "win32", sources: [{ id: "finances", kind: "sqlite", path: "never-open-this-live-db", snapshotPath, label: "finances.db" }] });
    expect(tools.definitions.map(t => t.function.name)).toEqual(["read", "sql", "image"]);
    const signal = new AbortController().signal;
    expect(await tools.execute({ name: "sql", input: { source: "finances", query: "SELECT * FROM money" } }, signal)).toMatchObject({ output: expect.stringContaining("12"), summary: "Read 1 row from finances.db" });
    for (const query of ["WITH c AS (SELECT 1) DELETE FROM money", "PRAGMA user_version=7", "ATTACH DATABASE ':memory:' AS other", "PRAGMA query_only=OFF", "SELECT 1; DELETE FROM money"])
      await expect(tools.execute({ name: "sql", input: { source: "finances", query } }, signal)).rejects.toThrow();
    await expect(tools.execute({ name: "shell", input: { command: "whoami" } }, signal)).rejects.toThrow(/Windows/);
  });
});
