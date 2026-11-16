import type { DatabaseSync } from "node:sqlite";

import { copyBeforeMigration } from "./copies.ts";
import { StoreVersionTooNewError } from "./errors.ts";

export interface Migration {
  version: number;
  up: (db: DatabaseSync) => void;
}

function addMessageColumns(db: DatabaseSync): void {
  const columns = new Set(db.prepare("PRAGMA table_info(messages)").all().map(row => row["name"]));
  for (const name of ["image_job_json", "context_notice", "files_json"]) {
    if (!columns.has(name)) db.exec(`ALTER TABLE messages ADD COLUMN ${name} TEXT`);
  }
}

// why: a shipped step may have run on someone's database already, so a change is a new step
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    up: (db) => {
      db.exec(`
        CREATE TABLE threads (
          id          TEXT PRIMARY KEY NOT NULL,
          title       TEXT NOT NULL,
          created_at  INTEGER NOT NULL,
          updated_at  INTEGER NOT NULL
        ) STRICT;

        CREATE INDEX threads_by_updated ON threads (updated_at DESC, id);

        -- seq is the insertion order; it breaks created_at ties so two
        -- messages in the same millisecond keep the order they were written.
        CREATE TABLE messages (
          seq                INTEGER PRIMARY KEY AUTOINCREMENT,
          id                 TEXT NOT NULL UNIQUE,
          thread_id          TEXT NOT NULL REFERENCES threads (id) ON DELETE CASCADE,
          role               TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
          content            TEXT NOT NULL,
          thinking           TEXT,
          model              TEXT,
          created_at         INTEGER NOT NULL,
          prompt_tokens      INTEGER,
          completion_tokens  INTEGER,
          duration_ms        REAL,
          num_ctx            INTEGER
        ) STRICT;

        CREATE INDEX messages_by_thread_time ON messages (thread_id, created_at, seq);
      `);
    },
  },
  {
    version: 2,
    up: (db) => {
      db.exec(`
        ALTER TABLE messages ADD COLUMN tools_json TEXT;
        ALTER TABLE messages ADD COLUMN images_json TEXT;
      `);
    },
  },
  {
    version: 3,
    up: (db) => {
      db.exec(`
        ALTER TABLE messages ADD COLUMN eval_duration_ms REAL;
        ALTER TABLE messages ADD COLUMN prompt_eval_duration_ms REAL;
      `);
    },
  },
  {
    version: 4,
    up: addMessageColumns,
  },
  {
    version: 5,
    up: addMessageColumns,
  },
];

export const LATEST_VERSION: number = MIGRATIONS.length;

export function ensureMessageColumns(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    addMessageColumns(db);
    const columns = new Set(db.prepare("PRAGMA table_info(messages)").all().map(row => row["name"]));
    if (!columns.has("interrupted")) db.exec("ALTER TABLE messages ADD COLUMN interrupted INTEGER CHECK (interrupted IS NULL OR interrupted = 1)");
    if (!columns.has("times_json")) db.exec("ALTER TABLE messages ADD COLUMN times_json TEXT");
    const threadColumns = new Set(db.prepare("PRAGMA table_info(threads)").all().map(row => row["name"]));
    if (!threadColumns.has("image_choice_json")) db.exec("ALTER TABLE threads ADD COLUMN image_choice_json TEXT");
    if (!threadColumns.has("image_count")) db.exec("ALTER TABLE threads ADD COLUMN image_count INTEGER");
    db.exec(`CREATE INDEX IF NOT EXISTS messages_speed ON messages (created_at, model, completion_tokens, eval_duration_ms, role)
             WHERE role = 'assistant' AND eval_duration_ms > 0 AND completion_tokens IS NOT NULL`);
    db.exec("COMMIT");
  } catch (error) { if (db.isTransaction) db.exec("ROLLBACK"); throw error; }
}

function readUserVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get();
  const v = row?.["user_version"];
  return typeof v === "number" ? v : Number(v ?? 0);
}

export function migrate(db: DatabaseSync, dbPath: string, migrations: readonly Migration[] = MIGRATIONS): number {
  const latest = migrations.length;
  migrations.forEach((m, i) => {
    if (m.version !== i + 1) throw new Error(`migration list out of order at index ${i}: version ${m.version}`);
  });

  const initial = readUserVersion(db);
  if (initial > latest) throw new StoreVersionTooNewError(dbPath, initial, latest);
  if (initial < latest && (initial > 0 || db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' LIMIT 1").get() !== undefined)) {
    copyBeforeMigration(db, dbPath, latest);
  }

  for (;;) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const current = readUserVersion(db);
      if (current > latest) throw new StoreVersionTooNewError(dbPath, current, latest);
      if (current === latest) {
        addMessageColumns(db);
        db.exec("COMMIT");
        return current;
      }
      const step = migrations[current];
      if (!step) throw new Error(`no migration for version ${current + 1}`);
      step.up(db);
      // external: SQLite's PRAGMA takes no bound parameters; the version is an integer we own
      db.exec(`PRAGMA user_version = ${step.version}`);
      db.exec("COMMIT");
    } catch (err) {
      if (db.isTransaction) db.exec("ROLLBACK");
      throw err;
    }
  }
}
