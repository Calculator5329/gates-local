import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkOwnership, readProc, readRecord, stopOwned, writeRecord } from "./ownership.ts";
import { removeDir, tmpDir } from "./test-fakes.ts";

let work: string;
let file: string;
const children: ChildProcess[] = [];

function sleeper(): ChildProcess {
  const c = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  children.push(c);
  return c;
}

const alive = (pid: number) => readProc(pid) !== undefined;

async function waitFor(pred: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!pred() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  return pred();
}

beforeEach(() => {
  work = tmpDir("own");
  file = path.join(work, "owned-ollama.json");
});

afterEach(() => {
  for (const c of children.splice(0)) c.kill("SIGKILL");
  removeDir(work);
});

function recordFor(pid: number, over: { startTime?: string; command?: string } = {}) {
  const p = readProc(pid);
  if (!p) throw new Error(`no /proc entry for ${pid}`);
  writeRecord(file, {
    pid,
    startTime: over.startTime ?? p.startTime,
    command: over.command ?? p.command,
    baseUrl: "http://127.0.0.1:1",
    binary: "/fake/ollama",
    startedAt: Date.now(),
  });
}

describe("readProc", () => {
  it("reads this process's start time and command line", () => {
    const me = readProc(process.pid);
    // Linux: clock ticks from /proc/<pid>/stat. Windows: CIM's CreationDate, an opaque string with the time in it.
    expect(me?.startTime).toMatch(process.platform === "win32" ? /\d{6,}/ : /^\d+$/);
    expect(me?.command).toContain("node");
  });

  it("returns undefined for a PID that does not exist", () => {
    expect(readProc(2 ** 22 + 7)).toBeUndefined();
  });
});

describe("stopOwned", () => {
  // Windows never stops a process by PID number (R-12): runtime.ts stops its own child through the handle.
  it.runIf(process.platform === "win32")("on Windows adopts a matching live record and leaves the process running", async () => {
    const c = sleeper();
    await waitFor(() => alive(c.pid!));
    recordFor(c.pid!);
    expect(checkOwnership(file).kind).toBe("ours");
    expect(await stopOwned(file, 500)).toEqual({ stopped: false, reason: "adopted" });
    expect(alive(c.pid!)).toBe(true);
    expect(c.exitCode).toBeNull();
  });

  it.skipIf(process.platform === "win32")("stops a process whose PID, start time and command all match the record", async () => {
    const c = sleeper();
    await waitFor(() => alive(c.pid!));
    recordFor(c.pid!);
    expect(checkOwnership(file).kind).toBe("ours");
    const r = await stopOwned(file, 2000);
    expect(r).toEqual({ stopped: true, pid: c.pid });
    expect(await waitFor(() => !alive(c.pid!))).toBe(true);
    expect(existsSync(file)).toBe(false);
  });

  it("refuses a recorded PID now running a different command, and leaves it running", async () => {
    const c = sleeper();
    await waitFor(() => alive(c.pid!));
    recordFor(c.pid!, { command: "/home/someone/.local/share/gates-local/runtime/ollama/0.40.15/bin/ollama serve" });
    const r = await stopOwned(file, 500);
    expect(r.stopped).toBe(false);
    expect(r.stopped === false && r.reason).toBe("not-ours");
    await new Promise((res) => setTimeout(res, 200));
    expect(alive(c.pid!)).toBe(true);
    expect(c.exitCode).toBeNull();
    expect(c.signalCode).toBeNull();
    expect(readRecord(file)).toBeUndefined();
  });

  it("refuses a recorded PID with a different start time (PID reuse), and leaves it running", async () => {
    const c = sleeper();
    await waitFor(() => alive(c.pid!));
    const real = readProc(c.pid!)!.startTime;
    recordFor(c.pid!, { startTime: String(Number(real) - 1) });
    const r = await stopOwned(file, 500);
    expect(r.stopped === false && r.reason).toBe("not-ours");
    await new Promise((res) => setTimeout(res, 200));
    expect(alive(c.pid!)).toBe(true);
    expect(c.signalCode).toBeNull();
  });

  it("reports a recorded process that has exited as gone", async () => {
    const c = sleeper();
    await waitFor(() => alive(c.pid!));
    recordFor(c.pid!);
    c.kill("SIGKILL");
    await waitFor(() => !alive(c.pid!));
    expect(await stopOwned(file, 500)).toEqual({ stopped: false, reason: "gone" });
  });

  it("does nothing without a record", async () => {
    expect(await stopOwned(file)).toEqual({ stopped: false, reason: "no-record" });
  });
});
