// external: node:sqlite needs no native build, so the store runs under Electron's Node too

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLOutputValue, type StatementSync } from "node:sqlite";
import { AttachedFile, ImageChoice, ImageCount, ImageEvent, ReplyTimes } from "@gates-local/contracts";
import * as S from "effect/Schema";

import {
  DuplicateMessageError,
  InvalidInputError,
  StoreClosedError,
  ThreadNotFoundError,
} from "./errors.ts";
import { ensureMessageColumns, migrate } from "./migrations.ts";
import { createPictureIndex, ensurePicturesTable, type PictureFacts, type PictureIndex } from "../pictures/table.ts";
import { ROLES, TOOL_STATES, type Message, type MessageStats, type NewMessage, type Role, type Thread, type ThreadWithMessages, type ToolStepRecord } from "./types.ts";

export interface ThreadStoreOptions {
  now?: () => number;
  busyTimeoutMs?: number;
}

export interface ThreadStore {
  getMessage(messageId: string): Message | undefined;
  fencedReplies(threadId: string, before?: string): Array<{ id: string; content: string }>;
  deleteMessage(threadId: string, messageId: string): void;
  imageReferences(): Map<string, number>;
  fileReferences(): Map<string, number>;
  fileOwners(): Map<string, string>;
  replyUsage(): {
    replies: Array<{ model: string; at: number; promptTokens: number | undefined; completionTokens: number | undefined; evalDurationMs: number | undefined; promptEvalDurationMs: number | undefined; durationMs: number | undefined }>;
    lacking: number;
  };
  readonly dbPath: string;
  readonly numbers: { list(): number; chat(threadId: string): number };
  threadRow(threadId: string): Thread | undefined;
  listThreads(): Thread[];
  createThread(input?: { title?: string }): Thread;
  getThread(threadId: string): ThreadWithMessages;
  getThreadPage(threadId: string, page: { before?: string; limit?: number; skip?: string }): (ThreadWithMessages & { earlier: number }) | undefined;
  renameThread(threadId: string, title: string): Thread;
  setImageChoice(threadId: string, choice: ImageChoice): Thread;
  fillImageChoice(threadId: string, choice: ImageChoice): boolean;
  imageChoiceOf(threadId: string): ImageChoice | undefined;
  setImageCount(threadId: string, count: ImageCount): Thread;
  deleteThread(threadId: string): void;
  // why: a reader sees the old rows or the new one, never both and never neither
  appendMessage(input: NewMessage, replacing?: readonly string[]): Message;
  stampTimes(threadId: string, messageId: string, times: ReplyTimes): void;
  saveImageJob(event: ImageEvent, prompt: string, picture?: PictureFacts): void;
  readonly pictures: PictureIndex;
  claimImageRetry(threadId: string, previousJobId: string, jobId: string, fallback: ImageChoice): { jobId: string; prompt: string; choice: ImageChoice; created: boolean };
  interruptImageJobs(): ImageEvent[];
  modelSpeeds(): ModelSpeed[];
  close(): void;
}

// why: replies older than 14 days say nothing about this computer now
export const SPEED_WINDOW_MS = 14 * 86_400_000;
// why: a reply or two of a few words is noise
export const SPEED_MIN_TOKENS = 50;
export const SPEED_SQL = `SELECT model, SUM(completion_tokens) AS tokens, SUM(eval_duration_ms) AS ms, COUNT(*) AS replies
  FROM messages INDEXED BY messages_speed
  WHERE role = 'assistant' AND eval_duration_ms > 0 AND completion_tokens IS NOT NULL AND created_at >= ? AND model IS NOT NULL
  GROUP BY model`;

export interface ModelSpeed {
  model: string;
  tokensPerSecond: number;
  replies: number;
}

export const DEFAULT_THREAD_TITLE = "New thread";
const MAX_TITLE = 500;
const MAX_ID = 200;
const DEFAULT_BUSY_TIMEOUT_MS = 5000;
const opt = (v: SQLOutputValue | undefined) => (typeof v === "number" ? v : undefined);

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
    // why: set first, so the WAL switch and the migrations wait on a second process, not fail
    db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.trunc(busyTimeoutMs))}`);
    const mode = db.prepare("PRAGMA journal_mode = WAL").get()?.["journal_mode"];
    if (mode !== "wal") throw new Error(`could not enable WAL on ${dbPath} (journal_mode=${String(mode)})`);
    // external: in WAL mode SQLite's synchronous=NORMAL can lose the last commits on a power cut
    db.exec("PRAGMA synchronous = FULL");
    db.exec("PRAGMA foreign_keys = ON");
    migrate(db, dbPath);
    ensureMessageColumns(db);
    ensurePicturesTable(db);
  } catch (err) {
    db.close();
    throw err;
  }

  const choiceColumn = `COALESCE(image_choice_json, (SELECT json_extract(m.image_job_json, '$.choice') FROM messages m
    WHERE m.thread_id = threads.id AND json_extract(m.image_job_json, '$.state') = 'done'
    ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1)) AS image_choice_json`;
  const messageColumns = `id, thread_id, role, content, thinking, model, created_at,
              prompt_tokens, completion_tokens, duration_ms, num_ctx,
              tools_json, images_json, eval_duration_ms, prompt_eval_duration_ms, interrupted, image_job_json, context_notice, times_json, files_json`;
  const shown = "thread_id = ? AND id IS NOT ?";
  const stmt = {
    listThreads: db.prepare(`SELECT id, title, created_at, updated_at, image_count, ${choiceColumn} FROM threads ORDER BY updated_at DESC, id`),
    getThread: db.prepare(`SELECT id, title, created_at, updated_at, image_count, ${choiceColumn} FROM threads WHERE id = ?`),
    insertThread: db.prepare("INSERT INTO threads (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)"),
    renameThread: db.prepare("UPDATE threads SET title = ?, updated_at = MAX(updated_at, ?) WHERE id = ?"),
    setImageChoice: db.prepare("UPDATE threads SET image_choice_json = ? WHERE id = ?"),
    fillImageChoice: db.prepare("UPDATE threads SET image_choice_json = ? WHERE id = ? AND image_choice_json IS NULL"),
    setImageCount: db.prepare("UPDATE threads SET image_count = ? WHERE id = ?"),
    deleteThread: db.prepare("DELETE FROM threads WHERE id = ?"),
    touchThread: db.prepare("UPDATE threads SET updated_at = MAX(updated_at, ?) WHERE id = ?"),
    messageExists: db.prepare("SELECT 1 AS hit FROM messages WHERE id = ?"),
    deleteMessage: db.prepare("DELETE FROM messages WHERE id = ? AND thread_id = ?"),
    getMessage: db.prepare("SELECT * FROM messages WHERE id = ?"),
    insertMessage: db.prepare(
      `INSERT INTO messages (id, thread_id, role, content, thinking, model, created_at,
                             prompt_tokens, completion_tokens, duration_ms, num_ctx,
                             tools_json, images_json, eval_duration_ms, prompt_eval_duration_ms, interrupted, context_notice, times_json, files_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    listMessages: db.prepare(`SELECT ${messageColumns} FROM messages WHERE thread_id = ? ORDER BY created_at, seq`),
    pageKey: db.prepare("SELECT created_at, seq FROM messages WHERE id = ? AND thread_id = ?"),
    pageNewest: db.prepare(`SELECT ${messageColumns}, seq FROM messages WHERE ${shown} AND (created_at, seq) < (?, ?) ORDER BY created_at DESC, seq DESC LIMIT ?`),
    pageQuestion: db.prepare(`SELECT created_at, seq FROM messages WHERE ${shown} AND role = 'user' AND (created_at, seq) <= (?, ?) ORDER BY created_at DESC, seq DESC LIMIT 1`),
    pageBetween: db.prepare(`SELECT ${messageColumns} FROM messages WHERE ${shown} AND (created_at, seq) >= (?, ?) AND (created_at, seq) < (?, ?) ORDER BY created_at, seq`),
    pageEarlier: db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE ${shown} AND (created_at, seq) < (?, ?)`),
    stampTimes: db.prepare("UPDATE messages SET times_json = ? WHERE id = ? AND thread_id = ?"),
    insertImageCard: db.prepare("INSERT INTO messages (id, thread_id, role, content, created_at, image_job_json) VALUES (?, ?, 'assistant', ?, ?, ?) ON CONFLICT(id) DO NOTHING"),
    updateImageCard: db.prepare("UPDATE messages SET image_job_json = ?, images_json = ? WHERE id = ? AND thread_id = ?"),
    unfinishedImages: db.prepare("SELECT image_job_json FROM messages WHERE json_extract(image_job_json, '$.state') IN ('queued', 'running')"),
    getImageCard: db.prepare("SELECT content, image_job_json FROM messages WHERE id = ? AND thread_id = ? AND image_job_json IS NOT NULL"),
    speeds: db.prepare(SPEED_SQL),
  } satisfies Record<string, StatementSync>;
  const pictures = createPictureIndex(db);

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

  // why: a reader that sees a number must see its write, so each number is taken after commit
  let listNumber = 0;
  const chatNumbers = new Map<string, number>();
  const wrote = (threadId: string, messages: boolean): void => {
    listNumber++;
    if (messages) chatNumbers.set(threadId, listNumber);
  };

  return {
    dbPath,
    pictures,
    numbers: { list: () => listNumber, chat: threadId => chatNumbers.get(threadId) ?? 0 },

    threadRow(threadId) {
      guard();
      const row = stmt.getThread.get(threadId);
      return row ? threadFromRow(row) : undefined;
    },

    getMessage(messageId) {
      guard(); checkId("messageId", messageId);
      const row = stmt.getMessage.get(messageId);
      return row ? messageFromRow(row) : undefined;
    },

    fencedReplies(threadId, before) {
      guard(); loadThread(threadId);
      const fenced = "SELECT id, content FROM messages WHERE thread_id = ? AND role = 'assistant' AND instr(content, '```') > 0";
      const rows = before === undefined
        ? db.prepare(`${fenced} ORDER BY created_at, seq`).all(threadId)
        : db.prepare(`${fenced} AND (created_at, seq) < (SELECT created_at, seq FROM messages WHERE id = ? AND thread_id = ?) ORDER BY created_at, seq`).all(threadId, before, threadId);
      return rows.map((row) => ({ id: str(row, "id"), content: str(row, "content") }));
    },

    deleteMessage(threadId, messageId) {
      guard(); checkId("messageId", messageId); loadThread(threadId);
      stmt.deleteMessage.run(messageId, threadId);
      wrote(threadId, true);
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
    fileReferences() {
      guard();
      const refs = new Map<string, number>();
      for (const row of db.prepare("SELECT files_json FROM messages WHERE files_json IS NOT NULL").all()) {
        for (const file of decodeFiles(JSON.parse(str(row, "files_json")))) refs.set(file.path, (refs.get(file.path) ?? 0) + 1);
      }
      return refs;
    },

    fileOwners() {
      guard();
      const owners = new Map<string, string>();
      for (const row of db.prepare("SELECT thread_id, files_json FROM messages WHERE files_json IS NOT NULL").all()) {
        for (const file of decodeFiles(JSON.parse(str(row, "files_json")))) if (!owners.has(file.path)) owners.set(file.path, str(row, "thread_id"));
      }
      return owners;
    },

    replyUsage() {
      guard();
      const replies: ReturnType<ThreadStore["replyUsage"]>["replies"] = [];
      let lacking = 0;
      const rows = db.prepare("SELECT model, created_at, prompt_tokens, completion_tokens, eval_duration_ms, prompt_eval_duration_ms, duration_ms FROM messages WHERE role = 'assistant' AND image_job_json IS NULL").all();
      for (const row of rows) {
        const prompt = opt(row["prompt_tokens"]);
        const completion = opt(row["completion_tokens"]);
        const model = row["model"];
        if ((prompt === undefined && completion === undefined) || typeof model !== "string") lacking++;
        else replies.push({ model, at: Number(row["created_at"]), promptTokens: prompt, completionTokens: completion, evalDurationMs: opt(row["eval_duration_ms"]), promptEvalDurationMs: opt(row["prompt_eval_duration_ms"]), durationMs: opt(row["duration_ms"]) });
      }
      return { replies, lacking };
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
      wrote(thread.id, true);
      return thread;
    },

    getThread(threadId) {
      guard();
      checkId("threadId", threadId);
      // why: one read transaction, so the row and its messages come from one snapshot
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

    getThreadPage(threadId, { before, limit, skip }) {
      guard();
      checkId("threadId", threadId);
      const hide = skip ?? null;
      db.exec("BEGIN");
      try {
        const thread = loadThread(threadId);
        let end: [number, number] = [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER];
        if (before !== undefined) {
          const key = before === skip ? undefined : stmt.pageKey.get(before, threadId);
          if (!key) { db.exec("COMMIT"); return undefined; }
          end = [num(key, "created_at"), num(key, "seq")];
        }
        const rows = stmt.pageNewest.all(threadId, hide, ...end, limit ?? -1).toReversed();
        const oldest = rows[0];
        let page = rows;
        let earlier = 0;
        if (limit !== undefined && oldest !== undefined && rows.length === limit) {
          let start: [number, number] = [num(oldest, "created_at"), num(oldest, "seq")];
          if (oldest["role"] !== "user") {
            const question = stmt.pageQuestion.get(threadId, hide, ...start);
            start = question === undefined ? [Number.MIN_SAFE_INTEGER, Number.MIN_SAFE_INTEGER] : [num(question, "created_at"), num(question, "seq")];
            page = stmt.pageBetween.all(threadId, hide, ...start, ...end);
          }
          earlier = num(stmt.pageEarlier.get(threadId, hide, ...start) ?? { n: 0 }, "n");
        }
        const messages = page.map(messageFromRow);
        db.exec("COMMIT");
        return { thread, messages, earlier };
      } catch (err) {
        if (db.isTransaction) db.exec("ROLLBACK");
        throw err;
      }
    },

    renameThread(threadId, title) {
      guard();
      checkId("threadId", threadId);
      const clean = checkTitle(title);
      const thread = transaction(() => {
        const res = stmt.renameThread.run(clean, now(), threadId);
        if (Number(res.changes) === 0) throw new ThreadNotFoundError(threadId);
        return loadThread(threadId);
      });
      wrote(threadId, false);
      return thread;
    },

    setImageChoice(threadId, choice) {
      guard();
      checkId("threadId", threadId);
      const clean = S.decodeUnknownSync(ImageChoice)(choice);
      const thread = transaction(() => {
        const res = stmt.setImageChoice.run(JSON.stringify(clean), threadId);
        if (Number(res.changes) === 0) throw new ThreadNotFoundError(threadId);
        return loadThread(threadId);
      });
      wrote(threadId, false);
      return thread;
    },

    fillImageChoice(threadId, choice) {
      guard();
      checkId("threadId", threadId);
      const filled = Number(stmt.fillImageChoice.run(JSON.stringify(S.decodeUnknownSync(ImageChoice)(choice)), threadId).changes) > 0;
      if (filled) wrote(threadId, false);
      return filled;
    },

    imageChoiceOf(threadId) {
      guard();
      checkId("threadId", threadId);
      return loadThread(threadId).imageChoice;
    },

    setImageCount(threadId, count) {
      guard();
      checkId("threadId", threadId);
      const clean = S.decodeUnknownSync(ImageCount)(count);
      const thread = transaction(() => {
        const res = stmt.setImageCount.run(clean, threadId);
        if (Number(res.changes) === 0) throw new ThreadNotFoundError(threadId);
        return loadThread(threadId);
      });
      wrote(threadId, false);
      return thread;
    },

    deleteThread(threadId) {
      guard();
      checkId("threadId", threadId);
      const res = stmt.deleteThread.run(threadId);
      if (Number(res.changes) === 0) throw new ThreadNotFoundError(threadId);
      wrote(threadId, true);
    },

    appendMessage(input, replacing = []) {
      guard();
      const msg = checkNewMessage(input, now);
      const saved = transaction(() => {
        loadThread(msg.threadId);
        for (const id of replacing) stmt.deleteMessage.run(id, msg.threadId);
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
          msg.interrupted === true ? 1 : null,
          msg.contextNotice ?? null,
          msg.times === undefined ? null : JSON.stringify(msg.times),
          msg.files === undefined ? null : JSON.stringify(msg.files),
        );
        stmt.touchThread.run(Math.max(now(), msg.createdAt), msg.threadId);
        return msg;
      });
      wrote(msg.threadId, true);
      return saved;
    },

    stampTimes(threadId, messageId, times) {
      guard();
      if (Number(stmt.stampTimes.run(JSON.stringify(checkTimes(times)), messageId, threadId).changes) > 0) wrote(threadId, true);
    },

    saveImageJob(event, prompt, picture) {
      guard();
      const clean = S.decodeUnknownSync(ImageEvent)(event);
      const threadId = clean.threadId;
      if (!threadId) return;
      const saved = transaction(() => {
        if (!stmt.getThread.get(threadId)) return false;
        stmt.insertImageCard.run(clean.jobId, threadId, prompt, now(), JSON.stringify(clean));
        stmt.updateImageCard.run(JSON.stringify(clean), clean.imagePath ? JSON.stringify([clean.imagePath]) : null, clean.jobId, threadId);
        if (clean.state === "done" && clean.imagePath && picture) pictures.record(clean.jobId, picture, now());
        stmt.touchThread.run(now(), threadId);
        return true;
      });
      if (saved) wrote(threadId, true);
    },

    claimImageRetry(threadId, previousJobId, jobId, fallback) {
      guard();
      const claim = transaction(() => {
        loadThread(threadId);
        const row = stmt.getImageCard.get(previousJobId, threadId);
        if (!row) throw new InvalidInputError("retryOf", "the image job is not in this thread");
        const previous = S.decodeUnknownSync(ImageEvent)(JSON.parse(str(row, "image_job_json")));
        const prompt = str(row, "content");
        const choice = previous.choice ?? fallback;
        if (previous.retryJobId) return { jobId: previous.retryJobId, prompt, choice, created: false };
        if (previous.state !== "error" && previous.state !== "cancelled") throw new InvalidInputError("retryOf", "only a failed or cancelled image can be retried");
        const next: ImageEvent = { jobId, threadId, state: "queued", choice };
        stmt.insertImageCard.run(jobId, threadId, prompt, now(), JSON.stringify(next));
        stmt.updateImageCard.run(JSON.stringify({ ...previous, retryJobId: jobId }), null, previousJobId, threadId);
        stmt.touchThread.run(now(), threadId);
        return { jobId, prompt, choice, created: true };
      });
      if (claim.created) wrote(threadId, true);
      return claim;
    },

    interruptImageJobs() {
      guard();
      const events = transaction(() => stmt.unfinishedImages.all().map((row) => {
        const old = S.decodeUnknownSync(ImageEvent)(JSON.parse(str(row, "image_job_json")));
        if (!old.threadId) throw new Error("Saved image job is missing its thread");
        const event: ImageEvent = { jobId: old.jobId, threadId: old.threadId, state: "error", errorKind: "restarted", message: "The app restarted before this image finished; try again.", ...(old.choice ? { choice: old.choice } : {}), ...(old.sent ? { sent: old.sent } : {}), ...(old.group ? { group: old.group } : {}) };
        stmt.updateImageCard.run(JSON.stringify(event), null, old.jobId, old.threadId);
        return event;
      }));
      for (const threadId of new Set(events.map(event => event.threadId))) if (threadId) wrote(threadId, true);
      return events;
    },

    modelSpeeds() {
      guard();
      const sums = new Map<string, { tokens: number; ms: number; replies: number }>();
      for (const row of stmt.speeds.all(now() - SPEED_WINDOW_MS)) {
        const model = str(row, "model").replace(/:latest$/, "");
        const sum = sums.get(model) ?? { tokens: 0, ms: 0, replies: 0 };
        sum.tokens += Number(row["tokens"]); sum.ms += Number(row["ms"]); sum.replies += Number(row["replies"]);
        sums.set(model, sum);
      }
      return [...sums].filter(([, s]) => s.tokens >= SPEED_MIN_TOKENS && s.ms > 0)
        .map(([model, s]) => ({ model, tokensPerSecond: s.tokens / (s.ms / 1000), replies: s.replies }))
        .toSorted((a, b) => (a.model < b.model ? -1 : a.model > b.model ? 1 : 0));
    },

    close() {
      if (!open) return;
      open = false;
      db.close();
    },
  };
}

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
  if (v["files"] !== undefined) {
    if (role !== "user") throw new InvalidInputError("files", "only a person's message carries attached files");
    const files = decodeFiles(v["files"]);
    if (files.length) msg.files = files;
  }
  if (v["interrupted"] !== undefined) {
    if (v["interrupted"] !== true || role !== "assistant") throw new InvalidInputError("interrupted", "only an unfinished assistant reply can be marked interrupted");
    msg.interrupted = true;
  }
  if (v["times"] !== undefined) msg.times = checkTimes(v["times"]);
  return msg;
}

const decodeTimes = S.decodeUnknownSync(ReplyTimes);

function checkTimes(value: unknown): ReplyTimes {
  try {
    return decodeTimes(value);
  } catch (e) {
    throw new InvalidInputError("times", (e as Error).message);
  }
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
    if (t["stopped"] !== undefined) {
      if (t["stopped"] !== true || state !== "error") throw new InvalidInputError(`${at}.stopped`, "only a step that ended as error can be marked stopped, and only true");
      step.stopped = true;
    }
    const detail = checkOptionalString(`${at}.detail`, t["detail"]);
    if (detail !== undefined) step.detail = detail;
    const durationMs = checkCount(`${at}.durationMs`, t["durationMs"], false);
    if (durationMs !== undefined) step.durationMs = durationMs;
    if (t["links"] !== undefined) step.links = [...S.decodeUnknownSync(S.Array(S.String))(t["links"])];
    return step;
  });
}

const decodeFiles = (value: unknown): AttachedFile[] => [...S.decodeUnknownSync(S.Array(AttachedFile))(value)];

function checkImages(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new InvalidInputError("images", "expected an array");
  if (value.length === 0) return undefined;
  return value.map((item: unknown, i) => {
    if (typeof item !== "string" || item.length === 0) throw new InvalidInputError(`images[${i}]`, "expected a non-empty string");
    return item;
  });
}

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
  const thread: Thread = { id: str(row, "id"), title: str(row, "title"), createdAt: num(row, "created_at"), updatedAt: num(row, "updated_at") };
  const choice = optStr(row, "image_choice_json");
  if (choice !== undefined) {
    try { thread.imageChoice = S.decodeUnknownSync(ImageChoice)(JSON.parse(choice)); } catch {}
  }
  const count = opt(row["image_count"]);
  if (count !== undefined && count !== 1 && S.is(ImageCount)(count)) thread.imageCount = count;
  return thread;
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
  if (row["interrupted"] === 1) msg.interrupted = true;
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
  const files = optStr(row, "files_json");
  if (files !== undefined) msg.files = decodeFiles(JSON.parse(files));
  const notice = optStr(row, "context_notice");
  if (notice !== undefined) msg.contextNotice = notice;
  const job = optStr(row, "image_job_json");
  if (job !== undefined) msg.imageJob = S.decodeUnknownSync(ImageEvent)(JSON.parse(job));
  const times = optStr(row, "times_json");
  if (times !== undefined) msg.times = decodeTimes(JSON.parse(times));
  return msg;
}
