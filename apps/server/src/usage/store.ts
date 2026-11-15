import { mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { canonicalTag } from "../runtime/recommended.ts";

export interface UsageRow {
  readonly hour: number;
  readonly model: string;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly replies: number;
  readonly decodeMs: number;
  readonly decodeTokens: number;
  readonly readMs: number;
  readonly readTokens: number;
  readonly wallMs: number;
}

export interface UsageRead {
  readonly rows: UsageRow[];
  readonly models: string[];
}

export interface UsageFigures {
  readonly promptTokens?: number | undefined;
  readonly completionTokens?: number | undefined;
  readonly evalDurationMs?: number | undefined;
  readonly promptEvalDurationMs?: number | undefined;
  readonly durationMs?: number | undefined;
}

export interface StoredReply extends UsageFigures {
  readonly model: string;
  readonly at: number;
}

export interface UsageStore {
  record(model: string, figures: UsageFigures, firstRequest: boolean): void;
  read(since: number): UsageRead;
  fillOnce(replies: Iterable<StoredReply>): boolean;
  close(): void;
}

export interface UsageStoreOptions {
  now?: () => number;
  log?: (line: string) => void;
  busyTimeoutMs?: number;
}

const HOUR = 3_600_000;
const VERSION = 1;
const FILLED = "filled";
const FILL_BEFORE = "fill_before";

const startOfUtcHourMs = (ms: number) => Math.floor(ms / HOUR) * HOUR;
const valid = (n: number | undefined): n is number => n !== undefined && Number.isFinite(n) && n >= 0;
const count = (n: number | undefined) => (valid(n) ? Math.trunc(n) : 0);
const filenameSafeUtcStamp = (ms: number) => new Date(ms).toISOString().replace(/[:.]/g, "-");

const COLUMNS = ["prompt_tokens", "completion_tokens", "replies", "decode_ms", "decode_tokens", "read_ms", "read_tokens", "wall_ms"] as const;

function renameIfThere(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch {
    return;
  }
}

function openDb(file: string, busyTimeoutMs: number): DatabaseSync {
  const db = new DatabaseSync(file, { timeout: busyTimeoutMs });
  try {
    db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.trunc(busyTimeoutMs))}`);
    if (file !== ":memory:") {
      const mode = db.prepare("PRAGMA journal_mode = WAL").get()?.["journal_mode"];
      if (mode !== "wal") throw new Error(`could not enable WAL (journal_mode=${String(mode)})`);
    }
    db.exec("PRAGMA synchronous = FULL");
    const version = Number(db.prepare("PRAGMA user_version").get()?.["user_version"] ?? 0);
    if (version > VERSION) throw new Error(`written by a newer version (${version})`);
    db.exec(`CREATE TABLE IF NOT EXISTS usage_hours (
      hour INTEGER NOT NULL, model TEXT NOT NULL,
      prompt_tokens INTEGER NOT NULL DEFAULT 0, completion_tokens INTEGER NOT NULL DEFAULT 0, replies INTEGER NOT NULL DEFAULT 0,
      decode_ms REAL NOT NULL DEFAULT 0, decode_tokens INTEGER NOT NULL DEFAULT 0,
      read_ms REAL NOT NULL DEFAULT 0, read_tokens INTEGER NOT NULL DEFAULT 0,
      wall_ms REAL NOT NULL DEFAULT 0,
      PRIMARY KEY (hour, model)) WITHOUT ROWID`);
    db.exec("CREATE TABLE IF NOT EXISTS usage_models (seq INTEGER PRIMARY KEY, model TEXT NOT NULL UNIQUE)");
    db.exec("CREATE TABLE IF NOT EXISTS usage_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    db.exec(`PRAGMA user_version = ${VERSION}`);
    // why: a header can open over pages or columns that do not, so every table is read once.
    db.prepare(`SELECT count(*) AS n, ${COLUMNS.map((c) => `sum(${c})`).join(", ")} FROM usage_hours`).get();
    db.prepare("SELECT count(*) AS n FROM usage_models").get();
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}

function openOrStartEmpty(file: string, busyTimeoutMs: number, now: () => number, log: (line: string) => void): DatabaseSync {
  mkdirSync(dirname(file), { recursive: true });
  try {
    return openDb(file, busyTimeoutMs);
  } catch (err) {
    const aside = `${file}.bad-${filenameSafeUtcStamp(now())}`;
    const reason = (err as Error).message;
    try {
      renameSync(file, aside);
      for (const suffix of ["-wal", "-shm"]) renameIfThere(`${file}${suffix}`, `${aside}${suffix}`);
      const db = openDb(file, busyTimeoutMs);
      log(`usage: ${file} unreadable (${reason}); kept as ${aside}, starting empty`);
      return db;
    } catch (again) {
      log(`usage: ${file} unreadable (${reason}) and could not be replaced (${(again as Error).message}); starting empty in memory`);
      return openDb(":memory:", busyTimeoutMs);
    }
  }
}

export function openUsageStore(file: string, options: UsageStoreOptions = {}): UsageStore {
  const now = options.now ?? Date.now;
  const db = openOrStartEmpty(file, options.busyTimeoutMs ?? 5000, now, options.log ?? (() => undefined));

  const stmt = {
    model: db.prepare("INSERT INTO usage_models (model) VALUES (?) ON CONFLICT(model) DO NOTHING"),
    add: db.prepare(`INSERT INTO usage_hours (hour, model, ${COLUMNS.join(", ")}) VALUES (?, ?, ${COLUMNS.map(() => "?").join(", ")})
      ON CONFLICT(hour, model) DO UPDATE SET ${COLUMNS.map((c) => `${c} = ${c} + excluded.${c}`).join(", ")}`),
    rows: db.prepare(`SELECT hour, model, ${COLUMNS.join(", ")} FROM usage_hours WHERE hour >= ? ORDER BY hour, model`),
    models: db.prepare("SELECT model FROM usage_models ORDER BY seq"),
    meta: db.prepare("SELECT value FROM usage_meta WHERE key = ?"),
    setMeta: db.prepare("INSERT INTO usage_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"),
    delMeta: db.prepare("DELETE FROM usage_meta WHERE key = ?"),
  };
  // why: the fill's cutoff is fixed at the first open; replies recorded live from then are counted.
  if (stmt.meta.get(FILLED) === undefined && stmt.meta.get(FILL_BEFORE) === undefined) stmt.setMeta.run(FILL_BEFORE, String(now()));

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

  const add = (model: string, at: number, f: UsageFigures, replies: number) => {
    const key = canonicalTag(model);
    const reportedDecodeTime = valid(f.evalDurationMs) && valid(f.completionTokens);
    const reportedReadTime = valid(f.promptEvalDurationMs) && valid(f.promptTokens);
    stmt.model.run(key);
    stmt.add.run(
      startOfUtcHourMs(at), key,
      count(f.promptTokens), count(f.completionTokens), replies,
      reportedDecodeTime ? f.evalDurationMs! : 0, reportedDecodeTime ? count(f.completionTokens) : 0,
      reportedReadTime ? f.promptEvalDurationMs! : 0, reportedReadTime ? count(f.promptTokens) : 0,
      valid(f.durationMs) ? f.durationMs : 0,
    );
  };

  return {
    record(model, figures, firstRequest) {
      if (figures.promptTokens === undefined && figures.completionTokens === undefined) return;
      transaction(() => add(model, now(), figures, firstRequest ? 1 : 0));
    },
    read(since) {
      const rows = stmt.rows.all(startOfUtcHourMs(since)).map((r) => ({
        hour: Number(r["hour"]),
        model: String(r["model"]),
        promptTokens: Number(r["prompt_tokens"]),
        completionTokens: Number(r["completion_tokens"]),
        replies: Number(r["replies"]),
        decodeMs: Number(r["decode_ms"]),
        decodeTokens: Number(r["decode_tokens"]),
        readMs: Number(r["read_ms"]),
        readTokens: Number(r["read_tokens"]),
        wallMs: Number(r["wall_ms"]),
      }));
      return { rows, models: stmt.models.all().map((r) => String(r["model"])) };
    },
    fillOnce(replies) {
      return transaction(() => {
        if (stmt.meta.get(FILLED) !== undefined) return false;
        const countedLiveFrom = Number(stmt.meta.get(FILL_BEFORE)?.["value"] ?? Infinity);
        for (const r of [...replies].filter((stored) => stored.at < countedLiveFrom).toSorted((a, b) => a.at - b.at)) add(r.model, r.at, r, 1);
        stmt.setMeta.run(FILLED, String(now()));
        stmt.delMeta.run(FILL_BEFORE);
        return true;
      });
    },
    close() {
      if (db.isOpen) db.close();
    },
  };
}
