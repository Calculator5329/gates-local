// Settings › Updates on the server: status and the result note never start a
// process, check runs git only when asked, and every answer encodes on the
// wire.
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { encodeResult } from "@gates-local/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createUpdateHandlers, createUpdateModule } from "./module.ts";
import { RECORD_FILE, writeRecord } from "./record.ts";
import type { Runner } from "./run.ts";
import { type Repos, commit, fakePnpm, makeRepos, publish, removeRepos, testEnv } from "./testing.ts";

let r: Repos;

beforeEach(() => {
  r = makeRepos();
  for (const [k, v] of Object.entries(testEnv(r.base))) vi.stubEnv(k, v);
});

afterEach(() => {
  vi.unstubAllEnvs();
  removeRepos(r);
});

/** A runner that counts calls and hands them to the guarded real one. */
function counting(): { runner: Runner; commands: string[] } {
  const fake = fakePnpm();
  return { runner: fake.runner, commands: fake.commands };
}

const encodes = (method: "update.status" | "update.check" | "update.dismissResult", value: unknown) => {
  const out = encodeResult("1", method, value as never);
  expect(out.ok).toBe(true);
};

describe("update.status", () => {
  it("reads the version without running anything, and shows the last result once", () => {
    writeRecord(r.data, { at: 5, outcome: "updated", to: { commit: "a".repeat(40), label: "v0.2.0" }, changes: 3 });
    const c = counting();
    const update = createUpdateModule({ root: r.clone, dataDir: r.data, runner: c.runner, everyChange: () => false, now: () => 9 });
    expect(existsSync(path.join(r.data, RECORD_FILE))).toBe(false);
    const handlers = createUpdateHandlers(update);
    const status = handlers["update.status"]();
    expect(status.version).toMatchObject({ kind: "commit" });
    expect(status.result).toEqual({ at: 5, outcome: "updated", line: "Updated to v0.2.0, 3 changes." });
    expect(status.lastCheck).toBeNull();
    encodes("update.status", status);
    expect(handlers["update.dismissResult"]()).toEqual({ dismissed: true });
    expect(update.status().result).toBeNull();
    expect(update.dismissResult()).toEqual({ dismissed: false });
    // A second server start finds nothing to show.
    expect(createUpdateModule({ root: r.clone, dataDir: r.data, runner: c.runner, everyChange: () => false }).status().result).toBeNull();
    expect(c.commands).toEqual([]);
  });

  it("words a stopped update with its step and the log", () => {
    writeRecord(r.data, {
      at: 5,
      outcome: "stopped",
      from: { commit: "a".repeat(40), label: "v0.1.0" },
      to: { commit: "b".repeat(40), label: "v0.2.0" },
      step: "install",
      reason: "ERR_PNPM_TEST",
      logPath: "update-logs/x.log",
    });
    const update = createUpdateModule({ root: r.clone, dataDir: r.data, runner: counting().runner, everyChange: () => false });
    expect(update.status().result).toMatchObject({ outcome: "stopped", logPath: "update-logs/x.log" });
    expect(update.status().result?.line).toMatch(/^The update to v0\.2\.0 stopped at .+: ERR_PNPM_TEST\. Gates Local is still on v0\.1\.0\.$/);
    encodes("update.status", update.status());
  });
});

describe("update.check", () => {
  it("lists what is new, keeps it for status, and shares one fetch between two clicks", async () => {
    commit(r.seed, "Second");
    commit(r.seed, "Third");
    publish(r.seed);
    const c = counting();
    const update = createUpdateModule({ root: r.clone, dataDir: r.data, runner: c.runner, everyChange: () => false, now: () => 42 });
    const [a, b] = await Promise.all([update.check(), update.check()]);
    expect(a).toBe(b);
    expect(a).toMatchObject({ state: "available", checkedAt: 42, channel: "main", total: 2, changes: ["Third", "Second"] });
    expect(c.commands.filter((x) => x.startsWith("git fetch")).length).toBe(1);
    expect(update.status().lastCheck).toBe(a);
    encodes("update.check", a);
  });

  it("says up to date", async () => {
    const update = createUpdateModule({ root: r.clone, dataDir: r.data, runner: counting().runner, everyChange: () => true, now: () => 1 });
    const check = await update.check();
    expect(check).toMatchObject({ state: "up-to-date", channel: "main" });
    encodes("update.check", check);
  });

  it("explains a tracked change in the app's words", async () => {
    commit(r.seed, "Second");
    publish(r.seed);
    const update = createUpdateModule({ root: r.clone, dataDir: r.data, runner: counting().runner, everyChange: () => false, now: () => 1 });
    const { writeFileSync } = await import("node:fs");
    writeFileSync(path.join(r.clone, "app.txt"), "edited\n");
    const check = await update.check();
    expect(check).toMatchObject({ state: "cannot-check", reason: "local-changes" });
    encodes("update.check", check);
  });

  it("turns a refused folder into a reason to show, without starting a process", async () => {
    const outside = mkdtempSync(path.join(tmpdir(), "gl-update-outside-"));
    try {
      const c = counting();
      const update = createUpdateModule({ root: outside, dataDir: r.data, runner: c.runner, everyChange: () => false, now: () => 1 });
      const check = await update.check();
      expect(check).toMatchObject({ state: "cannot-check", reason: "error" });
      expect(check.state === "cannot-check" && check.lines[0]).toMatch(/outside the test root/);
      encodes("update.check", check);
      expect(c.commands).toEqual(["git --version"]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
