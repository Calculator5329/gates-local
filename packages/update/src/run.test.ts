// A command past its time limit: real processes, in a temporary folder. The
// shell starts a grandchild that holds stdout open, which is what a pnpm
// subprocess does, so ending only the immediate process leaves `close` unfired.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type TreeStop, createRunner, endTree, groupExists, realRunner } from "./run.ts";
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

it.skipIf(process.platform !== "linux").each(["orderly", "hard-exit", "early-exit", "exit-only", "updater"])("SN-CO-07 command groups end with their process (%s)", async mode => {
  const marker = path.join(r.base, "signal-cleanup");
  const ready = path.join(r.base, "signal-ready");
  const groupFile = path.join(r.base, "signal-group");
  const leaf = `process.on('SIGTERM', () => { require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'cleaned'); ${mode === "orderly" ? "process.exit(0);" : ""} }); console.log('ready'); setInterval(() => {}, 1000);`;
  const command = `const child = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(leaf)}], { stdio: ['ignore', 'pipe', 'inherit'] }); process.on('SIGTERM', () => {}); child.stdout.pipe(process.stdout); child.on('exit', () => process.exit(0));`;
  const source = pathToFileURL(path.join(import.meta.dirname, "run.ts")).href;
  const script = `import { realRunner } from ${JSON.stringify(source)};
    import { writeFileSync } from 'node:fs';
    const controller = new AbortController();
    const running = realRunner(process.execPath, ['-e', ${JSON.stringify(command)}], {
      cwd: ${JSON.stringify(r.clone)}, signal: controller.signal,
      onStart: pid => writeFileSync(${JSON.stringify(groupFile)}, String(pid)),
      onOutput: chunk => { if (chunk.includes('ready')) { writeFileSync(${JSON.stringify(ready)}, 'ready'); ${mode === "exit-only" ? "process.exit(0);" : ""} } }
    });
    ${mode === "updater" || mode === "exit-only" ? "" : `process.on('SIGTERM', () => { controller.abort(); ${mode === "orderly" ? "void running.then(() => process.exit(0));" : mode === "hard-exit" ? "setTimeout(() => process.exit(1), 25);" : "process.exit(0);"} });`}
    await running;`;
  const parent = spawn(process.execPath, ["--input-type=module", "--no-warnings", "-e", script], { stdio: "ignore" });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => parent.once("exit", (code, signal) => resolve({ code, signal })));
  let group: number | undefined;
  try {
    await vi.waitFor(() => expect(existsSync(ready)).toBe(true), { timeout: 5000 });
    group = pidIn(groupFile);
    if (mode !== "exit-only") parent.kill("SIGTERM");
    expect(await exited).toEqual(mode === "updater" ? { code: null, signal: "SIGTERM" } : { code: mode === "hard-exit" ? 1 : 0, signal: null });
    await vi.waitFor(() => expect(groupExists(group ?? 0)).toBe(false), { timeout: 1000 });
    if (mode !== "hard-exit" && mode !== "early-exit") expect(existsSync(marker)).toBe(mode === "orderly");
  } finally {
    if (parent.exitCode === null && parent.signalCode === null) { parent.kill("SIGKILL"); await exited; }
    const remaining = group ?? (existsSync(groupFile) ? pidIn(groupFile) : undefined);
    if (remaining !== undefined && groupExists(remaining)) await endTree(remaining, { platform: "linux", graceMs: 0, confirmMs: 1000, exists: groupExists, signal: (pid, signal) => { try { process.kill(-pid, signal); } catch { /* Already ended. */ } }, taskkill: async () => 0 });
  }
});

it.skipIf(process.platform === "win32")("SN-CO-02 abort lets a SIGTERM handler clean up without sending SIGKILL", async () => {
  const marker = path.join(r.base, "cleaned-up");
  const controller = new AbortController();
  const signals: NodeJS.Signals[] = [];
  const runner = createRunner({ signal: (pid, signal) => {
    signals.push(signal);
    try { process.kill(-pid, signal); } catch { /* Already exited. */ }
  } });
  const program = `const fs = require('node:fs'); process.on('SIGTERM', () => { fs.writeFileSync(${JSON.stringify(marker)}, 'cleaned'); process.exit(0); }); console.log('ready'); setInterval(() => {}, 1000);`;
  const result = await runner(process.execPath, ["-e", program], { cwd: r.clone, signal: controller.signal, onOutput: chunk => { if (chunk.includes("ready")) controller.abort(); } });
  expect(result).toMatchObject({ failure: "aborted" });
  expect(signals).toEqual(["SIGTERM"]);
  expect(existsSync(marker)).toBe(true);
});

it("aborting a command stops its process group and prevents another command starting", async () => {
  const controller = new AbortController();
  const signals: NodeJS.Signals[] = [];
  const runner = createRunner({ signal: (pid, signal) => {
    signals.push(signal);
    try { process.kill(-pid, signal); } catch { /* Already exited. */ }
  } });
  let pid: number | undefined;
  let entered: () => void = vi.fn();
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const running = runner(process.execPath, ["-e", "console.log('ready'); setInterval(() => {}, 1000)"], { cwd: r.clone, signal: controller.signal, onStart: value => { pid = value; }, onOutput: chunk => { if (chunk.includes("ready")) entered(); } });
  await ready;
  controller.abort();
  const result = await running;
  expect(result).toMatchObject({ code: null, failure: "aborted" });
  expect(result.treeStillRunning).toBeUndefined();
  if (pid === undefined) throw new Error("The fake command did not start");
  expect(groupExists(pid)).toBe(false);
  if (process.platform !== "win32") expect(signals[0]).toBe("SIGTERM");
  const start = vi.fn();
  expect(await runner(process.execPath, ["-e", "process.exit(0)"], { cwd: r.clone, signal: controller.signal, onStart: start })).toMatchObject({ failure: "aborted" });
  expect(start).not.toHaveBeenCalled();
});

it.runIf(process.platform === "linux" && existsSync("/usr/bin/python3")).each([false, true])("AV-04 rollback distinguishes zombie-only groups from groups with a live parent: %s", async liveParent => {
  // Keep the parent alive so this fixture can deliberately retain, then reap,
  // its own zombie. No orphan is left for the host's init process to collect.
  const parent = spawn("/usr/bin/python3", ["-u", "-c", `import os,sys\n${liveParent ? "os.setsid()\n" : ""}pid=os.fork()\nif pid == 0:\n ${liveParent ? "pass" : "os.setsid()"}\n os._exit(0)\nprint(pid, os.getpid(), flush=True)\nsys.stdin.readline()\nos.waitpid(pid, 0)\n`], { stdio: ["pipe", "pipe", "pipe"] });
  const exited = once(parent, "exit");
  let output = "";
  parent.stdout.on("data", chunk => { output += String(chunk); });
  try {
    await vi.waitFor(() => expect(output.trim()).toMatch(/^\d+ \d+$/));
    const [pid, parentPid] = output.trim().split(" ").map(Number);
    if (pid === undefined || parentPid === undefined) throw new Error("Missing fixture process IDs");
    await vi.waitFor(() => expect(readFileSync(`/proc/${pid}/stat`, "utf8").split(") ").at(-1)?.[0]).toBe("Z"));
    const group = liveParent ? parentPid : pid;
    expect(() => process.kill(-group, 0)).not.toThrow();
    expect(groupExists(group)).toBe(liveParent);
    if (!liveParent) expect(await endTree(group)).toBe(true);
  } finally { parent.stdin.end("\n"); await exited; }
});

it.runIf(process.platform === "linux" && existsSync("/usr/bin/python3"))("AV-04 a zombie leader cannot hide its live descendant from rollback", async () => {
  // The collector adopts and reaps both processes, even after the group
  // leader exits. Its pipe keeps the descendant alive until cleanup.
  const program = "import ctypes,os,sys\nassert ctypes.CDLL(None).prctl(36,1,0,0,0) == 0\nr,w=os.pipe()\nleader=os.fork()\nif leader == 0:\n os.setsid()\n os.close(w)\n worker=os.fork()\n if worker == 0:\n  print('worker',os.getpid(),flush=True)\n  os.read(r,1)\n  os._exit(0)\n os._exit(0)\nos.close(r)\nprint('leader',leader,flush=True)\nsys.stdin.readline()\nos.close(w)\nos.waitpid(leader,0)\nos.waitpid(-1,0)\n";
  const collector = spawn("/usr/bin/python3", ["-u", "-c", program], { stdio: ["pipe", "pipe", "pipe"] });
  const exited = once(collector, "exit");
  let output = "";
  collector.stdout.on("data", chunk => { output += String(chunk); });
  try {
    await vi.waitFor(() => expect(output).toMatch(/worker \d+/));
    await vi.waitFor(() => expect(output).toMatch(/leader \d+/));
    const leader = Number(/leader (\d+)/.exec(output)?.[1]);
    await vi.waitFor(() => expect(readFileSync(`/proc/${leader}/stat`, "utf8").split(") ").at(-1)?.[0]).toBe("Z"));
    expect(groupExists(leader)).toBe(true);
  } finally { collector.stdin.end("\n"); await exited; }
});

describe.skipIf(process.platform === "win32")("a command that runs past its time limit", { timeout: 20_000 }, () => {
  it("AW-02 Windows timeout never taskkills an exited root whose descendant holds its pipe", async () => {
    const taskkill = vi.fn(async () => 128);
    const runner = createRunner({ platform: "win32", exists: () => false, taskkill });
    let group: number | undefined;
    try {
      const result = await runner("sh", ["-c", "sleep 5 &"], { cwd: r.clone, timeoutMs: 200, onStart: pid => { group = pid; } });
      expect.soft(taskkill).not.toHaveBeenCalled();
      expect(result).toMatchObject({ code: null, failure: "timeout", treeStillRunning: true });
    } finally { if (group !== undefined) await endTree(group); }
  });

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

  it("detects a planted live group member after its leader exits", async () => {
    const file = path.join(r.base, "survivor.pid");
    const leader = spawn("sh", ["-c", `sleep 30 & echo $! > "${file}"`], { detached: true, stdio: "ignore" });
    const group = leader.pid!;
    await new Promise((resolve) => leader.once("exit", resolve));
    try {
      expect(isAlive(group)).toBe(false);
      expect(isAlive(pidIn(file))).toBe(true);
      expect(groupExists(group)).toBe(true);
      // Deliberately leave it running: confirmation must fail for a true survivor.
      expect(await endTree(group, { platform: process.platform, graceMs: 40, confirmMs: 40, exists: groupExists, signal: () => {}, taskkill: async () => 0 })).toBe(false);
      expect(groupExists(group)).toBe(true);
    } finally { await endTree(group); }
  });
});

describe("ending a process tree", () => {
  const base: TreeStop = { platform: "linux", graceMs: 40, confirmMs: 40, exists: () => true, signal: () => undefined, taskkill: async () => 0 };

  it("AW-02 Windows startup cannot confirm a tree when the root disappears before taskkill", async () => {
    expect(await endTree(4242, { ...base, platform: "win32", exists: () => false, taskkill: async () => 128 }, { requireWindowsTreeKill: true })).toBe(false);
  });

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
