// Versioned schema steps, tracked in PRAGMA user_version. Step N moves the
// database from version N-1 to N. Never edit a shipped step; append a new one.

import type { DatabaseSync } from "node:sqlite";

import { StoreVersionTooNewError } from "./errors.ts";

export interface Migration {
  version: number;
  up: (db: DatabaseSync) => void;
}

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
    // Tool steps and generated image paths ride on the message as JSON
    // arrays (contracts v2, 2026-11-07). NULL means none.
    version: 2,
    up: (db) => {
      db.exec(`
        ALTER TABLE messages ADD COLUMN tools_json TEXT;
        ALTER TABLE messages ADD COLUMN images_json TEXT;
      `);
    },
  },
  {
    // Decode and prompt times from Ollama's eval_duration and
    // prompt_eval_duration (2026-11-07), so speed is tokens over decode time
    // and not over the wall time that includes the model load. NULL on older rows.
    version: 3,
    up: (db) => {
      db.exec(`
        ALTER TABLE messages ADD COLUMN eval_duration_ms REAL;
        ALTER TABLE messages ADD COLUMN prompt_eval_duration_ms REAL;
      `);
    },
  },
];

export const LATEST_VERSION: number = MIGRATIONS.length;

function readUserVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get();
  const v = row?.["user_version"];
  return typeof v === "number" ? v : Number(v ?? 0);
}

/**
 * Brings the database up to LATEST_VERSION. Each step runs in its own
 * IMMEDIATE transaction together with its user_version bump, so a kill
 * between steps leaves a database at a clean, known version. The version is
 * re-read inside the write lock, so two processes opening at once do not run
 * a step twice.
 */
export function migrate(db: DatabaseSync, dbPath: string, migrations: readonly Migration[] = MIGRATIONS): number {
  const latest = migrations.length;
  migrations.forEach((m, i) => {
    if (m.version !== i + 1) throw new Error(`migration list out of order at index ${i}: version ${m.version}`);
  });

  const initial = readUserVersion(db);
  if (initial > latest) throw new StoreVersionTooNewError(dbPath, initial, latest);

  for (;;) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const current = readUserVersion(db);
      if (current > latest) throw new StoreVersionTooNewError(dbPath, current, latest);
      if (current === latest) {
        db.exec("COMMIT");
        return current;
      }
      const step = migrations[current];
      if (!step) throw new Error(`no migration for version ${current + 1}`);
      step.up(db);
      // PRAGMA takes no bound parameters; the value is an integer we own.
      db.exec(`PRAGMA user_version = ${step.version}`);
      db.exec("COMMIT");
    } catch (err) {
      if (db.isTransaction) db.exec("ROLLBACK");
      throw err;
    }
  }
}
