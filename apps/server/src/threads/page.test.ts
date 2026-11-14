// A thread's page read from disk alone gives what slicing the whole thread gave: the same
// messages, widened back to a question, and the same count before them.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { openThreadStore, type ThreadStore } from "./store.ts";
import type { Message } from "./types.ts";

const open: ThreadStore[] = [];
afterEach(() => { for (const s of open.splice(0)) s.close(); });

function store(): ThreadStore {
  const s = openThreadStore(join(mkdtempSync(join(tmpdir(), "gates-page-")), "threads.db"));
  open.push(s);
  return s;
}

/** The page as the whole-thread read sliced it before the store could page. */
function sliced(all: readonly Message[], { before, limit, skip }: { before?: string; limit?: number; skip?: string }) {
  const shown = all.filter((m) => m.id !== skip);
  const end = before === undefined ? shown.length : shown.findIndex((m) => m.id === before);
  if (end < 0) return undefined;
  let start = limit === undefined ? 0 : Math.max(0, end - limit);
  while (start > 0 && shown[start]?.role !== "user") start--;
  return { ids: shown.slice(start, end).map((m) => m.id), earlier: start };
}

/** A small seeded generator, so a failure names its case. */
function random(seed: number) {
  let x = seed;
  return (n: number) => { x = (x * 1_103_515_245 + 12_345) % 2_147_483_648; return x % n; };
}

it("matches the whole-thread slice for every start, size and hidden reply, ties in time included", () => {
  const s = store();
  for (let seed = 1; seed <= 12; seed++) {
    const pick = random(seed);
    const t = s.createThread();
    const length = 1 + pick(40);
    // runs of replies with no question between them, and messages sharing a time
    for (let i = 0; i < length; i++) s.appendMessage({ threadId: t.id, role: pick(3) === 0 ? "user" : "assistant", content: `m${i}`, createdAt: 1_000 + Math.floor(i / (1 + pick(3))) });
    const all = s.getThread(t.id).messages;
    for (let round = 0; round < 60; round++) {
      const before = pick(4) === 0 ? undefined : all[pick(all.length)]?.id;
      const limit = pick(5) === 0 ? undefined : 1 + pick(12);
      const skip = pick(3) === 0 ? all[pick(all.length)]?.id : undefined;
      const ask = { ...(before === undefined ? {} : { before }), ...(limit === undefined ? {} : { limit }), ...(skip === undefined ? {} : { skip }) };
      const page = s.getThreadPage(t.id, ask);
      const want = sliced(all, ask);
      const got = page === undefined ? undefined : { ids: page.messages.map((m) => m.id), earlier: page.earlier };
      expect(got, `seed ${seed} round ${round} ${JSON.stringify(ask)}`).toEqual(want);
    }
  }
});

it("a page's messages are whole, as the thread read gives them", () => {
  const s = store();
  const t = s.createThread({ title: "kept" });
  s.appendMessage({ threadId: t.id, role: "user", content: "Question", createdAt: 1 });
  s.appendMessage({ threadId: t.id, role: "assistant", content: "Answer", model: "m", createdAt: 2, stats: { completionTokens: 9, evalDurationMs: 100 }, tools: [{ callId: "c", name: "run", state: "done", summary: "ran" }] });
  const page = s.getThreadPage(t.id, { limit: 10 });
  expect(page).toEqual({ ...s.getThread(t.id), earlier: 0 });
});

it("a page before a message of another thread, or the hidden one, is not found; an unknown thread throws", () => {
  const s = store();
  const a = s.createThread(), b = s.createThread();
  const inB = s.appendMessage({ threadId: b.id, role: "user", content: "b", createdAt: 1 });
  const inA = s.appendMessage({ threadId: a.id, role: "user", content: "a", createdAt: 1 });
  expect(s.getThreadPage(a.id, { before: inB.id, limit: 5 })).toBeUndefined();
  expect(s.getThreadPage(a.id, { before: inA.id, limit: 5, skip: inA.id })).toBeUndefined();
  expect(() => s.getThreadPage("nope", { limit: 5 })).toThrow();
});
