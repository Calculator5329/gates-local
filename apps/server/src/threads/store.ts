// SQLite thread store (node:sqlite, so no native dependency; it runs under
// Electron 45's Node as well). Only completed messages are written here; a
// streaming turn lives in a TurnBuffer (turn-buffer.ts) until it finishes.

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLOutputValue, type StatementSync } from "node:sqlite";

import {
  DuplicateMessageError,
  InvalidInputError,
  StoreClosedError,
  ThreadNotFoundError,
} from "./errors.ts";
import { migrate } from "./migrations.ts";
import { ROLES, type Message, type MessageStats, type NewMessage, type Role, type Thread, type ThreadWithMessages } from "./types.ts";

export interface ThreadStoreOptions {
  /** Clock for createdAt/updatedAt; tests pin it. Defaults to Date.now. */
  now?: () => number;
  /** How long a write waits on another connection's lock before failing. */
  busyTimeoutMs?: number;
}

export interface ThreadStore {
  readonly dbPath: string;
  listThreads(): Thread[];
  createThread(input?: { title?: string }): Thread;
  getThread(threadId: string): ThreadWithMessages;
  renameThread(threadId: string, title: string): Thread;
  deleteThread(threadId: string): void;
  appendMessage(input: NewMessage): Message;
  close(): void;
}

export const DEFAULT_THREAD_TITLE = "New thread";
const MAX_TITLE = 500;
const MAX_ID = 200;
const DEFAULT_BUSY_TIMEOUT_MS = 5000;

type Row = Record<string, SQLOutputValue>;

export function openThreadStore(dbPath: string, options: ThreadStoreOptions = {}): ThreadStore {
  if (typeof dbPath !== "string" || dbPath.length === 0 || dbPath === ":memory:") {
    throw new InvalidInputError("dbPath", "a file path is required (WAL needs a file)");
  }
  const now = options.now ?? Date.now;
  const busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;

  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath, { enableForeignKeyConstraints: true, timeout: busyTimeoutMs });

  try {
    // busy_timeout first so the journal_mode switch and migrations wait on a
    // second process instead of failing with SQLITE_BUSY.
    db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.trunc(busyTimeoutMs))}`);
    const mode = db.prepare("PRAGMA journal_mode = WAL").get()?.["journal_mode"];
    if (mode !== "wal") throw new Error(`could not enable WAL on ${dbPath} (journal_mode=${String(mode)})`);
    // synchronous=FULL: in WAL mode NORMAL already survives a process kill
    // (a committed transaction is in the -wal file via write(); the OS keeps
    // it after the process dies), but NORMAL can lose the last commits on a
    // power cut or kernel crash. FULL fsyncs the WAL on every commit, which
    // makes a committed message survive those too. Writes here are a few per
    // turn, so the fsync cost is not measurable against model latency.
    db.exec("PRAGMA synchronous = FULL");
    db.exec("PRAGMA foreign_keys = ON");
    migrate(db, dbPath);
  } catch (err) {
    db.close();
    throw err;
  }

  const stmt = {
    listThreads: db.prepare("SELECT id, title, created_at, updated_at FROM threads ORDER BY updated_at DESC, id"),
    getThread: db.prepare("SELECT id, title, created_at, updated_at FROM threads WHERE id = ?"),
    insertThread: db.prepare("INSERT INTO threads (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)"),
    renameThread: db.prepare("UPDATE threads SET title = ?, updated_at = MAX(updated_at, ?) WHERE id = ?"),
    deleteThread: db.prepare("DELETE FROM threads WHERE id = ?"),
    touchThread: db.prepare("UPDATE threads SET updated_at = MAX(updated_at, ?) WHERE id = ?"),
    messageExists: db.prepare("SELECT 1 AS hit FROM messages WHERE id = ?"),
    insertMessage: db.prepare(
      `INSERT INTO messages (id, thread_id, role, content, thinking, model, created_at,
                             prompt_tokens, completion_tokens, duration_ms, num_ctx)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    listMessages: db.prepare(
      `SELECT id, thread_id, role, content, thinking, model, created_at,
              prompt_tokens, completion_tokens, duration_ms, num_ctx
       FROM messages WHERE thread_id = ? ORDER BY created_at, seq`,
    ),
  } satisfies Record<string, StatementSync>;

  let open = true;
  const guard = (): void => {
    if (!open) throw new StoreClosedError();
  };

  const transaction = <T>(fn: () => T): T => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      db.exec("COMMIT");
      return out;
    } catch (err) {
      if (db.isTransaction) db.exec("ROLLBACK");
      throw err;
    }
  };

  const loadThread = (threadId: string): Thread => {
    const row = stmt.getThread.get(threadId);
    if (!row) throw new ThreadNotFoundError(threadId);
    return threadFromRow(row);
  };

  return {
    dbPath,

    listThreads() {
      guard();
      return stmt.listThreads.all().map(threadFromRow);
    },

    createThread(input = {}) {
      guard();
      const title = input.title === undefined ? DEFAULT_THREAD_TITLE : checkTitle(input.title);
      const t = now();
      const thread: Thread = { id: randomUUID(), title, createdAt: t, updatedAt: t };
      stmt.insertThread.run(thread.id, thread.title, thread.createdAt, thread.updatedAt);
      return thread;
    },

    getThread(threadId) {
      guard();
      checkId("threadId", threadId);
      // One read transaction so the thread row and its messages come from
      // the same snapshot even while another connection writes.
      db.exec("BEGIN");
      try {
        const thread = loadThread(threadId);
        const messages = stmt.listMessages.all(threadId).map(messageFromRow);
        db.exec("COMMIT");
        return { thread, messages };
      } catch (err) {
        if (db.isTransaction) db.exec("ROLLBACK");
        throw err;
      }
    },

    renameThread(threadId, title) {
      guard();
      checkId("threadId", threadId);
      const clean = checkTitle(title);
      return transaction(() => {
        const res = stmt.renameThread.run(clean, now(), threadId);
        if (Number(res.changes) === 0) throw new ThreadNotFoundError(threadId);
        return loadThread(threadId);
      });
    },

    deleteThread(threadId) {
      guard();
      checkId("threadId", threadId);
      const res = stmt.deleteThread.run(threadId);
      if (Number(res.changes) === 0) throw new ThreadNotFoundError(threadId);
    },

    appendMessage(input) {
      guard();
      const msg = checkNewMessage(input, now);
      return transaction(() => {
        loadThread(msg.threadId);
        if (stmt.messageExists.get(msg.id)) throw new DuplicateMessageError(msg.id);
        const s = msg.stats;
        stmt.insertMessage.run(
          msg.id,
          msg.threadId,
          msg.role,
          msg.content,
          msg.thinking ?? null,
          msg.model ?? null,
          msg.createdAt,
          s?.promptTokens ?? null,
          s?.completionTokens ?? null,
          s?.durationMs ?? null,
          s?.numCtx ?? null,
        );
        stmt.touchThread.run(Math.max(now(), msg.createdAt), msg.threadId);
        return msg;
      });
    },

    close() {
      if (!open) return;
      open = false;
      db.close();
    },
  };
}

// ---------------------------------------------------------------- validation

function checkId(field: string, value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0) throw new InvalidInputError(field, "expected a non-empty string");
  if (value.length > MAX_ID) throw new InvalidInputError(field, `longer than ${MAX_ID} characters`);
}

function checkTitle(value: unknown): string {
  if (typeof value !== "string") throw new InvalidInputError("title", "expected a string");
  const title = value.trim();
  if (title.length === 0) throw new InvalidInputError("title", "must not be blank");
  if (title.length > MAX_TITLE) throw new InvalidInputError("title", `longer than ${MAX_TITLE} characters`);
  return title;
}

function checkOptionalString(field: string, value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new InvalidInputError(field, "expected a string");
  return value;
}

function checkCount(field: string, value: unknown, integer: boolean): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new InvalidInputError(field, "expected a finite non-negative number");
  }
  if (integer && !Number.isInteger(value)) throw new InvalidInputError(field, "expected an integer");
  return value;
}

function checkStats(value: unknown): MessageStats | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null) throw new InvalidInputError("stats", "expected an object");
  const v = value as Record<string, unknown>;
  return compactStats({
    promptTokens: checkCount("stats.promptTokens", v["promptTokens"], true),
    completionTokens: checkCount("stats.completionTokens", v["completionTokens"], true),
    durationMs: checkCount("stats.durationMs", v["durationMs"], false),
    numCtx: checkCount("stats.numCtx", v["numCtx"], true),
  });
}

function checkNewMessage(input: unknown, now: () => number): Message {
  if (typeof input !== "object" || input === null) throw new InvalidInputError("message", "expected an object");
  const v = input as Record<string, unknown>;
  const threadId = v["threadId"];
  checkId("threadId", threadId);
  const id = v["id"] === undefined ? randomUUID() : v["id"];
  checkId("id", id);
  const role = v["role"];
  if (!ROLES.includes(role as Role)) throw new InvalidInputError("role", `expected one of ${ROLES.join(", ")}`);
  const content = v["content"];
  if (typeof content !== "string") throw new InvalidInputError("content", "expected a string");
  const createdAt = v["createdAt"] === undefined ? now() : v["createdAt"];
  if (typeof createdAt !== "number" || !Number.isInteger(createdAt) || createdAt < 0) {
    throw new InvalidInputError("createdAt", "expected integer milliseconds since epoch");
  }
  const msg: Message = { id, threadId, role: role as Role, content, createdAt };
  const thinking = checkOptionalString("thinking", v["thinking"]);
  if (thinking !== undefined) msg.thinking = thinking;
  const model = checkOptionalString("model", v["model"]);
  if (model !== undefined) msg.model = model;
  const stats = checkStats(v["stats"]);
  if (stats !== undefined) msg.stats = stats;
  return msg;
}

// --------------------------------------------------------------------- rows

function str(row: Row, key: string): string {
  const v = row[key];
  if (typeof v !== "string") throw new Error(`thread store row: ${key} is not text`);
  return v;
}

function num(row: Row, key: string): number {
  const v = row[key];
  if (typeof v !== "number") throw new Error(`thread store row: ${key} is not a number`);
  return v;
}

function optNum(row: Row, key: string): number | undefined {
  const v = row[key];
  return v === null || v === undefined ? undefined : num(row, key);
}

function optStr(row: Row, key: string): string | undefined {
  const v = row[key];
  return v === null || v === undefined ? undefined : str(row, key);
}

function threadFromRow(row: Row): Thread {
  return { id: str(row, "id"), title: str(row, "title"), createdAt: num(row, "created_at"), updatedAt: num(row, "updated_at") };
}

function compactStats(s: MessageStats): MessageStats | undefined {
  const out: MessageStats = {};
  if (s.promptTokens !== undefined) out.promptTokens = s.promptTokens;
  if (s.completionTokens !== undefined) out.completionTokens = s.completionTokens;
  if (s.durationMs !== undefined) out.durationMs = s.durationMs;
  if (s.numCtx !== undefined) out.numCtx = s.numCtx;
  return Object.keys(out).length === 0 ? undefined : out;
}

function messageFromRow(row: Row): Message {
  const role = str(row, "role");
  if (!ROLES.includes(role as Role)) throw new Error(`thread store row: unknown role ${role}`);
  const msg: Message = {
    id: str(row, "id"),
    threadId: str(row, "thread_id"),
    role: role as Role,
    content: str(row, "content"),
    createdAt: num(row, "created_at"),
  };
  const thinking = optStr(row, "thinking");
  if (thinking !== undefined) msg.thinking = thinking;
  const model = optStr(row, "model");
  if (model !== undefined) msg.model = model;
  const stats = compactStats({
    promptTokens: optNum(row, "prompt_tokens"),
    completionTokens: optNum(row, "completion_tokens"),
    durationMs: optNum(row, "duration_ms"),
    numCtx: optNum(row, "num_ctx"),
  });
  if (stats !== undefined) msg.stats = stats;
  return msg;
}
