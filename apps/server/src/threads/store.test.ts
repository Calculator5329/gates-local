import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DuplicateMessageError,
  InvalidInputError,
  StoreClosedError,
  StoreVersionTooNewError,
  ThreadNotFoundError,
} from "./errors.ts";
import { LATEST_VERSION, migrate, MIGRATIONS, type Migration } from "./migrations.ts";
import { DEFAULT_THREAD_TITLE, openThreadStore, type ThreadStore } from "./store.ts";

let dir: string;
const open: ThreadStore[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gates-threads-"));
});

afterEach(() => {
  for (const s of open.splice(0)) s.close();
  rmSync(dir, { recursive: true, force: true });
});

function clock(start = 1_000): () => number {
  let t = start;
  return () => t++;
}

function store(path = join(dir, "threads.db"), now: () => number = clock()): ThreadStore {
  const s = openThreadStore(path, { now });
  open.push(s);
  return s;
}

function raw(path: string): DatabaseSync {
  return new DatabaseSync(path);
}

function pragma(db: DatabaseSync, name: string): unknown {
  return db.prepare(`PRAGMA ${name}`).get()?.[name];
}

describe("openThreadStore", () => {
  it("creates the parent directory, WAL mode and the latest schema", () => {
    const path = join(dir, "nested", "deeper", "threads.db");
    store(path);
    const db = raw(path);
    expect(pragma(db, "journal_mode")).toBe("wal");
    expect(pragma(db, "user_version")).toBe(LATEST_VERSION);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','index') ORDER BY name").all();
    expect(tables.map((r) => r["name"])).toEqual(
      expect.arrayContaining(["messages", "messages_by_thread_time", "threads", "threads_by_updated"]),
    );
    db.close();
  });

  it("migrates an existing empty file", () => {
    const path = join(dir, "empty.db");
    writeFileSync(path, "");
    const s = store(path);
    expect(s.listThreads()).toEqual([]);
    const db = raw(path);
    expect(pragma(db, "user_version")).toBe(LATEST_VERSION);
    db.close();
  });

  it("refuses a database from a newer build and leaves it untouched", () => {
    const path = join(dir, "future.db");
    const db = raw(path);
    db.exec(`PRAGMA user_version = ${LATEST_VERSION + 1}`);
    db.close();

    let caught: unknown;
    try {
      openThreadStore(path);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(StoreVersionTooNewError);
    expect(caught).toMatchObject({ code: "store-version-too-new", found: LATEST_VERSION + 1, supported: LATEST_VERSION });

    const after = raw(path);
    expect(pragma(after, "user_version")).toBe(LATEST_VERSION + 1);
    expect(after.prepare("SELECT count(*) AS n FROM sqlite_master").get()).toEqual({ n: 0 });
    after.close();
  });

  it("reopens at the current version without rerunning steps and keeps data", () => {
    const path = join(dir, "threads.db");
    const a = openThreadStore(path);
    const t = a.createThread({ title: "kept" });
    a.close();
    const b = store(path);
    expect(b.listThreads().map((x) => x.id)).toEqual([t.id]);
  });

  it("refuses ':memory:' and an empty path with a named error", () => {
    expect(() => openThreadStore(":memory:")).toThrow(InvalidInputError);
    expect(() => openThreadStore("")).toThrow(InvalidInputError);
  });
});

describe("migrate", () => {
  it("applies a later step on top of version 1", () => {
    const path = join(dir, "m.db");
    const db = raw(path);
    expect(migrate(db, path)).toBe(LATEST_VERSION);
    const next: Migration = { version: LATEST_VERSION + 1, up: (d) => d.exec("CREATE TABLE extra (x INTEGER)") };
    expect(migrate(db, path, [...MIGRATIONS, next])).toBe(LATEST_VERSION + 1);
    expect(pragma(db, "user_version")).toBe(LATEST_VERSION + 1);
    db.close();
  });

  it("rolls a failing step back with its version bump", () => {
    const path = join(dir, "m.db");
    const db = raw(path);
    migrate(db, path);
    const bad: Migration = {
      version: LATEST_VERSION + 1,
      up: (d) => {
        d.exec("CREATE TABLE half (x INTEGER)");
        throw new Error("step failed");
      },
    };
    expect(() => migrate(db, path, [...MIGRATIONS, bad])).toThrow("step failed");
    expect(pragma(db, "user_version")).toBe(LATEST_VERSION);
    expect(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'half'").get()).toEqual({ n: 0 });
    db.close();
  });

  it("rejects a migration list with a gap", () => {
    const path = join(dir, "m.db");
    const db = raw(path);
    const gap: Migration = { version: LATEST_VERSION + 2, up: () => {} };
    expect(() => migrate(db, path, [...MIGRATIONS, gap])).toThrow(/out of order/);
    db.close();
  });
});

describe("threads", () => {
  it("creates with a default or trimmed title and lists by updatedAt, newest first", () => {
    const s = store();
    const a = s.createThread();
    const b = s.createThread({ title: "  second  " });
    expect(a.title).toBe(DEFAULT_THREAD_TITLE);
    expect(b.title).toBe("second");
    expect(a.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(a.createdAt).toBe(a.updatedAt);
    expect(s.listThreads().map((t) => t.id)).toEqual([b.id, a.id]);

    // A message in the older thread moves it to the top.
    s.appendMessage({ threadId: a.id, role: "user", content: "hi" });
    const listed = s.listThreads();
    expect(listed.map((t) => t.id)).toEqual([a.id, b.id]);
    expect(listed[0]!.updatedAt).toBeGreaterThan(a.updatedAt);
    expect(listed[0]!.createdAt).toBe(a.createdAt);
  });

  it("renames and bumps updatedAt", () => {
    const s = store();
    const t = s.createThread({ title: "old" });
    const renamed = s.renameThread(t.id, "new name");
    expect(renamed).toMatchObject({ id: t.id, title: "new name", createdAt: t.createdAt });
    expect(renamed.updatedAt).toBeGreaterThan(t.updatedAt);
    expect(s.getThread(t.id).thread).toEqual(renamed);
  });

  it("deletes a thread and cascades its messages, leaving other threads alone", () => {
    const path = join(dir, "threads.db");
    const s = store(path);
    const doomed = s.createThread({ title: "doomed" });
    const kept = s.createThread({ title: "kept" });
    for (const content of ["a", "b", "c"]) s.appendMessage({ threadId: doomed.id, role: "user", content });
    s.appendMessage({ threadId: kept.id, role: "user", content: "stay" });

    s.deleteThread(doomed.id);
    expect(s.listThreads().map((t) => t.id)).toEqual([kept.id]);
    expect(() => s.getThread(doomed.id)).toThrow(ThreadNotFoundError);

    const db = raw(path);
    expect(db.prepare("SELECT count(*) AS n FROM messages WHERE thread_id = ?").get(doomed.id)).toEqual({ n: 0 });
    expect(db.prepare("SELECT count(*) AS n FROM messages WHERE thread_id = ?").get(kept.id)).toEqual({ n: 1 });
    db.close();
  });
});

describe("messages", () => {
  it("returns messages in time order, ties in write order, with optional fields round-tripped", () => {
    const s = store();
    const t = s.createThread();
    const m1 = s.appendMessage({ threadId: t.id, role: "system", content: "be brief", createdAt: 5_000 });
    const m2 = s.appendMessage({ threadId: t.id, role: "user", content: "same ms 1", createdAt: 6_000 });
    const m3 = s.appendMessage({ threadId: t.id, role: "user", content: "same ms 2", createdAt: 6_000 });
    const m4 = s.appendMessage({
      threadId: t.id,
      role: "assistant",
      content: "answer",
      thinking: "hmm",
      model: "qwen3:8b",
      createdAt: 7_000,
      stats: { promptTokens: 12, completionTokens: 34, durationMs: 1234.5, numCtx: 16384 },
    });
    // Written out of time order: still read back by createdAt.
    const m0 = s.appendMessage({ threadId: t.id, role: "user", content: "earliest", createdAt: 4_000 });

    const { messages } = s.getThread(t.id);
    expect(messages.map((m) => m.id)).toEqual([m0.id, m1.id, m2.id, m3.id, m4.id]);
    expect(messages[4]).toEqual(m4);
    expect(messages[4]).toEqual({
      id: m4.id,
      threadId: t.id,
      role: "assistant",
      content: "answer",
      thinking: "hmm",
      model: "qwen3:8b",
      createdAt: 7_000,
      stats: { promptTokens: 12, completionTokens: 34, durationMs: 1234.5, numCtx: 16384 },
    });
    // Absent optional fields come back absent, not null.
    expect(Object.keys(messages[1]!).toSorted()).toEqual(["content", "createdAt", "id", "role", "threadId"]);
  });

  it("keeps a caller-supplied id and refuses a duplicate with a named error", () => {
    const s = store();
    const t = s.createThread();
    const id = "6f1c8a52-2c1d-4c6e-9a0e-0d4b8e2f1a11";
    expect(s.appendMessage({ id, threadId: t.id, role: "user", content: "x" }).id).toBe(id);
    expect(() => s.appendMessage({ id, threadId: t.id, role: "user", content: "y" })).toThrow(DuplicateMessageError);
    expect(s.getThread(t.id).messages).toHaveLength(1);
  });

  it("names a missing thread instead of leaking SQL text, and writes nothing", () => {
    const path = join(dir, "threads.db");
    const s = store(path);
    const missing = "00000000-0000-4000-8000-000000000000";
    for (const call of [
      () => s.getThread(missing),
      () => s.renameThread(missing, "x"),
      () => s.deleteThread(missing),
      () => s.appendMessage({ threadId: missing, role: "user", content: "orphan" }),
    ]) {
      expect(call).toThrow(ThreadNotFoundError);
    }
    const db = raw(path);
    expect(db.prepare("SELECT count(*) AS n FROM messages").get()).toEqual({ n: 0 });
    db.close();
  });

  it("validates input at the boundary", () => {
    const s = store();
    const t = s.createThread();
    const bad: Array<[string, () => unknown]> = [
      ["title", () => s.createThread({ title: "   " })],
      ["title", () => s.renameThread(t.id, 42 as unknown as string)],
      ["title", () => s.createThread({ title: "x".repeat(501) })],
      ["threadId", () => s.getThread("")],
      ["role", () => s.appendMessage({ threadId: t.id, role: "tool" as "user", content: "x" })],
      ["content", () => s.appendMessage({ threadId: t.id, role: "user", content: undefined as unknown as string })],
      ["createdAt", () => s.appendMessage({ threadId: t.id, role: "user", content: "x", createdAt: 1.5 })],
      ["stats.promptTokens", () => s.appendMessage({ threadId: t.id, role: "user", content: "x", stats: { promptTokens: 1.5 } })],
      ["stats.durationMs", () => s.appendMessage({ threadId: t.id, role: "user", content: "x", stats: { durationMs: -1 } })],
      ["thinking", () => s.appendMessage({ threadId: t.id, role: "user", content: "x", thinking: 7 as unknown as string })],
      ["message", () => s.appendMessage(null as never)],
    ];
    for (const [field, call] of bad) {
      let caught: unknown;
      try {
        call();
      } catch (err) {
        caught = err;
      }
      expect(caught, field).toBeInstanceOf(InvalidInputError);
      expect((caught as InvalidInputError).field).toBe(field);
    }
    expect(s.getThread(t.id).messages).toEqual([]);
  });

  it("refuses calls after close with a named error", () => {
    const s = openThreadStore(join(dir, "threads.db"));
    s.close();
    s.close(); // idempotent
    expect(() => s.listThreads()).toThrow(StoreClosedError);
    expect(() => s.createThread()).toThrow(StoreClosedError);
  });
});

describe("concurrent connections (WAL)", () => {
  it("a second connection reads while the first holds an open write transaction", () => {
    const path = join(dir, "threads.db");
    const reader = store(path);
    const t = reader.createThread({ title: "shared" });
    reader.appendMessage({ threadId: t.id, role: "user", content: "committed" });

    const writer = raw(path);
    writer.exec("PRAGMA busy_timeout = 0");
    writer.exec("BEGIN IMMEDIATE");
    writer
      .prepare("INSERT INTO messages (id, thread_id, role, content, created_at) VALUES (?, ?, 'assistant', 'uncommitted', ?)")
      .run("11111111-1111-4111-8111-111111111111", t.id, 999_999);

    // Not blocked by the writer's lock, and does not see its uncommitted row.
    const started = Date.now();
    expect(reader.getThread(t.id).messages.map((m) => m.content)).toEqual(["committed"]);
    expect(reader.listThreads()).toHaveLength(1);
    expect(Date.now() - started).toBeLessThan(1_000);

    writer.exec("COMMIT");
    expect(reader.getThread(t.id).messages.map((m) => m.content)).toEqual(["committed", "uncommitted"]);
    writer.close();
  });

  it("a reader's open snapshot does not block the writer and stays consistent", () => {
    const path = join(dir, "threads.db");
    const now = clock(); // one clock for both store instances below
    const writer = store(path, now);
    const t = writer.createThread();
    writer.appendMessage({ threadId: t.id, role: "user", content: "one" });

    const reader = raw(path);
    reader.exec("BEGIN");
    const count = reader.prepare("SELECT count(*) AS n FROM messages");
    expect(count.get()).toEqual({ n: 1 });

    for (const content of ["two", "three"]) writer.appendMessage({ threadId: t.id, role: "assistant", content });
    expect(count.get()).toEqual({ n: 1 }); // snapshot held
    reader.exec("COMMIT");
    expect(count.get()).toEqual({ n: 3 });
    reader.close();

    // Two store instances on one file see each other's writes.
    const second = store(path, now);
    expect(second.getThread(t.id).messages).toHaveLength(3);
    second.appendMessage({ threadId: t.id, role: "user", content: "four" });
    expect(writer.getThread(t.id).messages.map((m) => m.content)).toEqual(["one", "two", "three", "four"]);
  });
});
