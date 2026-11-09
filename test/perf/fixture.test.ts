import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openThreadStore } from "../../apps/server/src/threads/store.ts";
import { ROOT } from "../e2e/env.ts";
import { prepareFixture, restoreFixture } from "./fixture.ts";

const scratch = mkdtempSync(path.join(tmpdir(), "gates-local-perf-test-"));
let template: string;
// Seeding 4,402 messages through the real store takes several seconds and far longer on a busy machine.
beforeAll(async () => { template = await prepareFixture(ROOT, path.join(scratch, "templates")); }, 180_000);
afterAll(() => { rmSync(scratch, { recursive: true, force: true }); });

describe("prepared performance data", () => {
  it("restores isolated blocks with the complete workload", () => {
    const first = path.join(scratch, "first");
    const ids = restoreFixture(template, first);
    const a = openThreadStore(path.join(first, "threads.sqlite"));
    try {
      expect(a.listThreads()).toHaveLength(400);
      expect(a.getThread(ids.long).messages).toHaveLength(200);
      expect(a.getThread(ids.thousands).messages).toHaveLength(2000);
      const byTitle = (title: string) => a.listThreads().find(thread => thread.title === title)?.id;
      const hover = byTitle("Perf hover 2000");
      expect(hover).toBeDefined();
      if (!hover) throw new Error("Missing never-visited hover fixture");
      expect(a.getThread(hover).messages).toHaveLength(2000);
      expect(a.getThread(hover).messages.at(-1)?.content).toContain("Perf hover 2000");
      expect(a.getThread(ids.long).messages.at(-1)?.content).toContain("Perf long 200");
      expect(a.getThread(ids.huge).messages[0]?.content).toContain("const item3999");
      expect(a.getThread(ids.huge).messages[0]?.content).toContain("| Row 299 | Value 299 |");
      a.createThread({ title: "Only in the first block" });
      a.appendMessage({ threadId: ids.short, role: "user", content: "Only in the first block" });
    } finally { a.close(); }
    const second = path.join(scratch, "second");
    expect(restoreFixture(template, second)).toEqual(ids);
    for (const directory of [second, template]) {
      const store = openThreadStore(path.join(directory, "threads.sqlite"));
      try {
        expect(store.listThreads()).toHaveLength(400);
        expect(store.getThread(ids.short).messages).toHaveLength(1);
      } finally { store.close(); }
    }
  });
  it("does not overwrite an existing block", () => {
    const destination = path.join(scratch, "existing");
    restoreFixture(template, destination);
    const store = openThreadStore(path.join(destination, "threads.sqlite"));
    try { store.createThread({ title: "Preserve this change" }); } finally { store.close(); }
    expect(() => restoreFixture(template, destination)).toThrow();
    const reopened = openThreadStore(path.join(destination, "threads.sqlite"));
    try { expect(reopened.listThreads()).toHaveLength(401); } finally { reopened.close(); }
  });
  it("rejects invalid prepared data before creating a block", () => {
    const invalid = path.join(scratch, "invalid");
    mkdirSync(invalid);
    writeFileSync(path.join(invalid, "fixture.json"), "{}");
    const destination = path.join(scratch, "invalid-copy");
    expect(() => restoreFixture(invalid, destination)).toThrow("Invalid prepared performance fixture");
    expect(existsSync(destination)).toBe(false);
  });
});
