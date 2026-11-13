import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { ImageChoice } from "@gates-local/contracts";
import { openThreadStore, type ThreadStore } from "../threads/store.ts";
import { backfillPictures } from "./backfill.ts";
import { promptChunk, testPng } from "./test-png.ts";

const dirs: string[] = [];
const stores: ThreadStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const klein: ImageChoice = { preset: "flux2-klein-4b", width: 1344, height: 768 };

async function fixture(now?: () => number) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "gates-pictures-"));
  dirs.push(dataDir);
  await mkdir(path.join(dataDir, "images"));
  const store = openThreadStore(path.join(dataDir, "threads.sqlite"), now ? { now } : {});
  stores.push(store);
  /** A finished card as the image module leaves it; `facts` as it passes them at done (absent: a build from before the index). */
  const finish = async (threadId: string, jobId: string, prompt: string, options: { png?: Buffer; facts?: { seed?: number; steps?: number; runMs?: number }; mtime?: number } = {}) => {
    store.saveImageJob({ jobId, threadId, state: "queued", choice: klein }, prompt);
    const png = options.png ?? testPng(16, 9);
    const imagePath = `images/${jobId}.png`;
    await writeFile(path.join(dataDir, imagePath), png);
    if (options.mtime !== undefined) await utimes(path.join(dataDir, imagePath), options.mtime / 1000, options.mtime / 1000);
    store.saveImageJob({ jobId, threadId, state: "done", progress: 1, imagePath, choice: klein }, prompt,
      options.facts ? { ...options.facts, width: 16, height: 9, bytes: png.length } : undefined);
  };
  return { dataDir, store, finish, ids };
}
const ids = (list: { pictures: readonly { jobId: string }[] }) => list.pictures.map((p) => p.jobId);

describe("pictures index", () => {
  it("backfill indexes each finished card once, from the card and its file, and is safe to run again or after an interruption", async () => {
    const f = await fixture();
    const thread = f.store.createThread({ title: "Mandalorian Background" });
    // Three pictures from a build before the index: no rows; seed and steps only in the file's chunk.
    await f.finish(thread.id, "old-1", "a space battle", { png: testPng(20, 10, promptChunk(1111, 8)), mtime: 1_762_000_001_000 });
    await f.finish(thread.id, "old-2", "a star destroyer", { png: testPng(20, 10, promptChunk(2222, 8)), mtime: 1_762_000_002_000 });
    await f.finish(thread.id, "old-3", "no chunk here", { png: testPng(20, 10), mtime: 1_762_000_003_000 });
    // Not pictures: a failed card, and a finished card whose file is gone.
    f.store.saveImageJob({ jobId: "failed", threadId: thread.id, state: "error", message: "no" }, "a failed one");
    await f.finish(thread.id, "gone", "file deleted");
    await rm(path.join(f.dataDir, "images", "gone.png"));
    // One indexed at done by this build: the backfill leaves its row as it is.
    await f.finish(thread.id, "new-1", "a fresh one", { facts: { seed: 9, steps: 4, runMs: 3100 } });
    expect(f.store.pictures.list({ limit: 50 }).count).toBe(1);

    await backfillPictures({ store: f.store, dataDir: f.dataDir });
    const first = f.store.pictures.list({ limit: 50 });
    expect(first.count).toBe(4);
    expect(first.pictures.find((p) => p.jobId === "old-1")).toEqual({
      jobId: "old-1", threadId: thread.id, threadTitle: "Mandalorian Background", prompt: "a space battle", preset: "flux2-klein-4b",
      width: 20, height: 10, seed: 1111, steps: 8, queuedAt: expect.any(Number), doneAt: 1_762_000_001_000,
      bytes: (await stat(path.join(f.dataDir, "images", "old-1.png"))).size, imagePath: "images/old-1.png",
    });
    expect(first.pictures.find((p) => p.jobId === "old-3")).not.toHaveProperty("seed");
    expect(first.pictures.find((p) => p.jobId === "new-1")).toMatchObject({ seed: 9, steps: 4, runMs: 3100 });

    // Again: nothing changes. A fill that races the done write leaves the done row as it is.
    await backfillPictures({ store: f.store, dataDir: f.dataDir });
    f.store.pictures.fill("new-1", { width: 1, height: 1, bytes: 1, doneAt: 1 });
    expect(f.store.pictures.list({ limit: 50 })).toEqual(first);

    // Killed part way: some rows written, the rest not. The next start fills the rest, once each.
    const db = new DatabaseSync(f.store.dbPath);
    try { db.exec("DELETE FROM pictures WHERE job_id IN ('old-2', 'old-3')"); } finally { db.close(); }
    expect(f.store.pictures.list({ limit: 50 }).count).toBe(2);
    await backfillPictures({ store: f.store, dataDir: f.dataDir });
    expect(f.store.pictures.list({ limit: 50 })).toEqual(first);
  });

  it("every path that deletes a card deletes its row in the same write, and a row never outlives its card", async () => {
    const f = await fixture();
    const a = f.store.createThread({ title: "a" });
    const b = f.store.createThread({ title: "b" });
    for (const [thread, job] of [[a, "a1"], [a, "a2"], [b, "b1"], [b, "b2"]] as const) await f.finish(thread.id, job, `prompt ${job}`, { facts: { seed: 1, steps: 8, runMs: 10 } });
    expect(f.ids(f.store.pictures.list({ limit: 50 })).toSorted()).toEqual(["a1", "a2", "b1", "b2"]);

    f.store.deleteMessage(a.id, "a1");
    expect(f.ids(f.store.pictures.list({ limit: 50 })).toSorted()).toEqual(["a2", "b1", "b2"]);
    f.store.deleteThread(b.id);
    expect(f.ids(f.store.pictures.list({ limit: 50 }))).toEqual(["a2"]);
    // A done write for a card deleted meanwhile leaves no row.
    f.store.deleteThread(a.id);
    f.store.saveImageJob({ jobId: "late", threadId: a.id, state: "done", imagePath: "images/late.png" }, "late", { width: 1, height: 1, bytes: 1 });
    expect(f.store.pictures.list({ limit: 50 })).toEqual({ pictures: [], count: 0 });
    // An older build that deletes a card with its own SQL keeps the index in step too.
    const c = f.store.createThread({ title: "c" });
    await f.finish(c.id, "c1", "kept in step", { facts: {} });
    const db = new DatabaseSync(f.store.dbPath, { enableForeignKeyConstraints: true });
    try { db.prepare("DELETE FROM messages WHERE id = ?").run("c1"); } finally { db.close(); }
    expect(f.store.pictures.list({ limit: 50 }).count).toBe(0);
  });

  it("pages newest first by a keyset cursor, with no duplicate or gap across ties, filters or a picture made between pages", async () => {
    let clock = 1_762_000_000_000;
    let tick = 0;
    // About ten pictures share each millisecond, so the cursor must break ties.
    const f = await fixture(() => clock + Math.floor(tick++ / 60));
    const thread = f.store.createThread({ title: "t" });
    const made: string[] = [];
    for (let i = 0; i < 120; i++) {
      const job = `job-${String(i).padStart(3, "0")}`;
      await f.finish(thread.id, job, i % 3 === 0 ? `Space battle ${i}` : i % 3 === 1 ? `100% rainbow ${i}` : `a_b quad ${i}`, { facts: { runMs: i } });
      made.push(job);
    }
    const all = f.store.pictures.list({ limit: 500 });
    expect(all.count).toBe(120);
    expect(all.next).toBeUndefined();
    const doneAt = all.pictures.map((p) => p.doneAt);
    expect(doneAt).toEqual(doneAt.toSorted((x, y) => y - x));
    expect(new Set(doneAt).size).toBeLessThan(20);
    expect(f.ids(all)).toEqual(made.toReversed());

    const walk = (params: { q?: string; setup?: string }, limit: number, between?: () => Promise<void>) => async () => {
      const seen: string[] = [];
      let before: string | undefined;
      for (let page = 0; page < 200; page++) {
        const list = f.store.pictures.list({ limit, ...params, ...before === undefined ? {} : { before } });
        seen.push(...f.ids(list));
        if (page === 0) await between?.();
        if (list.next === undefined) return seen;
        before = list.next;
      }
      throw new Error("paging did not end");
    };
    expect(await walk({}, 7)()).toEqual(made.toReversed());
    // A picture made after the first page does not shift the later pages.
    clock += 1_000_000;
    expect(await walk({}, 7, () => f.finish(thread.id, "newer", "Space battle late", { facts: {} }))()).toEqual(made.toReversed());

    // Prompt words, any case; LIKE's % and _ are plain characters.
    const space = f.store.pictures.list({ limit: 500, q: "space BATTLE" });
    expect(space.count).toBe(41);
    expect(f.ids(space).slice(0, 2)).toEqual(["newer", "job-117"]);
    expect(f.store.pictures.list({ limit: 500, q: "100%" }).count).toBe(40);
    expect(f.store.pictures.list({ limit: 500, q: "a_b" }).count).toBe(40);
    expect(f.store.pictures.list({ limit: 500, q: "%" }).count).toBe(40);
    expect(f.store.pictures.list({ limit: 500, q: "e_b" }).count).toBe(0);
    expect(await walk({ q: "rainbow" }, 6)()).toEqual(made.filter((_, i) => i % 3 === 1).toReversed());
    expect(f.store.pictures.list({ limit: 500, setup: "flux2-klein-4b" }).count).toBe(121);
    expect(f.store.pictures.list({ limit: 500, setup: "sdxl-lightning" }).count).toBe(0);
    expect(() => f.store.pictures.list({ limit: 5, before: "not a cursor" })).toThrow(expect.objectContaining({ code: "bad-params" }));
  });
});
