// A command past its time limit: real processes, in a temporary folder. The
// shell starts a grandchild that holds stdout open, which is what a pnpm
// subprocess does, so ending only the immediate process leaves `close` unfired.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type TreeStop, createRunner, endTree, realRunner } from "./run.ts";
import { type Repos, makeRepos, removeRepos, testEnv } from "./testing.ts";
import { isAlive } from "./wait.ts";

let r: Repos;

beforeEach(() => {
  r = makeRepos();
  for (const [k, v] of Object.entries(testEnv(r.base))) vi.stubEnv(k, v);
});

afterEach(() => {
  vi.unstubAllEnvs();
  removeRepos(r);
});

const pidIn = (file: string) => Number(readFileSync(file, "utf8").trim());

describe.skipIf(process.platform === "win32")("a command that runs past its time limit", { timeout: 20_000 }, () => {
  it("ends the grandchild holding the pipes too, and answers within a bound", async () => {
    const file = path.join(r.base, "grandchild.pid");
    const started = performance.now();
    const result = await realRunner("sh", ["-c", `sleep 30 & echo $! > "${file}"; wait`], { cwd: r.clone, timeoutMs: 300 });
    expect(result).toMatchObject({ code: null, failure: "timeout" });
    expect(result.treeStillRunning).toBeUndefined();
    expect(performance.now() - started).toBeLessThan(12_000);
    expect(isAlive(pidIn(file))).toBe(false);
  });

  it("escalates to SIGKILL for a tree that ignores SIGTERM", async () => {
    const file = path.join(r.base, "stubborn.pid");
    const started = performance.now();
    const runner = createRunner({ graceMs: 150 });
    const result = await runner("sh", ["-c", `trap "" TERM; sleep 30 & echo $! > "${file}"; wait`], { cwd: r.clone, timeoutMs: 300 });
    expect(result).toMatchObject({ failure: "timeout" });
    expect(result.treeStillRunning).toBeUndefined();
    expect(performance.now() - started).toBeLessThan(12_000);
    expect(isAlive(pidIn(file))).toBe(false);
  });

  it("says so and answers within the bound when the tree cannot be confirmed ended", async () => {
    const runner = createRunner({ graceMs: 50, confirmMs: 50, exists: () => true });
    const result = await runner("sh", ["-c", "exec sleep 30"], { cwd: r.clone, timeoutMs: 100 });
    expect(result).toMatchObject({ failure: "timeout", treeStillRunning: true });
  });

  it("ends the commands when the updater gets Ctrl+C, though they run in their own group", async () => {
    const file = path.join(r.base, "interrupted.pid");
    // A separate process, so the signal this test sends ends that process and not the test run.
    const source = pathToFileURL(path.join(import.meta.dirname, "run.ts")).href;
    const script = `import { realRunner } from ${JSON.stringify(source)};
      await realRunner("sh", ["-c", ${JSON.stringify(`sleep 30 & echo $! > "${file}"; wait`)}], { cwd: ${JSON.stringify(r.clone)} });`;
    const updater = spawn(process.execPath, ["--input-type=module", "--no-warnings", "-e", script], { stdio: "ignore" });
    const exited = new Promise<NodeJS.Signals | null>((resolve) => updater.once("exit", (_code, signal) => resolve(signal)));
    await vi.waitFor(() => expect(existsSync(file) && readFileSync(file, "utf8").trim() !== "").toBe(true), { timeout: 12_000, interval: 25 });
    updater.kill("SIGINT");
    expect(await exited).toBe("SIGINT");
    await vi.waitFor(() => expect(isAlive(pidIn(file))).toBe(false), { timeout: 5000, interval: 25 });
  });
});

describe("ending a process tree", () => {
  const base: TreeStop = { platform: "linux", graceMs: 40, confirmMs: 40, exists: () => true, signal: () => undefined, taskkill: async () => 0 };

  it("POSIX: SIGTERM, then SIGKILL only when the group outlasts the grace", async () => {
    const sent: string[] = [];
    let alive = true;
    const gentle = await endTree(7, { ...base, exists: () => alive, signal: (_pid, s) => { sent.push(s); alive = false; } });
    expect(gentle).toBe(true);
    expect(sent).toEqual(["SIGTERM"]);
    const after: string[] = [];
    let term = true;
    const hard = await endTree(7, { ...base, exists: () => term, signal: (_pid, s) => { after.push(s); if (s === "SIGKILL") term = false; } });
    expect(hard).toBe(true);
    expect(after).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("POSIX: reports a group that outlasts SIGKILL", async () => {
    expect(await endTree(7, base)).toBe(false);
  });

  it("Windows: taskkill over the whole tree, confirmed by the root being gone", async () => {
    const calls: Array<readonly string[]> = [];
    const signal = vi.fn();
    const ended = await endTree(4242, { ...base, platform: "win32", exists: () => false, signal, taskkill: async (args) => { calls.push(args); return 0; } });
    expect(ended).toBe(true);
    expect(calls).toEqual([["/PID", "4242", "/T", "/F"]]);
    expect(signal).not.toHaveBeenCalled();
  });

  it("Windows: a tree already gone counts, a taskkill that failed or a root still there does not", async () => {
    const win = { ...base, platform: "win32" as const };
    expect(await endTree(1, { ...win, exists: () => false, taskkill: async () => 128 })).toBe(true);
    expect(await endTree(1, { ...win, exists: () => false, taskkill: async () => 1 })).toBe(false);
    expect(await endTree(1, { ...win, exists: () => false, taskkill: async () => null })).toBe(false);
    expect(await endTree(1, { ...win, exists: () => true, taskkill: async () => 0 })).toBe(false);
  });
});
