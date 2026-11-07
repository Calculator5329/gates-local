// Roadmap accept test: kill the writer mid-stream; after reopening, the
// thread has every completed message and no partial one.

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openThreadStore } from "./store.ts";

const FIXTURE = fileURLToPath(new URL("./test-fixtures/crash-writer.ts", import.meta.url));

interface Ready {
  ready: true;
  threadId: string;
  completed: string[];
  partial: { content: string; thinking: string };
}

let dir: string;
let child: ChildProcess | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gates-threads-crash-"));
});

afterEach(() => {
  if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  child = undefined;
  rmSync(dir, { recursive: true, force: true });
});

function waitForReady(proc: ChildProcess): Promise<Ready> {
  return new Promise((resolve, reject) => {
    let stderr = "";
    proc.stderr?.on("data", (b: Buffer) => (stderr += b.toString()));
    const lines = createInterface({ input: proc.stdout! });
    lines.once("line", (line) => {
      try {
        resolve(JSON.parse(line) as Ready);
      } catch (err) {
        reject(new Error(`bad ready line ${JSON.stringify(line)}: ${String(err)}`));
      }
    });
    proc.once("exit", (code, signal) => reject(new Error(`child exited early (${code ?? signal}): ${stderr}`)));
    proc.once("error", reject);
  });
}

function waitForExit(proc: ChildProcess): Promise<NodeJS.Signals | null> {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve(proc.signalCode);
  return new Promise((resolve) => proc.once("exit", (_code, signal) => resolve(signal)));
}

describe("thread store survives a SIGKILL mid-stream", () => {
  it("keeps every completed message and no partial one", async () => {
    const dbPath = join(dir, "data", "threads.db");
    const marker = `PARTIAL${randomUUID().replaceAll("-", "")}`;

    child = spawn(process.execPath, ["--no-warnings", FIXTURE, dbPath, marker], { stdio: ["ignore", "pipe", "pipe"] });
    const ready = await waitForReady(child);
    expect(ready.completed).toHaveLength(3);
    expect(ready.partial.content).toContain(marker);
    expect(ready.partial.thinking).toContain(marker);

    // Cross-process concurrent read: the child still holds its connection
    // and keeps streaming while this second connection reads.
    const reader = openThreadStore(dbPath);
    const live = reader.getThread(ready.threadId);
    expect(live.messages.map((m) => m.id)).toEqual(ready.completed);
    reader.close();

    // Let the child buffer more deltas so the kill lands mid-stream.
    await new Promise((r) => setTimeout(r, 50));
    expect(child.exitCode).toBeNull();
    child.kill("SIGKILL");
    expect(await waitForExit(child)).toBe("SIGKILL");

    // The killed writer never checkpointed: committed rows sit in the WAL,
    // so reopening below exercises WAL recovery, not a clean main file.
    const walPath = `${dbPath}-wal`;
    expect(existsSync(walPath)).toBe(true);
    expect(statSync(walPath).size).toBeGreaterThan(0);

    // Nothing partial reached disk at all: the marker is in no byte of the
    // database or its WAL.
    for (const file of [dbPath, walPath]) {
      expect(readFileSync(file).includes(marker)).toBe(false);
    }

    const store = openThreadStore(dbPath);
    const { thread, messages } = store.getThread(ready.threadId);
    expect(thread.title).toBe("crash test");
    expect(messages.map((m) => m.id)).toEqual(ready.completed);
    expect(messages.map((m) => [m.role, m.content])).toEqual([
      ["user", "first question"],
      ["assistant", "first answer"],
      ["user", "second question"],
    ]);
    expect(messages[1]?.model).toBe("fake:1b");
    expect(messages[1]?.stats?.completionTokens).toBe(2);
    for (const m of messages) {
      expect(m.content).not.toContain(marker);
      expect(m.thinking ?? "").not.toContain(marker);
    }

    // The recovered store still takes writes.
    store.appendMessage({ threadId: ready.threadId, role: "user", content: "after restart" });
    expect(store.getThread(ready.threadId).messages).toHaveLength(4);
    store.close();

    const raw = new DatabaseSync(dbPath, { readOnly: true });
    expect(raw.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    expect(raw.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(raw.prepare("SELECT count(*) AS n FROM messages").get()).toEqual({ n: 4 });
    raw.close();
  });
});
