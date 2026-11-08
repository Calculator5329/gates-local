// "Update and restart": the updater the desktop app starts must not touch the
// clone until the app's process has exited. A real child process stands in
// for the app.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "./cli.ts";
import { RECORD_FILE } from "./record.ts";
import type { Runner } from "./run.ts";
import { type Repos, commit, fakePnpm, head, makeRepos, publish, removeRepos, testEnv } from "./testing.ts";

let r: Repos;

beforeEach(() => {
  r = makeRepos();
  for (const [k, v] of Object.entries(testEnv(r.base))) vi.stubEnv(k, v);
});

afterEach(() => {
  vi.unstubAllEnvs();
  removeRepos(r);
});

describe("the detached updater", () => {
  it("waits for the app's pid to exit before its first command, then updates and opens the app again", async () => {
    const target = commit(r.seed, "Newer");
    publish(r.seed);
    const app = spawn(process.execPath, ["-e", "setTimeout(() => {}, 700)"], { stdio: "ignore" });
    let exitedAt: number | undefined;
    app.on("exit", () => (exitedAt = performance.now()));
    await new Promise<void>((resolve) => app.once("spawn", () => resolve()));
    const fake = fakePnpm();
    let firstCommandAt: number | undefined;
    let aliveAtFirst: boolean | undefined;
    const runner: Runner = (command, args, options) => {
      if (firstCommandAt === undefined) {
        firstCommandAt = performance.now();
        aliveAtFirst = app.exitCode === null && app.signalCode === null;
      }
      return fake.runner(command, args, options);
    };
    const relaunch = vi.fn();
    const code = await runCli({
      root: r.clone,
      argv: ["--wait-pid", String(app.pid), "--restart", "--data-dir", r.data, "--relaunch-cwd", r.base, "--relaunch-arg", "."],
      defaultDataDir: r.data,
      pnpm: fake.pnpm,
      runner,
      appRunning: () => null,
      relaunch,
      print: () => undefined,
      platform: "linux",
    });
    expect(code).toBe(0);
    expect(exitedAt).toBeDefined();
    expect(aliveAtFirst).toBe(false);
    expect(firstCommandAt!).toBeGreaterThanOrEqual(exitedAt!);
    expect(head(r.clone)).toBe(target);
    expect(relaunch).toHaveBeenCalledWith({ cwd: r.base, args: ["."] });
    expect(JSON.parse(readFileSync(path.join(r.data, RECORD_FILE), "utf8"))).toMatchObject({ outcome: "updated" });
  });

  it("gives up without touching the clone when the app does not close, and leaves a result saying so", async () => {
    commit(r.seed, "Newer");
    publish(r.seed);
    const before = head(r.clone);
    const fake = fakePnpm();
    const code = await runCli({
      root: r.clone,
      argv: ["--wait-pid", String(process.pid), "--restart", "--data-dir", r.data],
      defaultDataDir: r.data,
      pnpm: fake.pnpm,
      runner: fake.runner,
      appRunning: () => null,
      relaunch: () => undefined,
      print: () => undefined,
      closeWaitMs: 300,
      platform: "linux",
    });
    expect(code).toBe(1);
    expect(fake.commands).toEqual([]);
    expect(head(r.clone)).toBe(before);
    expect(JSON.parse(readFileSync(path.join(r.data, RECORD_FILE), "utf8"))).toMatchObject({ outcome: "refused", reason: "Gates Local did not close, so the update did not start" });
  });
});
