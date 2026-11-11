// Each model's measured speed: completion tokens over decode time, summed over
// its finished replies of the last 14 days. No estimates and no wall-clock
// fallback; a model under the token floor or with only old replies has none.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { migrate, MIGRATIONS } from "./migrations.ts";
import { openThreadStore, SPEED_MIN_TOKENS, SPEED_SQL, SPEED_WINDOW_MS, type ThreadStore } from "./store.ts";
import type { MessageStats } from "./types.ts";

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;

let dir: string;
const open: ThreadStore[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gates-speed-"));
});

afterEach(() => {
  for (const s of open.splice(0)) s.close();
  rmSync(dir, { recursive: true, force: true });
});

function store(path = join(dir, "threads.db")): ThreadStore {
  const s = openThreadStore(path, { now: () => NOW });
  open.push(s);
  return s;
}

function reply(s: ThreadStore, threadId: string, model: string, stats: MessageStats, createdAt = NOW - DAY, extra: { tools?: [] | { callId: string; name: string; state: "done"; summary: string }[] } = {}) {
  return s.appendMessage({ threadId, role: "assistant", content: "answer", model, createdAt, stats, ...extra });
}

describe("modelSpeeds", () => {
  it("keeps a 14-day window with its edge included and the floor at 50 tokens", () => {
    expect(SPEED_WINDOW_MS).toBe(14 * DAY);
    expect(SPEED_MIN_TOKENS).toBe(50);
    const s = store();
    const t = s.createThread();
    reply(s, t.id, "edge:7b", { completionTokens: 100, evalDurationMs: 1000 }, NOW - SPEED_WINDOW_MS);
    reply(s, t.id, "edge:7b", { completionTokens: 900, evalDurationMs: 1000 }, NOW - SPEED_WINDOW_MS - 1);
    expect(s.modelSpeeds()).toEqual([{ model: "edge:7b", tokensPerSecond: 100, replies: 1 }]);
  });

  it("sums tokens over decode time, so a three-word reply does not swing it", () => {
    const s = store();
    const t = s.createThread();
    reply(s, t.id, "qwen3.5:9b", { completionTokens: 1000, evalDurationMs: 10_000 });
    reply(s, t.id, "qwen3.5:9b", { completionTokens: 3, evalDurationMs: 10 }); // 300 tok/s alone
    const [speed] = s.modelSpeeds();
    // A mean of per-reply rates would say 200.
    expect(speed?.tokensPerSecond).toBeCloseTo(1003 / 10.01, 6);
    expect(speed?.replies).toBe(2);
  });

  it("ignores replies with no decode time and never falls back to wall-clock duration", () => {
    const s = store();
    const t = s.createThread();
    reply(s, t.id, "old:7b", { completionTokens: 500, durationMs: 5000 });
    reply(s, t.id, "zero:7b", { completionTokens: 500, evalDurationMs: 0, durationMs: 5000 });
    reply(s, t.id, "mixed:7b", { completionTokens: 400, durationMs: 1000 });
    reply(s, t.id, "mixed:7b", { completionTokens: 100, evalDurationMs: 2000, durationMs: 9000 });
    expect(s.modelSpeeds()).toEqual([{ model: "mixed:7b", tokensPerSecond: 50, replies: 1 }]);
  });

  it("shows nothing under the floor of completion tokens in the window", () => {
    const s = store();
    const t = s.createThread();
    reply(s, t.id, "short:1b", { completionTokens: 20, evalDurationMs: 100 });
    reply(s, t.id, "short:1b", { completionTokens: 29, evalDurationMs: 100 });
    expect(s.modelSpeeds()).toEqual([]);
    reply(s, t.id, "short:1b", { completionTokens: 1, evalDurationMs: 10 });
    expect(s.modelSpeeds()).toEqual([{ model: "short:1b", tokensPerSecond: 50 / 0.21, replies: 3 }]);
  });

  it("keeps two models apart, and a model with only old replies shows nothing", () => {
    const s = store();
    const t = s.createThread();
    reply(s, t.id, "big:14b", { completionTokens: 300, evalDurationMs: 10_000 });
    reply(s, t.id, "small:4b", { completionTokens: 600, evalDurationMs: 5_000 });
    reply(s, t.id, "gone:7b", { completionTokens: 5000, evalDurationMs: 1000 }, NOW - 30 * DAY);
    expect(s.modelSpeeds()).toEqual([
      { model: "big:14b", tokensPerSecond: 30, replies: 1 },
      { model: "small:4b", tokensPerSecond: 120, replies: 1 },
    ]);
  });

  it("counts a tool-step reply by the decode time it stores", () => {
    const s = store();
    const t = s.createThread();
    reply(s, t.id, "tools:8b", { completionTokens: 80, evalDurationMs: 1000, durationMs: 9000 }, NOW - DAY, { tools: [{ callId: "c1", name: "sql", state: "done", summary: "3 rows" }] });
    expect(s.modelSpeeds()).toEqual([{ model: "tools:8b", tokensPerSecond: 80, replies: 1 }]);
  });

  it("counts only finished assistant replies: no user rows, no unfinished drafts", () => {
    const s = store();
    const t = s.createThread();
    s.appendMessage({ threadId: t.id, role: "user", content: "q", model: "m:1b", createdAt: NOW - DAY, stats: { completionTokens: 900, evalDurationMs: 1 } });
    s.appendMessage({ threadId: t.id, role: "assistant", content: "half", model: "m:1b", createdAt: NOW - DAY, interrupted: true, stats: { numCtx: 4096 } });
    expect(s.modelSpeeds()).toEqual([]);
  });

  it("treats name and name:latest as one model, named without the tag", () => {
    const s = store();
    const t = s.createThread();
    reply(s, t.id, "llama3", { completionTokens: 100, evalDurationMs: 1000 });
    reply(s, t.id, "llama3:latest", { completionTokens: 300, evalDurationMs: 1000 });
    expect(s.modelSpeeds()).toEqual([{ model: "llama3", tokensPerSecond: 200, replies: 2 }]);
  });

  it("drops a deleted thread's replies with the thread", () => {
    const s = store();
    const keep = s.createThread();
    const drop = s.createThread();
    reply(s, keep.id, "m:7b", { completionTokens: 100, evalDurationMs: 1000 });
    reply(s, drop.id, "m:7b", { completionTokens: 900, evalDurationMs: 1000 });
    s.deleteThread(drop.id);
    expect(s.modelSpeeds()).toEqual([{ model: "m:7b", tokensPerSecond: 100, replies: 1 }]);
  });

  it("opens a store from before decode time was kept and simply has no numbers", () => {
    const path = join(dir, "v2.db");
    const db = new DatabaseSync(path);
    migrate(db, path, MIGRATIONS.slice(0, 2));
    db.exec(`INSERT INTO threads VALUES ('t1', 'old', 1, 1);
             INSERT INTO messages (id, thread_id, role, content, model, created_at, completion_tokens, duration_ms)
             VALUES ('m1', 't1', 'assistant', 'old answer', 'old:7b', ${NOW - DAY}, 500, 2000);`);
    db.close();
    const s = store(path);
    expect(s.getThread("t1").messages).toHaveLength(1);
    expect(s.modelSpeeds()).toEqual([]);
  });

  it("reads through its own partial index, not a scan of the messages table", () => {
    const path = join(dir, "plan.db");
    store(path);
    const db = new DatabaseSync(path);
    try {
      const plan = db.prepare(`EXPLAIN QUERY PLAN ${SPEED_SQL}`).all(NOW - SPEED_WINDOW_MS).map((row) => String(row["detail"]));
      expect(plan.join("\n")).toMatch(/USING COVERING INDEX messages_speed/);
      expect(plan.join("\n")).not.toMatch(/SCAN messages\b(?! USING)/);
    } finally { db.close(); }
  });
});
