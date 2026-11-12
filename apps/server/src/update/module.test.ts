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
import { type Repos, commit, fakePnpm, head, makeRepos, publish, removeRepos, testEnv } from "./testing.ts";
import { saveTransaction } from "./transaction.ts";
import { acquireLock } from "./lock.ts";
import { automaticChecks } from "./automatic.ts";
import { openSettingsStore } from "../settings/store.ts";
import { createUpdateAdmission } from "./admission.ts";
import { inspect } from "./check.ts";

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
  it("AV-03 named active imports refuse approval until they finish", async () => {
    commit(r.seed, "Approved update"); publish(r.seed);
    const imports = ["Import: Default data"];
    const admission = createUpdateAdmission();
    const update = createUpdateModule({ root: r.clone, dataDir: r.data, runner: counting().runner, everyChange: () => true, admission, activity: () => imports, uninterruptible: () => imports });
    await update.check();
    const offered = update.status();
    expect(offered.activity).toEqual(["Import: Default data"]);
    expect(await update.prepare(offered.approval ?? "")).toEqual({ state: "blocked", message: "Wait for Import: Default data to finish before updating." });
    expect(admission.installing()).toBe(false);
    imports.length = 0;
    const ready = await update.prepare(update.status().approval ?? "");
    expect(ready.state).toBe("ready");
    if (ready.state === "ready") update.cancel(ready.reservation);
    await update.close();
  });
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

  it("does not say an update never started when it was refused part way through", () => {
    writeRecord(r.data, { at: 5, outcome: "refused", reason: "The update to v0.2.0 has a step that ran too long." });
    const update = createUpdateModule({ root: r.clone, dataDir: r.data, runner: counting().runner, everyChange: () => false });
    expect(update.status().result?.line).toBe("The update stopped: The update to v0.2.0 has a step that ran too long.");
  });
});

describe("update.check", () => {
  it("SN-R2 cancelling git --version throws instead of diagnosing missing git", async () => {
    const controller = new AbortController();
    const runner: Runner = async () => {
      controller.abort(new Error("Check cancelled"));
      return { code: null, stdout: "", stderr: "Cancelled", failure: "aborted" };
    };
    await expect(inspect({ root: r.clone, runner, choice: "main", signal: controller.signal })).rejects.toThrow("Check cancelled");
  });
  it.each(["status", "fetch"])("SN-CO-03 a check closed during %s does not publish, store or log a failure", async heldCommand => {
    let entered: () => void = vi.fn();
    let release: () => void = vi.fn();
    const held = new Promise<void>(resolve => { release = resolve; });
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    let holding = false;
    const fake = fakePnpm();
    const changed = vi.fn(), log = vi.fn();
    const update = createUpdateModule({ root: r.clone, dataDir: r.data, everyChange: () => true, changed, log, runner: async (command, args, options) => {
      if (holding && args[0] === heldCommand) { entered(); await held; }
      if (options.signal?.aborted) return { code: null, stdout: "", stderr: "Cancelled", failure: "aborted" };
      return fake.runner(command, args, options);
    } });
    await update.check();
    const previous = update.status().lastCheck;
    holding = true; changed.mockClear(); log.mockClear();
    const checking = update.check();
    await waiting;
    const closing = update.close();
    release(); await checking; await closing;
    expect(changed).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    expect(update.status().lastCheck).toBe(previous);
  });
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

  it("says an update was cut off, rather than up to date, and the answer encodes", async () => {
    saveTransaction(r.clone, { channel: "main", branch: "main", from: { commit: "a".repeat(40), label: "aaaaaaa" }, to: { commit: head(r.clone), label: "v0.2.0" }, changes: 1, phase: "forward" });
    const update = createUpdateModule({ root: r.clone, dataDir: r.data, runner: counting().runner, everyChange: () => false, now: () => 1 });
    const check = await update.check();
    expect(check).toMatchObject({ state: "cannot-check", reason: "unfinished" });
    expect(check.state === "cannot-check" && check.lines[0]).toContain("The last update, to v0.2.0, did not finish");
    const words = check.state === "cannot-check" ? check.lines.join(" ") : "";
    expect(words).toContain("pnpm run app-update");
    expect(words).toContain("git pull, pnpm install, pnpm start");
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
      expect(c.commands).toEqual([]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("automatic checks share the updater engine", () => {
  it("AU-01 unchanged approval reserves atomically, broadcasts pause, and cancel reopens", async () => {
    commit(r.seed, "Approved update"); publish(r.seed);
    const admission = createUpdateAdmission();
    const changed = vi.fn();
    const update = createUpdateModule({ root: r.clone, dataDir: r.data, runner: counting().runner, everyChange: () => true, admission, changed });
    await update.check();
    const approval = update.status().approval;
    if (!approval) throw new Error("missing fixture approval");
    const ready = await update.prepare(approval);
    expect(ready.state).toBe("ready");
    if (ready.state !== "ready") throw new Error("fixture not reserved");
    expect(() => admission.admit()).toThrow("closing to update");
    expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ installing: true }));
    const committed = update.commit({ reservation: ready.reservation, target: ready.target, release: "main-release" });
    expect(committed.accepted).toBe(true);
    if (!committed.accepted) throw new Error("fixture not committed");
    expect(update.cancel(ready.reservation)).toEqual({ cancelled: false });
    expect(update.cancel(committed.release)).toEqual({ cancelled: true });
    expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ installing: false }));
    expect(() => admission.admit()).not.toThrow();
  });

  it("AU-01 changed work during the recheck requires a new dialog and reserves nothing", async () => {
    commit(r.seed, "Approved update"); publish(r.seed);
    const admission = createUpdateAdmission();
    const activity = ["1 running reply"];
    let holdFetch = false;
    let release: () => void = vi.fn();
    let announce: () => void = vi.fn();
    const held = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { announce = resolve; });
    const c = counting();
    const runner: Runner = async (command, args, options) => {
      if (holdFetch && args[0] === "fetch") { announce(); await held; }
      return c.runner(command, args, options);
    };
    const update = createUpdateModule({ root: r.clone, dataDir: r.data, runner, everyChange: () => true, admission, activity: () => activity });
    await update.check();
    const approval = update.status().approval;
    if (!approval) throw new Error("missing fixture approval");
    holdFetch = true;
    const preparing = update.prepare(approval);
    await started;
    admission.admit();
    activity.push("model download: new-model");
    release();
    const result = await preparing;
    expect(result).toMatchObject({ state: "changed", status: { activity: ["1 running reply", "model download: new-model"] } });
    expect(admission.installing()).toBe(false);
    expect(() => admission.admit()).not.toThrow();
  });

  it("AU-01 equal activity counts cannot hide replacement work and two clients share only one reservation", async () => {
    commit(r.seed, "Approved update"); publish(r.seed);
    const admission = createUpdateAdmission();
    const update = createUpdateModule({ root: r.clone, dataDir: r.data, runner: counting().runner, everyChange: () => true, admission, activity: () => ["1 running reply"] });
    await update.check();
    const old = update.status().approval;
    if (!old) throw new Error("missing fixture approval");
    admission.admit();
    expect((await update.prepare(old)).state).toBe("changed");
    expect(admission.installing()).toBe(false);
    const approval = update.status().approval;
    if (!approval) throw new Error("missing fixture approval");
    const results = await Promise.all([update.prepare(approval), update.prepare(approval)]);
    expect(results.filter((result) => result.state === "ready")).toHaveLength(1);
    const ready = results.find((result) => result.state === "ready");
    if (ready?.state === "ready") update.cancel(ready.reservation);
  });

  it("AU-02 a remote advance returns the new full target for approval without reserving", async () => {
    commit(r.seed, "Approved B"); publish(r.seed);
    const admission = createUpdateAdmission();
    const update = createUpdateModule({ root: r.clone, dataDir: r.data, runner: counting().runner, everyChange: () => true, admission });
    await update.check();
    const approval = update.status().approval;
    if (!approval) throw new Error("missing fixture approval");
    const newer = commit(r.seed, "Unapproved C"); publish(r.seed);
    expect(await update.prepare(approval)).toMatchObject({ state: "changed", status: { lastCheck: { targetCommit: newer } } });
    expect(admission.installing()).toBe(false);
  });

  it("off means no git process and no network, and the preference survives reopening", async () => {
    const settings = await openSettingsStore({ dataDir: r.data, systemOllamaAnswers: async () => false });
    settings.update({ updateAutomatic: false });
    const reopened = await openSettingsStore({ dataDir: r.data, systemOllamaAnswers: async () => false });
    expect(reopened.get().updateAutomatic).toBe(false);
    const c = counting();
    const update = createUpdateModule({ root: r.clone, dataDir: r.data, runner: c.runner, everyChange: () => false });
    vi.useFakeTimers();
    const stop = automaticChecks({ desktop: true, enabled: () => reopened.get().updateAutomatic !== false, check: () => update.check(true), onChange: (l) => reopened.onChange(l) });
    try {
      await vi.advanceTimersByTimeAsync(7_200_000);
      expect(c.commands).toEqual([]);
      expect(update.status().lastCheck).toBeNull();
    } finally { stop(); vi.useRealTimers(); }
  });

  it("cannot fetch while the install owns the checkout lock", async () => {
    const held = acquireLock(r.clone);
    expect(held.ok).toBe(true);
    if (!held.ok) throw new Error("fixture lock failed");
    try {
      const c = counting();
      const update = createUpdateModule({ root: r.clone, dataDir: r.data, runner: c.runner, everyChange: () => false });
      expect((await update.check(true)).state).toBe("cannot-check");
      expect(c.commands).toEqual([]);
      expect(update.status().lastCheck).toBeNull();
    } finally { held.lock.release(); }
  });

  it("offline automatic checks preserve the last answer and push no failure; a click reports it", async () => {
    const c = counting();
    let offline = false;
    const changed = vi.fn();
    const runner: Runner = (command, args, options) => {
      if (offline) throw new Error("offline");
      return c.runner(command, args, options);
    };
    const update = createUpdateModule({ root: r.clone, dataDir: r.data, runner, everyChange: () => false, changed });
    const good = await update.check(true);
    expect(changed).toHaveBeenCalledTimes(1);
    offline = true;
    expect((await update.check(true)).state).toBe("cannot-check");
    expect(update.status().lastCheck).toEqual(good);
    expect(changed).toHaveBeenCalledTimes(1);
    expect((await update.check()).state).toBe("cannot-check");
    expect(update.status().lastCheck?.state).toBe("cannot-check");
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it("shutdown drains a check, excludes installs until it ends, and refuses later checks", async () => {
    let release: () => void = vi.fn();
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const c = counting();
    const runner: Runner = async (command, args, options) => { await hold; return c.runner(command, args, options); };
    const update = createUpdateModule({ root: r.clone, dataDir: r.data, runner, everyChange: () => false });
    const check = update.check(true);
    expect(acquireLock(r.clone).ok).toBe(false);
    let drained = false;
    const closing = update.close().then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);
    release();
    await Promise.all([check, closing]);
    const count = c.commands.length;
    expect((await update.check()).state).toBe("cannot-check");
    expect(c.commands).toHaveLength(count);
    const lock = acquireLock(r.clone);
    expect(lock.ok).toBe(true);
    if (lock.ok) lock.lock.release();
  });
});
