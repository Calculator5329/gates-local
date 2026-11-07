// Threads the stack writes into a fresh data dir before the server starts,
// through the server's own store with its clock pinned, so relative times in
// the sidebar never move between runs.
//   seedLong   one thread of N alternating messages (the perf spec)
//   seedDesign the design's sidebar and its "Library: Effect Schema books"
//              thread (the screenshot rig)
import { openThreadStore } from "../../apps/server/src/threads/store.ts";
import type { NewMessage } from "../../apps/server/src/threads/types.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;

const LONG_REPLY = [
  "Here is the short version.",
  "",
  "- **cron** reads its own `PATH`, not your shell's",
  "- set it at the top of the crontab, or use full paths",
  "",
  "```sh",
  "PATH=/usr/local/bin:/usr/bin:/bin",
  "```",
  "",
  "That covers most cases where a job runs by hand but not on schedule.",
].join("\n");

/** Opens the store with a clock the caller moves; returns both and a closer. */
function pinned(dbPath: string) {
  const clock = { now: 0 };
  const store = openThreadStore(dbPath, { now: () => clock.now });
  return { clock, store };
}

export function seedLong(dbPath: string, messages: number, endAt: number, title: string): string {
  const { clock, store } = pinned(dbPath);
  try {
    clock.now = endAt - messages * MIN;
    const t = store.createThread({ title });
    for (let i = 0; i < messages; i++) {
      const user = i % 2 === 0;
      clock.now += MIN;
      store.appendMessage({
        threadId: t.id,
        role: user ? "user" : "assistant",
        content: user ? `Question ${i / 2 + 1}: why does my cron job not find node?` : LONG_REPLY,
        createdAt: clock.now,
        ...(user ? {} : { model: "qwen3.5:9b", thinking: "Short question, plain answer.", stats: { promptTokens: 400 + i, completionTokens: 120, durationMs: 1500 } }),
      });
    }
    return t.id;
  } finally {
    store.close();
  }
}

type Turn = Omit<NewMessage, "threadId" | "createdAt"> & { readonly at: number };

const BOOKS_REPLY = [
  "Three books in `library.db` match:",
  "",
  "1. **Effect: Schema, Services and Layers** (2026)",
  "2. **Effect Schema in Practice** (2025)",
  "3. **Typed Boundaries with Effect** (2024)",
  "",
  "All three cover Effect Schema. *Typed Boundaries* treats it as one chapter; the other two are about it start to finish.",
].join("\n");

const START_REPLY =
  "Start with **Effect Schema in Practice** (2025). It assumes the least Effect background and its examples use the current `Schema` API. The 2026 book builds on it and goes further into services and layers.";

/** The design's sidebar (S-01): titles and ages relative to `now`; returns the open thread's id. */
export function seedDesign(dbPath: string, now: number): string {
  const { clock, store } = pinned(dbPath);
  const day = new Date(now);
  const at = (daysAgo: number, h: number, m: number) => new Date(day.getFullYear(), day.getMonth(), day.getDate() - daysAgo, h, m).getTime();
  const older: [string, number][] = [
    ["Draft the drive-sync README", new Date(day.getFullYear(), 9, 21, 11, 0).getTime()],
    ["Whisper latency check", at(5, 10, 30)],
    ["Ollama 0.40 release notes", at(3, 9, 15)],
    ["Benchmark: qwen vs gemma at 32k", at(1, 16, 12)],
    ["Forge icon, take 3", now - 5 * HOUR],
    ["Fix the backup cron", now - 3 * HOUR],
  ];
  const model = "qwen3.5:9b";
  const turns: Turn[] = [
    { role: "user", content: "Which Effect Schema books are in the library?", at: now - 4 * MIN },
    {
      role: "assistant",
      content: BOOKS_REPLY,
      thinking: "The library is a SQLite file. Search titles for Effect Schema, read-only.",
      model,
      stats: { promptTokens: 1840, completionTokens: 96, durationMs: 4200 },
      tools: [{ callId: "c1", name: "shell", state: "done", summary: "Searched your library", detail: "sqlite3 -readonly library.db \"select title, year from books where title like '%Effect%'\"", durationMs: 42 }],
      at: now - 4 * MIN + 6000,
    },
    { role: "user", content: "Which one should I start with?", at: now - 2 * MIN - 3000 },
    { role: "assistant", content: START_REPLY, thinking: "Pick the most introductory one.", model, stats: { promptTokens: 2010, completionTokens: 58, durationMs: 1900 }, at: now - 2 * MIN },
  ];
  try {
    for (const [title, t] of older) {
      clock.now = t;
      const th = store.createThread({ title });
      store.appendMessage({ threadId: th.id, role: "user", content: title, createdAt: t });
    }
    clock.now = turns[0]?.at ?? now;
    const main = store.createThread({ title: "Library: Effect Schema books" });
    for (const { at: when, ...m } of turns) {
      clock.now = when;
      store.appendMessage({ ...m, threadId: main.id, createdAt: when });
    }
    return main.id;
  } finally {
    store.close();
  }
}
