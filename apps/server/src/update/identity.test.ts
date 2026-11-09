// Telling a process from a later one given the same number, and knowing when
// a saved command and all it started have ended.
import { spawn } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { type Exec, type ProcessRecord, processRecord, startOf, startTicks, treeGone } from "./identity.ts";
import { groupExists } from "./run.ts";

const saved: ProcessRecord = { pid: 4242, start: "when it began", uptime: 1000 };
const up = { uptime: () => 2000 };

describe("a process's start time", () => {
  it("reads the start time field of /proc, however odd the process name", () => {
    expect(startTicks("1234 (odd) name (x)) S 1 2 3 0 -1 4 5 6 7 8 9 10 11 12 20 0 1 0 987654 1000 2000")).toBe("987654");
  });

  it.runIf(process.platform === "linux")("is steady for one process and differs for another", async () => {
    expect(startOf(process.pid)).toMatch(/:\d+$/);
    expect(startOf(process.pid)).toBe(startOf(process.pid));
    const child = spawn("sleep", ["30"], { stdio: "ignore" });
    const exited = new Promise((resolve) => child.once("exit", resolve));
    expect(startOf(child.pid!)).not.toBeNull();
    expect(startOf(child.pid!)).not.toBe(startOf(process.pid));
    child.kill("SIGKILL");
    await exited;
    expect(startOf(child.pid!)).toBeNull();
  });

  it("asks ps on macOS and PowerShell on Windows, and says nothing when they fail", () => {
    const calls: Array<[string, readonly string[]]> = [];
    const answer = (text: string): Exec => (command, args) => {
      calls.push([command, args]);
      return text;
    };
    expect(startOf(7, "darwin", answer("Sat Nov  8 12:00:00 2026"))).toBe("Sat Nov  8 12:00:00 2026");
    expect(startOf(7, "win32", answer("133000000000000000"))).toBe("133000000000000000");
    expect(calls[0]).toEqual(["ps", ["-o", "lstart=", "-p", "7"]]);
    expect(calls[1]?.[0]).toBe("powershell.exe");
    expect(calls[1]?.[1].join(" ")).toContain("Get-Process -Id 7");
    expect(startOf(7, "darwin", answer(""))).toBeNull();
    expect(startOf(7, "win32", () => { throw new Error("no such process"); })).toBeNull();
  });
});

describe("whether a saved command has ended", () => {
  it("AW-04 legacy Windows records retain the uptime fallback without trusting root disappearance", () => {
    expect(treeGone(saved, { ...up, platform: "win32", exists: () => false, requireWholeWindowsTree: true })).toBe(false);
    expect(treeGone(saved, { ...up, platform: "win32", exists: () => true, startOf: () => "another root", requireWholeWindowsTree: true })).toBe(false);
    expect(treeGone(saved, { platform: "win32", uptime: () => 500, exists: () => false, requireWholeWindowsTree: true })).toBe(true);
  });
  it("AW-04 a later boot proves restart even when its uptime has passed the saved uptime", () => {
    const record = { ...saved, boot: "133000000000000000" };
    expect(treeGone(record, { ...up, platform: "win32", requireWholeWindowsTree: true, bootTime: () => "133000100000000000" })).toBe(true);
    for (const boot of ["133000000000000000", "132999900000000000", "invalid", null]) {
      expect(treeGone(record, { ...up, platform: "win32", requireWholeWindowsTree: true, bootTime: () => boot })).toBe(false);
    }
    expect(treeGone(saved, { ...up, platform: "win32", requireWholeWindowsTree: true, bootTime: () => "133000100000000000" })).toBe(false);
  });

  it("AW-04 records Windows boot evidence with the process for later recovery", () => {
    expect(processRecord(4242, { platform: "win32", startOf: () => "owned-start", uptime: () => 1000, bootTime: () => "133000000000000000" })).toEqual({ pid: 4242, start: "owned-start", uptime: 1000, boot: "133000000000000000" });
  });
  it("not while the group is there and its leader is the same process", () => {
    expect(treeGone(saved, { ...up, exists: () => true, startOf: () => "when it began" })).toBe(false);
  });

  it("not while the group is there with its leader gone, or a start time that cannot be read", () => {
    expect(treeGone(saved, { ...up, exists: () => true, startOf: () => null })).toBe(false);
    expect(treeGone({ ...saved, start: null }, { ...up, exists: () => true, startOf: () => "anything" })).toBe(false);
  });

  it("once the group is gone", () => {
    expect(treeGone(saved, { ...up, exists: () => false })).toBe(true);
  });

  it("when the number now belongs to a process that started at another time", () => {
    expect(treeGone(saved, { ...up, exists: () => true, startOf: () => "just now" })).toBe(true);
  });

  it("after the computer restarted, whatever has that number now", () => {
    expect(treeGone(saved, { uptime: () => 500, exists: () => true, startOf: () => "when it began" })).toBe(true);
  });

  it.skipIf(process.platform === "win32")("a real group: there, then ended", async () => {
    const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
    const record = processRecord(child.pid!);
    expect(treeGone(record)).toBe(false);
    process.kill(-child.pid!, "SIGKILL");
    await vi.waitFor(() => expect(groupExists(child.pid!)).toBe(false), { timeout: 5000, interval: 25 });
    expect(treeGone(record)).toBe(true);
  });
});
