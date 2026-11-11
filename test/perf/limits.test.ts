import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { limitEnv, limited, parseLimit, readLimit } from "./limits.ts";

test("a limit names cores, an optional speed and optional memory, and refuses anything else", () => {
  expect(parseLimit("2c-2g")).toEqual({ spec: "2c-2g", cores: 2, speed: null, memoryMb: 2048 });
  expect(parseLimit("1c-512m")).toEqual({ spec: "1c-512m", cores: 1, speed: null, memoryMb: 512 });
  expect(parseLimit("2c")).toEqual({ spec: "2c", cores: 2, speed: null, memoryMb: null });
  expect(parseLimit("1c50-2g")).toEqual({ spec: "1c50-2g", cores: 1, speed: 50, memoryMb: 2048 });
  expect(parseLimit("2c25")).toEqual({ spec: "2c25", cores: 2, speed: 25, memoryMb: null });
  for (const bad of ["", "2", "0c-1g", "2c-0g", "2c-2", "2g", "2c-2g-x", "2c0-1g", "2c100-1g", "2c05"]) expect(() => parseLimit(bad)).toThrow("Unknown limit");
});

test.skipIf(process.platform !== "linux")("a limit that would not shrink this machine is refused", () => {
  expect(() => limited(parseLimit("6c-2g"), ["true"], "unused", 6)).toThrow("nothing would be limited");
});

// Needs a user systemd with the memory controller, as on the test machine and a Linux desktop.
const env = limitEnv(process.env);
const boxes = process.platform === "linux"
  && spawnSync("systemd-run", ["--user", "--scope", "--quiet", "--collect", "-p", "MemoryMax=64M", "true"], { env }).status === 0;

// A scheduler loaded through sched_ext may hand out time its own way and not
// hold a box to its speed limit; the kernel's own scheduler does.
const scheduler = "/sys/kernel/sched_ext/state";
const holdsSpeed = !existsSync(scheduler) || readFileSync(scheduler, "utf8").trim() !== "enabled";
const allocate = "const held = []; for (let i = 0; i < 16; i++) held.push(Buffer.alloc(32 << 20, 1))";

test.skipIf(!boxes)("the box pins cores, slows them, kills past the memory ceiling, keeps the exit code and reports", () => {
  const cache = path.join(homedir(), ".cache", "gates-local-perf-test"); mkdirSync(cache, { recursive: true });
  const directory = mkdtempSync(path.join(cache, "limits-"));
  const run = (spec: string, script: string, name: string) => {
    const report = path.join(directory, name);
    const [file, ...args] = limited(parseLimit(spec), [process.execPath, "-e", script], report);
    const result = spawnSync(file!, args, { env, encoding: "utf8" });
    return { status: result.status, signal: result.signal, stdout: result.stdout.trim(), reading: readLimit(report) };
  };
  try {
    const small = run("1c-256m", "console.log(require('node:os').availableParallelism()); process.exitCode = 7", "small");
    expect(small).toMatchObject({ status: 7, stdout: "1", reading: { oomKills: 0 } });
    expect(small.reading.peakMb).toBeGreaterThan(0);
    expect(small.reading.peakMb).toBeLessThan(256);

    // What the kernel was told, read from inside: 2.5 ms of every 5 ms on one core.
    const quota = "const fs = require('node:fs'); const box = '/sys/fs/cgroup' + fs.readFileSync('/proc/self/cgroup', 'utf8').trim().split(':')[2];"
      + " for (const end = Date.now() + 300; Date.now() < end;); console.log(fs.existsSync(box + '/cpu.max') ? fs.readFileSync(box + '/cpu.max', 'utf8').trim() : 'no limit file')";
    const slow = run("1c50-256m", quota, "slow");
    expect(slow).toMatchObject({ status: 0, stdout: "2500 5000" });
    expect(slow.reading.cpuSeconds).toBeGreaterThan(0);
    if (holdsSpeed) expect(slow.reading.heldBackSeconds).toBeGreaterThan(0);
    expect(run("2c50-256m", quota, "two").stdout).toBe("5000 5000");
    // A box with no speed limit has no quota, or on some machines no quota file at all.
    const unslowed = run("1c-256m", quota, "unslowed");
    expect(unslowed).toMatchObject({ status: 0, reading: { heldBackSeconds: 0 } });
    expect(["max 100000", "no limit file"]).toContain(unslowed.stdout);

    // Stops at 512 MB on its own, so a box that failed to cap cannot eat the machine.
    const over = run("1c-256m", allocate, "over");
    expect(over.status).not.toBe(0);
    expect(over.reading.oomKills).toBeGreaterThan(0);
    expect(over.reading.peakMb).toBe(256);

    // The command itself survives the kill and would idle for 20 s; the box ends it.
    const idle = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(allocate)}], { stdio: 'ignore' }); setTimeout(() => process.exit(9), 20_000)`;
    const started = Date.now();
    const ended = run("1c-256m", idle, "ended");
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(ended).toMatchObject({ status: null, signal: "SIGKILL" });
    expect(ended.reading.oomKills).toBeGreaterThan(0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test.skipIf(!boxes)("a stop reaches the command, and the box waits for it to finish before reporting", async () => {
  const cache = path.join(homedir(), ".cache", "gates-local-perf-test"); mkdirSync(cache, { recursive: true });
  const directory = mkdtempSync(path.join(cache, "limits-"));
  try {
    const report = path.join(directory, "stopped");
    // Ends by itself after 20 s, so a stop that never arrives leaves nothing running.
    const slowExit = "process.on('SIGTERM', () => setTimeout(() => process.exit(5), 200)); setTimeout(() => process.exit(9), 20_000); console.log('up')";
    const [file, ...args] = limited(parseLimit("1c-256m"), [process.execPath, "-e", slowExit], report);
    const child = spawn(file!, args, { env, stdio: ["ignore", "pipe", "inherit"] });
    try {
      await once(child.stdout, "data");
      child.kill("SIGTERM");
      const [status] = await once(child, "exit");
      expect(status).toBe(5);
      expect(readLimit(report).oomKills).toBe(0);
    } finally { child.stdout.destroy(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
