// The pictures table: an index of the finished image cards, for the Pictures screen. The card message is
// the picture's only record; a row here only finds it. Each row references its card with ON DELETE
// CASCADE, so every path that deletes a card (a message, a thread, a batch, or an older build's own SQL)
// deletes the row in the same write. No schema version: an older build opens the file and ignores the table.
import type { DatabaseSync, SQLOutputValue, StatementSync } from "node:sqlite";
import { WireError, type Picture, type PictureList, type PictureListParams } from "@gates-local/contracts";

/** What the image module knows at done that the card does not keep. */
export interface PictureFacts {
  seed?: number;
  steps?: number;
  /** ComfyUI's time making it. */
  runMs?: number;
  /** The file's size in pixels and bytes. */
  width: number;
  height: number;
  bytes: number;
}

/** A finished card with no row yet: a picture from before the index, or one an older build finished. */
export interface Unindexed {
  jobId: string;
  imagePath: string;
}

export interface PictureIndex {
  list(params: PictureListParams): PictureList;
  unindexed(): Unindexed[];
  /** Index a card from its file. Leaves a row already there as it is; does nothing when the card is gone. */
  fill(jobId: string, facts: PictureFacts & { doneAt: number }): void;
}

export function ensurePicturesTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pictures (
      job_id     TEXT PRIMARY KEY NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
      thread_id  TEXT NOT NULL,
      prompt     TEXT NOT NULL,
      preset     TEXT,
      width      INTEGER NOT NULL,
      height     INTEGER NOT NULL,
      seed       INTEGER,
      steps      INTEGER,
      queued_at  INTEGER NOT NULL,
      done_at    INTEGER NOT NULL,
      run_ms     INTEGER,
      bytes      INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS pictures_by_done ON pictures (done_at DESC);
  `);
}

const COLUMNS = "job_id, thread_id, prompt, preset, width, height, seed, steps, queued_at, done_at, run_ms, bytes";
// The prompt, setup and sent time come from the card itself, so the row cannot disagree with it.
const FROM_CARD = `SELECT id, thread_id, content, json_extract(image_job_json, '$.choice.preset'), ?, ?, ?, ?, created_at, ?, ?, ?
  FROM messages WHERE id = ? AND json_extract(image_job_json, '$.state') = 'done'`;
const CURSOR = /^(\d{1,16})\.(\d{1,16})$/;

const optional = (value: SQLOutputValue | undefined) => (typeof value === "number" ? value : undefined);

function pictureFromRow(row: Record<string, SQLOutputValue>): Picture {
  const seed = optional(row["seed"]), steps = optional(row["steps"]), runMs = optional(row["run_ms"]);
  const preset = row["preset"];
  return {
    jobId: String(row["job_id"]),
    threadId: String(row["thread_id"]),
    threadTitle: String(row["title"]),
    prompt: String(row["prompt"]),
    ...typeof preset === "string" ? { preset } : {},
    width: Number(row["width"]),
    height: Number(row["height"]),
    ...seed === undefined ? {} : { seed },
    ...steps === undefined ? {} : { steps },
    queuedAt: Number(row["queued_at"]),
    doneAt: Number(row["done_at"]),
    ...runMs === undefined ? {} : { runMs },
    bytes: Number(row["bytes"]),
    imagePath: `images/${String(row["job_id"])}.png`,
  };
}

const clause = (parts: string[]) => (parts.length === 0 ? "" : `WHERE ${parts.join(" AND ")}`);
const values = (facts: PictureFacts, doneAt: number, jobId: string) =>
  [facts.width, facts.height, facts.seed ?? null, facts.steps ?? null, doneAt, facts.runMs === undefined ? null : Math.round(facts.runMs), facts.bytes, jobId] as const;

/** `%` and `_` in the words are plain characters. */
const likeWords = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

export function createPictureIndex(db: DatabaseSync): PictureIndex & {
  /** At done, inside the card's own write: the row with what the job knew. */
  record(jobId: string, facts: PictureFacts, doneAt: number): void;
} {
  const record = db.prepare(`INSERT OR REPLACE INTO pictures (${COLUMNS}) ${FROM_CARD}`);
  const fill = db.prepare(`INSERT OR IGNORE INTO pictures (${COLUMNS}) ${FROM_CARD}`);
  const unindexed = db.prepare(`SELECT m.id, m.images_json FROM messages m
    WHERE m.image_job_json IS NOT NULL AND json_extract(m.image_job_json, '$.state') = 'done'
      AND NOT EXISTS (SELECT 1 FROM pictures p WHERE p.job_id = m.id)`);
  // One statement per filter shape, so each page is an index range and not a scan from the top.
  const lists = new Map<string, { page: StatementSync; count: StatementSync }>();
  const statements = (after: boolean, q: boolean, setup: boolean) => {
    const key = `${after}${q}${setup}`;
    let found = lists.get(key);
    if (!found) {
      const where = [q ? "p.prompt LIKE :q ESCAPE '\\'" : "", setup ? "p.preset = :setup" : ""].filter(Boolean);
      const page = [...where, after ? "(p.done_at, p.rowid) < (:doneAt, :rowid)" : ""].filter(Boolean);
      found = {
        page: db.prepare(`SELECT p.rowid AS rid, p.*, t.title FROM pictures p JOIN threads t ON t.id = p.thread_id
          ${clause(page)} ORDER BY p.done_at DESC, p.rowid DESC LIMIT :limit`),
        count: db.prepare(`SELECT COUNT(*) AS n FROM pictures p ${clause(where)}`),
      };
      lists.set(key, found);
    }
    return found;
  };

  return {
    record(jobId, facts, doneAt) { record.run(...values(facts, doneAt, jobId)); },
    fill(jobId, facts) { fill.run(...values(facts, facts.doneAt, jobId)); },
    unindexed() {
      return unindexed.all().flatMap((row) => {
        let images: unknown;
        try { images = JSON.parse(String(row["images_json"])); } catch { return []; }
        const imagePath = Array.isArray(images) && typeof images[0] === "string" ? images[0] : undefined;
        return imagePath === undefined ? [] : [{ jobId: String(row["id"]), imagePath }];
      });
    },
    list({ before, q, setup, limit }) {
      let cursor: { doneAt: number; rowid: number } | undefined;
      if (before !== undefined) {
        const match = CURSOR.exec(before);
        if (!match) throw new WireError("bad-params", "That page of pictures is not one this list gave.");
        cursor = { doneAt: Number(match[1]), rowid: Number(match[2]) };
      }
      const words = q?.trim() ? likeWords(q.trim()) : undefined;
      const { page, count } = statements(cursor !== undefined, words !== undefined, setup !== undefined);
      const filter = { ...words === undefined ? {} : { q: words }, ...setup === undefined ? {} : { setup } };
      // One more than asked says whether there is a next page.
      const rows = page.all({ ...filter, ...cursor, limit: limit + 1 });
      const shown = rows.slice(0, limit);
      const last = shown.at(-1);
      return {
        pictures: shown.map(pictureFromRow),
        count: Number(count.get(filter)?.["n"] ?? 0),
        ...rows.length > limit && last ? { next: `${String(last["done_at"])}.${String(last["rid"])}` } : {},
      };
    },
  };
}
