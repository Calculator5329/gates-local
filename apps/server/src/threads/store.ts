// SQLite thread store (node:sqlite, so no native dependency; it runs under
// Electron 45's Node as well). Only completed messages are written here; a
// streaming turn lives in a TurnBuffer (turn-buffer.ts) until it finishes.

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLOutputValue, type StatementSync } from "node:sqlite";
import { ImageEvent } from "@gates-local/contracts";
import { Schema as S } from "effect";

import {
  DuplicateMessageError,
  InvalidInputError,
  StoreClosedError,
  ThreadNotFoundError,
} from "./errors.ts";
import { migrate } from "./migrations.ts";
import { ROLES, TOOL_STATES, type Message, type MessageStats, type NewMessage, type Role, type Thread, type ThreadWithMessages, type ToolStepRecord } from "./types.ts";

export interface ThreadStoreOptions {
  /** Clock for createdAt/updatedAt; tests pin it. Defaults to Date.now. */
  now?: () => number;
  /** How long a write waits on another connection's lock before failing. */
  busyTimeoutMs?: number;
}

export interface ThreadStore {
  getMessage(messageId: string): Message | undefined;
  deleteMessage(threadId: string, messageId: string): void;
  imageReferences(): Map<string, number>;
  readonly dbPath: string;
  listThreads(): Thread[];
  createThread(input?: { title?: string }): Thread;
  getThread(threadId: string): ThreadWithMessages;
  renameThread(threadId: string, title: string): Thread;
  deleteThread(threadId: string): void;
  appendMessage(input: NewMessage): Message;
  saveImageJob(event: ImageEvent, prompt: string): void;
  /** Links the failed attempt and creates its retry card in one write transaction. */
  claimImageRetry(threadId: string, previousJobId: string, jobId: string): { jobId: string; prompt: string; created: boolean };
  /** Called once by the image module at startup; an old process cannot finish these jobs. */
  interruptImageJobs(): ImageEvent[];
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
    getMessage: db.prepare("SELECT * FROM messages WHERE id = ?"),
    insertMessage: db.prepare(
      `INSERT INTO messages (id, thread_id, role, content, thinking, model, created_at,
                             prompt_tokens, completion_tokens, duration_ms, num_ctx,
                             tools_json, images_json, eval_duration_ms, prompt_eval_duration_ms, context_notice)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    listMessages: db.prepare(
      `SELECT id, thread_id, role, content, thinking, model, created_at,
              prompt_tokens, completion_tokens, duration_ms, num_ctx,
              tools_json, images_json, eval_duration_ms, prompt_eval_duration_ms, image_job_json, context_notice
       FROM messages WHERE thread_id = ? ORDER BY created_at, seq`,
    ),
    insertImageCard: db.prepare("INSERT INTO messages (id, thread_id, role, content, created_at, image_job_json) VALUES (?, ?, 'assistant', ?, ?, ?) ON CONFLICT(id) DO NOTHING"),
    updateImageCard: db.prepare("UPDATE messages SET image_job_json = ?, images_json = ? WHERE id = ? AND thread_id = ?"),
    unfinishedImages: db.prepare("SELECT image_job_json FROM messages WHERE json_extract(image_job_json, '$.state') IN ('queued', 'running')"),
    getImageCard: db.prepare("SELECT content, image_job_json FROM messages WHERE id = ? AND thread_id = ? AND image_job_json IS NOT NULL"),
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

    getMessage(messageId) {
      guard(); checkId("messageId", messageId);
      const row = stmt.getMessage.get(messageId);
      return row ? messageFromRow(row) : undefined;
    },

    deleteMessage(threadId, messageId) {
      guard(); checkId("messageId", messageId); loadThread(threadId);
      db.prepare("DELETE FROM messages WHERE id = ? AND thread_id = ?").run(messageId, threadId);
    },
    imageReferences() {
      guard();
      const refs = new Map<string, number>();
      const add = (image: string) => refs.set(image, (refs.get(image) ?? 0) + 1);
      for (const row of db.prepare("SELECT images_json FROM messages WHERE images_json IS NOT NULL").all()) {
        const value: unknown = JSON.parse(str(row, "images_json"));
        if (!Array.isArray(value) || !value.every((item): item is string => typeof item === "string")) throw new Error("Stored image references could not be read.");
        for (const image of value) add(image);
      }
      return refs;
    },

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
          msg.tools === undefined ? null : JSON.stringify(msg.tools),
          msg.images === undefined ? null : JSON.stringify(msg.images),
          s?.evalDurationMs ?? null,
          s?.promptEvalDurationMs ?? null,
          msg.contextNotice ?? null,
        );
          stmt.touchThread.run(Math.max(now(), msg.createdAt), msg.threadId);
        return msg;
      });
    },

    saveImageJob(event, prompt) {
      guard();
      const clean = S.decodeUnknownSync(ImageEvent)(event);
      const threadId = clean.threadId;
      if (!threadId) return;
      transaction(() => {
        // A thread deleted while its job settles must stay deleted.
        if (!stmt.getThread.get(threadId)) return;
        stmt.insertImageCard.run(clean.jobId, threadId, prompt, now(), JSON.stringify(clean));
        stmt.updateImageCard.run(JSON.stringify(clean), clean.imagePath ? JSON.stringify([clean.imagePath]) : null, clean.jobId, threadId);
        stmt.touchThread.run(now(), threadId);
      });
    },

    claimImageRetry(threadId, previousJobId, jobId) {
      guard();
      return transaction(() => {
        loadThread(threadId);
        const row = stmt.getImageCard.get(previousJobId, threadId);
        if (!row) throw new InvalidInputError("retryOf", "the image job is not in this thread");
        const previous = S.decodeUnknownSync(ImageEvent)(JSON.parse(str(row, "image_job_json")));
        const prompt = str(row, "content");
        // Keep the link even after completion: a late duplicate is still the same request.
        // A failed retry can be retried from its own card, with its own id.
        if (previous.retryJobId) return { jobId: previous.retryJobId, prompt, created: false };
        if (previous.state !== "error" && previous.state !== "cancelled") throw new InvalidInputError("retryOf", "only a failed or cancelled image can be retried");
        const next: ImageEvent = { jobId, threadId, state: "queued" };
        stmt.insertImageCard.run(jobId, threadId, prompt, now(), JSON.stringify(next));
        stmt.updateImageCard.run(JSON.stringify({ ...previous, retryJobId: jobId }), null, previousJobId, threadId);
        stmt.touchThread.run(now(), threadId);
        return { jobId, prompt, created: true };
      });
    },

    interruptImageJobs() {
      guard();
      return transaction(() => stmt.unfinishedImages.all().map((row) => {
        const old = S.decodeUnknownSync(ImageEvent)(JSON.parse(str(row, "image_job_json")));
        if (!old.threadId) throw new Error("Saved image job is missing its thread");
        const event: ImageEvent = { jobId: old.jobId, threadId: old.threadId, state: "error", errorKind: "restarted", message: "The app restarted before this image finished; try again." };
        stmt.updateImageCard.run(JSON.stringify(event), null, old.jobId, old.threadId);
        return event;
      }));
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
    evalDurationMs: checkCount("stats.evalDurationMs", v["evalDurationMs"], false),
    promptEvalDurationMs: checkCount("stats.promptEvalDurationMs", v["promptEvalDurationMs"], false),
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
  const contextNotice = checkOptionalString("contextNotice", v["contextNotice"]);
  if (contextNotice !== undefined) msg.contextNotice = contextNotice;
  const thinking = checkOptionalString("thinking", v["thinking"]);
  if (thinking !== undefined) msg.thinking = thinking;
  const model = checkOptionalString("model", v["model"]);
  if (model !== undefined) msg.model = model;
  const stats = checkStats(v["stats"]);
  if (stats !== undefined) msg.stats = stats;
  const tools = checkTools(v["tools"]);
  if (tools !== undefined) msg.tools = tools;
  const images = checkImages(v["images"]);
  if (images !== undefined) msg.images = images;
  return msg;
}

function checkTools(value: unknown): ToolStepRecord[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new InvalidInputError("tools", "expected an array");
  if (value.length === 0) return undefined;
  return value.map((item: unknown, i): ToolStepRecord => {
    const at = `tools[${i}]`;
    if (typeof item !== "object" || item === null) throw new InvalidInputError(at, "expected an object");
    const t = item as Record<string, unknown>;
    checkId(`${at}.callId`, t["callId"]);
    checkId(`${at}.name`, t["name"]);
    const state = t["state"];
    if (!TOOL_STATES.includes(state as ToolStepRecord["state"])) {
      throw new InvalidInputError(`${at}.state`, `expected one of ${TOOL_STATES.join(", ")}`);
    }
    const summary = t["summary"];
    if (typeof summary !== "string") throw new InvalidInputError(`${at}.summary`, "expected a string");
    const step: ToolStepRecord = { callId: t["callId"], name: t["name"], state: state as ToolStepRecord["state"], summary };
    const detail = checkOptionalString(`${at}.detail`, t["detail"]);
    if (detail !== undefined) step.detail = detail;
    const durationMs = checkCount(`${at}.durationMs`, t["durationMs"], false);
    if (durationMs !== undefined) step.durationMs = durationMs;
    if (t["links"] !== undefined) step.links = [...S.decodeUnknownSync(S.Array(S.String))(t["links"])];
    return step;
  });
}

function checkImages(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new InvalidInputError("images", "expected an array");
  if (value.length === 0) return undefined;
  return value.map((item: unknown, i) => {
    if (typeof item !== "string" || item.length === 0) throw new InvalidInputError(`images[${i}]`, "expected a non-empty string");
    return item;
  });
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
  if (s.evalDurationMs !== undefined) out.evalDurationMs = s.evalDurationMs;
  if (s.promptEvalDurationMs !== undefined) out.promptEvalDurationMs = s.promptEvalDurationMs;
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
    evalDurationMs: optNum(row, "eval_duration_ms"),
    promptEvalDurationMs: optNum(row, "prompt_eval_duration_ms"),
  });
  if (stats !== undefined) msg.stats = stats;
  const tools = optStr(row, "tools_json");
  if (tools !== undefined) msg.tools = JSON.parse(tools) as ToolStepRecord[];
  const images = optStr(row, "images_json");
  if (images !== undefined) msg.images = JSON.parse(images) as string[];
  const notice = optStr(row, "context_notice");
  if (notice !== undefined) msg.contextNotice = notice;
  const job = optStr(row, "image_job_json");
  if (job !== undefined) msg.imageJob = S.decodeUnknownSync(ImageEvent)(JSON.parse(job));
  return msg;
}
