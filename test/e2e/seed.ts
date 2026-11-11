// Threads the stack writes into a fresh data dir before the server starts,
// through the server's own store with its clock pinned, so relative times in
// the sidebar never move between runs.
//   seedLong   one thread of N alternating messages (the perf spec)
//   seedDesign the design's sidebar and its "Library: Effect Schema books"
//              thread (the screenshot rig)
//   seedReadme neutral demo threads for the README screenshots
//              (test/e2e/readme-shots.spec.ts)
//   seedUsage  seven days of three models' usage (test/e2e/usage.spec.ts)
import { openThreadStore } from "../../apps/server/src/threads/store.ts";
import type { NewMessage } from "../../apps/server/src/threads/types.ts";
import { openUsageStore } from "../../apps/server/src/usage/store.ts";

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

/** Content that must scroll in its own box or wrap on a phone (the mobile shots' long code block). */
const CODE_REPLY = [
  "Run this from the library folder. Every flag is spelled out so cron can run it unchanged:",
  "",
  "```sh",
  'sqlite3 -readonly -header -column library.db "select title, year, isbn, publisher from books where title like \'%Effect%\' order by year desc, title asc limit 20;"',
  "PATH=/usr/local/bin:/usr/bin:/bin node /srv/library/scripts/export-effect-books.mjs --format=markdown --out=/srv/library/notes/effect-books.md",
  "```",
  "",
  "| Title | Year | Publisher | Pages |",
  "| --- | --- | --- | --- |",
  "| Effect: Schema, Services and Layers | 2026 | Northwind Technical Press | 412 |",
  "| Effect Schema in Practice | 2025 | Independent | 288 |",
  "",
  "The schema docs are at https://effect.website/docs/schema/introduction/getting-started-with-effect-schema-and-the-current-api.",
].join("\n");

/** The design's sidebar (S-01): titles and ages relative to `now`; returns the open thread's id. With `code`, one more turn ends the thread (CODE_REPLY). */
export function seedDesign(dbPath: string, now: number, code = false): string {
  const at = dayClock(now);
  const older: [string, number][] = [
    ["Draft the drive-sync README", zoned(wallClock(now).y, 9, 21, 11, 0)],
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
  if (code) {
    turns.push(
      { role: "user", content: "Give me a command that exports them.", at: now - MIN },
      { role: "assistant", content: CODE_REPLY, model, stats: { promptTokens: 2120, completionTokens: 180, durationMs: 3100 }, at: now - MIN + 4000 },
    );
  }
  return writeThreads(dbPath, now, older, "Library: Effect Schema books", turns);
}

/**
 * The zone the seeded wall-clock times are in: the browser timezoneId of
 * shots.spec.ts and readme-shots.spec.ts. Never the seeding process's own
 * zone, so a host in any zone writes the same timestamps (seed.test.ts).
 */
const SEED_ZONE = "America/Chicago";
const zoneParts = new Intl.DateTimeFormat("en-US", {
  timeZone: SEED_ZONE, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric",
});

/** SEED_ZONE's wall clock at instant `t`, as UTC fields: year, month (0-11), day, hour, minute, second. */
function wallClock(t: number) {
  const p = Object.fromEntries(zoneParts.formatToParts(t).map((x) => [x.type, Number(x.value)]));
  return { y: p["year"]!, mo: p["month"]! - 1, d: p["day"]!, h: p["hour"]!, mi: p["minute"]!, s: p["second"]! };
}

/** How far SEED_ZONE's wall clock is ahead of UTC at instant `t`, in ms. */
function offsetAt(t: number): number {
  const w = wallClock(t);
  return Date.UTC(w.y, w.mo, w.d, w.h, w.mi, w.s) - t;
}

/** The instant SEED_ZONE shows as y-mo-d h:mi; days past the month's end roll over as in Date.UTC. */
function zoned(y: number, mo: number, d: number, h: number, mi: number): number {
  const asUtc = Date.UTC(y, mo, d, h, mi);
  // The offset at the guess can differ across a DST change; one more pass settles it.
  const first = asUtc - offsetAt(asUtc);
  return asUtc - offsetAt(first);
}

/** Midnight-relative times for a sidebar: `daysAgo` days before `now`'s day at h:m, in SEED_ZONE. */
function dayClock(now: number) {
  const day = wallClock(now);
  return (daysAgo: number, h: number, m: number) => zoned(day.y, day.mo, day.d - daysAgo, h, m);
}

/** One-message threads for the sidebar, then the open thread with its turns; returns the open thread's id. */
function writeThreads(dbPath: string, now: number, older: readonly (readonly [string, number])[], title: string, turns: readonly Turn[]): string {
  const { clock, store } = pinned(dbPath);
  try {
    for (const [name, t] of older) {
      clock.now = t;
      const th = store.createThread({ title: name });
      store.appendMessage({ threadId: th.id, role: "user", content: name, createdAt: t });
    }
    clock.now = turns[0]?.at ?? now;
    const main = store.createThread({ title });
    for (const { at: when, ...m } of turns) {
      clock.now = when;
      store.appendMessage({ ...m, threadId: main.id, createdAt: when });
    }
    return main.id;
  } finally {
    store.close();
  }
}

const DEBOUNCE_REPLY = [
  "A debounce waits until typing pauses before it searches. Each keystroke restarts a short timer:",
  "",
  "```ts",
  "function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number) {",
  "  let timer: ReturnType<typeof setTimeout> | undefined;",
  "  return (...args: A) => {",
  "    clearTimeout(timer);",
  "    timer = setTimeout(() => fn(...args), ms);",
  "  };",
  "}",
  "",
  "const search = debounce(loadResults, 300);",
  "```",
].join("\n");

const CLEAR_REPLY = "Each call cancels the previous keystroke's timer, so only the last one runs the search.";

/** Neutral demo threads for the README shots: ordinary titles, a code answer open. Returns the open thread's id. */
export function seedReadme(dbPath: string, now: number): string {
  const at = dayClock(now);
  const older: [string, number][] = [
    ["Summarize the CAP theorem", zoned(wallClock(now).y, 9, 21, 11, 0)],
    ["Regex for ISO 8601 dates", at(5, 10, 30)],
    ["Explain HTTP caching headers", at(3, 9, 15)],
    ["What is a B-tree?", at(1, 16, 12)],
    ["Weekly meal plan with leftovers", now - 5 * HOUR],
    ["Convert a CSV to JSON in Python", now - 3 * HOUR],
  ];
  const model = "qwen3.5:9b";
  const turns: Turn[] = [
    { role: "user", content: "How do I debounce a search box in TypeScript?", at: now - 4 * MIN },
    {
      role: "assistant",
      content: DEBOUNCE_REPLY,
      thinking: "A small generic helper and one usage line.",
      model,
      stats: { promptTokens: 620, completionTokens: 142, durationMs: 3100 },
      at: now - 4 * MIN + 6000,
    },
    { role: "user", content: "Why clear the timer before setting a new one?", at: now - 2 * MIN - 3000 },
    { role: "assistant", content: CLEAR_REPLY, model, stats: { promptTokens: 790, completionTokens: 18, durationMs: 600 }, at: now - 2 * MIN },
  ];
  return writeThreads(dbPath, now, older, "Debounce a search box", turns);
}

const DAY = 24 * HOUR;

/** Three models over the last seven days, as the usage store records them: [model, days ago used, decode tok/s, prompt size]. */
const USAGE_MODELS: readonly (readonly [string, readonly number[], number, number])[] = [
  ["qwen3.5:9b", [0, 1, 2, 3, 4, 5, 6], 52, 1800],
  ["gemma4:12b", [1, 2, 4, 5], 34, 1200],
  ["qwen3-vl:8b", [0, 2, 3], 41, 900],
];

/**
 * The design's sidebar and, for the Usage pop-up (test/e2e/usage.spec.ts),
 * three models across seven days, three replies a day each, with decode and
 * prompt-reading times, through the server's own usage store with its clock
 * pinned. A model's missing days are gaps in its speed line. Days are UTC
 * calendar days, so a spec reading them sets timezoneId "UTC"; today's
 * replies fall in the part of today already gone. The server's one-time fill
 * from stored replies adds the threads' own replies on start.
 * Returns the open thread's id.
 */
export function seedUsage(dbPath: string, file: string, now: number): string {
  const id = seedDesign(dbPath, now);
  const clock = { now: 0 };
  const store = openUsageStore(file, { now: () => clock.now });
  const today = now - (now % DAY);
  try {
    for (const [model, days, rate, size] of USAGE_MODELS) {
      for (const d of days) {
        const span = d === 0 ? now - today : DAY;
        for (const i of [0, 1, 2]) {
          clock.now = today - d * DAY + Math.floor((span * (i + 1)) / 4);
          const promptTokens = size * (1 + ((d * 7 + i * 3) % 5));
          const completionTokens = Math.round(promptTokens * (0.25 + (d % 3) * 0.1));
          const evalDurationMs = Math.round((completionTokens / (rate * (1 - (d % 4) * 0.06))) * 1000);
          const promptEvalDurationMs = Math.round((promptTokens / (rate * 18)) * 1000);
          store.record(model, { promptTokens, completionTokens, evalDurationMs, promptEvalDurationMs, durationMs: evalDurationMs + promptEvalDurationMs + 300 }, true);
        }
      }
    }
  } finally {
    store.close();
  }
  return id;
}
