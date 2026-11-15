// A thread store that cannot save its copy before an upgrade stops the server,
// and the desktop's startup error page shows the server's sentence.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, expect, it } from "vitest";

import { renderStatusPage } from "../apps/desktop/src/status-page.ts";
import { migrate, MIGRATIONS } from "../apps/server/src/threads/migrations.ts";

let dir: string;
const connections: DatabaseSync[] = [];
beforeEach(() => {
  const cache = join(homedir(), ".cache");
  fs.mkdirSync(cache, { recursive: true });
  dir = fs.mkdtempSync(join(cache, "store-copy-test-"));
});
afterEach(() => {
  for (const db of connections.splice(0)) db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function connect(path: string, readOnly = false): DatabaseSync {
  const db = new DatabaseSync(path, { readOnly, timeout: 5_000 });
  connections.push(db);
  return db;
}
function version(db: DatabaseSync): unknown {
  return db.prepare("PRAGMA user_version").get()?.["user_version"];
}
function fixture(v: number): { db: DatabaseSync; path: string } {
  const path = join(dir, "threads.sqlite");
  const db = connect(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0");
  migrate(db, path, MIGRATIONS.slice(0, v));
  db.exec("INSERT INTO threads VALUES ('t', 'Before upgrade', 1, 1); INSERT INTO messages (id, thread_id, role, content, created_at) VALUES ('checkpointed', 't', 'user', 'On disk', 1); PRAGMA wal_checkpoint(TRUNCATE)");
  db.exec("INSERT INTO threads VALUES ('wal-thread', 'Only in WAL', 2, 2); INSERT INTO messages (id, thread_id, role, content, created_at) VALUES ('wal-message', 'wal-thread', 'assistant', 'Only in WAL', 2)");
  return { db, path };
}
function files(): string[] {
  const folder = join(dir, "store-copies");
  return fs.existsSync(folder) ? fs.readdirSync(folder).toSorted() : [];
}

it("SQLite disk-full errors reach the existing startup error page with recovery instructions", () => {
  const { path } = fixture(3);
  const main = new URL("../apps/server/src/main.ts", import.meta.url).href;
  const source = `
    import { DatabaseSync } from 'node:sqlite';
    import { randomUUID } from 'node:crypto';
    const exec = DatabaseSync.prototype.exec;
    DatabaseSync.prototype.exec = function(sql) {
      if (sql.startsWith('VACUUM INTO')) throw Object.assign(new Error('database or disk is full'), { code: 'ERR_SQLITE_ERROR', errcode: 13 });
      if (sql.startsWith('BEGIN')) throw new Error('migration reached a step without a saved copy');
      return exec.call(this, sql);
    };
    process.argv = [process.execPath, '--port', '0', '--data-dir', ${JSON.stringify(dir)}];
    process.env.GATES_LOCAL_SERVER_TOKEN = randomUUID();
    const { main } = await import(${JSON.stringify(main)});
    await main();
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", source], {
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GATES_LOCAL_"))), GATES_LOCAL_RUNTIME: "discover-only", GATES_LOCAL_OLLAMA_BINARY: "none" },
    encoding: "utf8", timeout: 10_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(1);
  const message = "Gates Local could not save a copy of your chats before upgrading them, because the disk is full. Free some space and start it again. Nothing was changed.";
  expect(result.stderr).toContain(message);
  // The raw cause is in the server's output, on its own line before the sentence.
  const lines = result.stderr.trim().split("\n");
  const cause = lines.findIndex(line => line === "[server] thread store: database or disk is full");
  expect(cause, result.stderr).toBeGreaterThanOrEqual(0);
  expect(lines.findIndex(line => line.includes(message))).toBeGreaterThan(cause);
  expect(renderStatusPage({ kind: "server", state: {
    status: "crashed", launch: 1, reason: { kind: "exit", code: 1, signal: null },
    stderrTail: result.stderr.trim().split("\n"), restartBlockedUntil: null,
  } })).toContain(message);
  expect(version(connect(path))).toBe(3);
  expect(files()).toEqual([]);
});
