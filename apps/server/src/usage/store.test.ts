import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createUsage } from "./index.ts";
import { openUsageStore, type StoredReply, type UsageStore } from "./store.ts";

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 10, 7, 9, 15);

let dir: string;
const open: UsageStore[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gates-usage-"));
});

afterEach(() => {
  for (const s of open.splice(0)) s.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Tokens in and replies over every row the screen reads. */
const totals = (u: ReturnType<typeof createUsage>) =>
  u.handlers["usage.read"]({ since: 0 }).rows.reduce((a, r) => [a[0]! + r.promptTokens, a[1]! + r.replies], [0, 0]);

/**
 * Starts the server's usage `failures` times with the stored replies unreadable, a live reply
 * in each (recorded, and saved in the thread store too), then once with them readable.
 */
function starts(failures: number) {
  const file = join(dir, "usage.sqlite");
  let t = T0;
  const stored: StoredReply[] = [{ model: "m:1", at: T0 - 5 * HOUR, promptTokens: 100, completionTokens: 1 }];
  let left = failures;
  const replies = () => {
    if (left > 0) throw new Error("database is locked");
    return { replies: stored, lacking: 0 };
  };
  const lines: string[] = [];
  const start = () => createUsage({ file, push: () => {}, replies, log: (l) => lines.push(l), now: () => t });
  for (let i = 0; i < failures; i++) {
    const u = start();
    t += HOUR;
    u.record("m:1", { promptTokens: 50, completionTokens: 1 }, true);
    stored.push({ model: "m:1", at: t, promptTokens: 50, completionTokens: 1 });
    u.close();
    left--;
    t += HOUR;
  }
  const u = start();
  const out = { totals: totals(u), lines };
  u.close();
  return out;
}

function usage(options: { now?: () => number; log?: (line: string) => void } = {}, file = join(dir, "usage.sqlite")): UsageStore {
  const s = openUsageStore(file, options);
  open.push(s);
  return s;
}

describe("openUsageStore", () => {
  it("sums each request into its UTC hour and model and keeps the order models were first used", () => {
    let t = T0;
    const s = usage({ now: () => t });
    s.record("qwen3.5:9b", { promptTokens: 120, completionTokens: 30 }, true);
    s.record("qwen3.5:9b", { promptTokens: 200, completionTokens: 5 }, false); // a tool round of the same reply
    t = T0 + 10 * 60_000;
    s.record("gemma3", { promptTokens: 7, completionTokens: 2 }, true);
    t = T0 + HOUR;
    s.record("qwen3.5:9b", { promptTokens: 1, completionTokens: 1 }, true);

    const hour = Math.floor(T0 / HOUR) * HOUR;
    const read = s.read(0);
    expect(read.models).toEqual(["qwen3.5:9b", "gemma3:latest"]);
    expect(read.rows).toMatchObject([
      { hour, model: "gemma3:latest", promptTokens: 7, completionTokens: 2, replies: 1 },
      { hour, model: "qwen3.5:9b", promptTokens: 320, completionTokens: 35, replies: 1 },
      { hour: hour + HOUR, model: "qwen3.5:9b", promptTokens: 1, completionTokens: 1, replies: 1 },
    ]);
    expect(s.read(hour + HOUR).rows).toMatchObject([{ hour: hour + HOUR, model: "qwen3.5:9b", promptTokens: 1, completionTokens: 1, replies: 1 }]);
    // A since inside an hour still returns that whole hour.
    expect(s.read(hour + HOUR + 59 * 60_000).rows).toHaveLength(1);
  });

  it("counts what a request reported when one figure is missing, and nothing when both are", () => {
    const s = usage({ now: () => T0 });
    s.record("m:1", { promptTokens: 40 }, true);
    s.record("m:1", {}, false);
    expect(s.read(0).rows).toMatchObject([{ hour: Math.floor(T0 / HOUR) * HOUR, model: "m:1", promptTokens: 40, completionTokens: 0, replies: 1 }]);
  });

  it("sums decode and prompt-reading time with only the tokens of requests that reported them, and wall time", () => {
    const s = usage({ now: () => T0 });
    s.record("m:1", { promptTokens: 1000, completionTokens: 400, evalDurationMs: 8000, promptEvalDurationMs: 500, durationMs: 9000 }, true);
    s.record("m:1", { promptTokens: 30, completionTokens: 10, evalDurationMs: 100, promptEvalDurationMs: 60, durationMs: 200 }, true);
    // No times at all: its tokens count, but it never dilutes a speed.
    s.record("m:1", { promptTokens: 500, completionTokens: 200 }, true);
    expect(s.read(0).rows).toEqual([{
      hour: Math.floor(T0 / HOUR) * HOUR, model: "m:1", replies: 3,
      promptTokens: 1530, completionTokens: 610,
      decodeTokens: 410, decodeMs: 8100,
      readTokens: 1030, readMs: 560,
      wallMs: 9200,
    }]);
  });

  it("survives a reopen and fills from stored replies once", () => {
    const replies = [
      { model: "a:1", at: T0, promptTokens: 10, completionTokens: 2, evalDurationMs: 40, promptEvalDurationMs: 5, durationMs: 50 },
      { model: "b:1", at: T0 - 3 * HOUR, promptTokens: 5, completionTokens: 1 },
      { model: "a:1", at: T0 + 1, promptTokens: 1, completionTokens: 1 },
    ];
    const first = usage();
    expect(first.fillOnce(replies)).toBe(true);
    // Ordered by time of use, not by the order the rows came in.
    expect(first.read(0).models).toEqual(["b:1", "a:1"]);
    first.close();
    open.splice(0);

    const again = usage();
    expect(again.fillOnce(replies)).toBe(false);
    const rows = again.read(0).rows;
    expect(rows.map((r) => [r.model, r.promptTokens, r.completionTokens, r.replies])).toEqual([
      ["b:1", 5, 1, 1],
      ["a:1", 11, 3, 2],
    ]);
    // The fill carries the times where the stored stats had them.
    expect(rows[1]).toMatchObject({ decodeTokens: 2, decodeMs: 40, readTokens: 10, readMs: 5, wallMs: 50 });
    expect(rows[0]).toMatchObject({ decodeTokens: 0, decodeMs: 0, wallMs: 0 });
  });

  it("an empty fill still marks itself done", () => {
    const s = usage();
    expect(s.fillOnce([])).toBe(true);
    expect(s.fillOnce([{ model: "a:1", at: T0, promptTokens: 1, completionTokens: 1 }])).toBe(false);
    expect(s.read(0).rows).toEqual([]);
  });

  // The thread store also keeps every reply recorded live, so a fill that ran late would count
  // those twice: the fill takes only replies from before the file was first opened.
  describe("a fill that fails runs again later and counts each reply once", () => {
    it("failed once (the review's probe)", () => {
      const { totals: got, lines } = starts(1);
      expect(got).toEqual([150, 2]);
      expect(lines.some((l) => l.includes("failed"))).toBe(true);
    });

    it("failed twice, then succeeded", () => {
      expect(starts(2).totals).toEqual([200, 3]);
    });

    it("the cutoff is dropped once the fill succeeds", () => {
      starts(1);
      const db = new DatabaseSync(join(dir, "usage.sqlite"));
      const keys = db.prepare("SELECT key FROM usage_meta ORDER BY key").all().map((r) => String(r["key"]));
      db.close();
      expect(keys).toEqual(["filled"]);
    });
  });

  it("an unreadable file starts usage empty, is kept aside and is logged once", () => {
    const file = join(dir, "usage.sqlite");
    writeFileSync(file, "this is not a database, it is a sentence long enough to fill a header page".repeat(20));
    const lines: string[] = [];
    const s = usage({ now: () => T0, log: (line) => lines.push(line) }, file);
    expect(s.read(0)).toEqual({ rows: [], models: [] });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^usage: .*unreadable.*starting empty/);
    expect(readdirSync(dir).some((name) => name.startsWith("usage.sqlite.bad-"))).toBe(true);
    s.record("a:1", { promptTokens: 3, completionTokens: 1 }, true);
    expect(s.read(0).rows).toHaveLength(1);
    s.close();
    open.splice(0);
    // The fresh file opens quietly next time.
    const quiet: string[] = [];
    expect(usage({ log: (line) => quiet.push(line) }, file).read(0).rows).toHaveLength(1);
    expect(quiet).toEqual([]);
  });

  it("removing the data folder removes usage with it", () => {
    const data = join(dir, "data");
    const s = usage({ now: () => T0 }, join(data, "usage.sqlite"));
    s.record("a:1", { promptTokens: 3, completionTokens: 1 }, true);
    s.close();
    open.splice(0);
    rmSync(data, { recursive: true });
    expect(usage({}, join(data, "usage.sqlite")).read(0)).toEqual({ rows: [], models: [] });
  });

  it("a process killed mid-write leaves a consistent record", async () => {
    const file = join(dir, "usage.sqlite");
    const child = spawn(process.execPath, ["--no-warnings", fileURLToPath(new URL("../../test/usage-crash-writer.ts", import.meta.url)), file], { stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    child.stderr.on("data", (b: Buffer) => (err += b.toString()));
    await new Promise<void>((resolve, reject) => {
      child.stdout.on("data", (b: Buffer) => {
        if (b.toString().includes("ready")) resolve();
      });
      child.on("exit", (code) => reject(new Error(`writer exited ${String(code)}: ${err}`)));
    });
    child.kill("SIGKILL");
    await new Promise((r) => child.once("exit", r));
    expect(child.signalCode).toBe("SIGKILL");

    const db = new DatabaseSync(file);
    expect(db.prepare("PRAGMA integrity_check").get()?.["integrity_check"]).toBe("ok");
    db.close();
    const read = usage({}, file).read(0);
    expect(read.rows.length).toBeGreaterThan(0);
    for (const row of read.rows) {
      // Every request recorded 10 in and 1 out with its reply: a torn write breaks the ratio.
      expect(row.promptTokens).toBe(row.replies * 10);
      expect(row.completionTokens).toBe(row.replies);
      expect(read.models).toContain(row.model);
    }
    expect(existsSync(`${file}-wal`) || existsSync(file)).toBe(true);
  });
});
