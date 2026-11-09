import { ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createSources } from "./index.ts";
import { createLibraryImports } from "./imports.ts";

const commands = vi.hoisted(() => ({ spawn: vi.fn(), execFile: vi.fn() }));
const identities = vi.hoisted(() => new Map<number, string | null>());
const tokens = vi.hoisted(() => new Map<number, string>());
vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(), ...commands }));
vi.mock("../update/wait.ts", async original => ({ ...await original<typeof import("../update/wait.ts")>(), isAlive: (pid: number) => identities.has(pid) }));
vi.mock("../runtime/ownership.ts", async original => ({
  ...await original<typeof import("../runtime/ownership.ts")>(),
  readWindowsProc: (pid: number) => identities.get(pid) == null ? undefined : ({ pid, startTime: identities.get(pid), command: identities.get(pid) === "start-" + pid ? "node git-worker.ts " + tokens.get(pid) : "node another-worker", state: "R" }),
}));
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const roots: string[] = [];
beforeEach(() => {
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  vi.useFakeTimers(); commands.spawn.mockReset(); commands.execFile.mockReset(); identities.clear(); tokens.clear();
});
afterEach(() => {
  Object.defineProperty(process, "platform", platform); vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup(timeoutMs = 10_000) {
  const dataDir = mkdtempSync(path.join(tmpdir(), "library-win-stop-")); roots.push(dataDir);
  const workers: ChildProcess[] = [];
  const starts: boolean[] = [];
  const kills: ((error: Error | null) => void)[] = [];
  commands.spawn.mockImplementation((_command: string, args: string[]) => {
    const worker = Object.assign(new ChildProcess(), { pid: 7000 + workers.length, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
    identities.set(worker.pid, "start-" + worker.pid);
    tokens.set(worker.pid, args[3]!);
    worker.stdin.on("data", () => {
      const folder = path.join(dataDir, "library-imports");
      starts.push(readdirSync(folder).filter(name => name.endsWith(".worker.json")).some(name => {
        const record: unknown = JSON.parse(readFileSync(path.join(folder, name), "utf8"));
        return typeof record === "object" && record !== null && "worker" in record && typeof record.worker === "object" && record.worker !== null && "pid" in record.worker && record.worker.pid === worker.pid;
      }));
    });
    workers.push(worker); queueMicrotask(() => worker.emit("spawn")); return worker;
  });
  commands.execFile.mockImplementation((_command: string, _args: string[], _options: unknown, done: (error: Error | null) => void) => { kills.push(done); return new ChildProcess(); });
  const imports = createLibraryImports({ sources: createSources({ dataDir }), timeoutMs });
  const managers = [imports];
  const start = (name: string) => imports.handlers["sources.clone"]({ url: `https://github.com/example/${name}` });
  const stop = async () => {
    for (const manager of managers) manager.close();
    for (const done of kills) done(new Error("Stopped fixture"));
    for (const worker of workers) worker.emit("close", 1);
    identities.clear();
    for (const manager of managers) for (const job of manager.snapshot().jobs) manager.handlers["sources.cancelImport"]({ id: job.id });
    await vi.waitFor(() => expect(managers.every(manager => manager.snapshot().jobs.every(job => ["error", "cancelled", "ready"].includes(job.state)))).toBe(true));
  };
  return { dataDir, workers, starts, kills, imports, managers, start, stop };
}

it.each(["cancel-error", "cancel-timeout", "timeout-error", "timeout-timeout"])("Windows %s retains staging and both slots until the worker closes (DF-01)", async scenario => {
  const s = setup(scenario.startsWith("timeout") ? 500 : 10_000);
  try {
    const jobs = [s.start("one"), s.start("two")];
    await vi.waitFor(() => expect(s.workers).toHaveLength(2));
    expect(s.starts).toEqual([true, true]);
    if (scenario.startsWith("cancel")) for (const job of jobs) s.imports.handlers["sources.cancelImport"]({ id: job.id });
    else await vi.advanceTimersByTimeAsync(500);
    expect(s.kills).toHaveLength(2);
    if (scenario.endsWith("error")) for (const done of s.kills) done(Object.assign(new Error("Access denied"), { code: 5 }));
    await vi.advanceTimersByTimeAsync(1100);
    expect(s.imports.snapshot().jobs.map(job => job.state)).toEqual(["cloning", "cloning"]);
    for (const job of s.imports.snapshot().jobs) expect(job.detail).toMatch(/could not be stopped/i);
    for (const job of jobs) expect(existsSync(path.join(s.dataDir, "library-imports", job.id))).toBe(true);
    expect(() => s.start("three")).toThrow(/2 imports/);
    // Root exit alone does not prove that descendants holding pipes have ended.
    for (const worker of s.workers) worker.emit("exit", 1, null);
    expect(() => s.start("three")).toThrow(/2 imports/);
    for (const worker of s.workers) worker.emit("close", 1);
    await vi.waitFor(() => expect(s.imports.snapshot().jobs.every(job => ["error", "cancelled"].includes(job.state))).toBe(true));
    for (const job of jobs) expect(existsSync(path.join(s.dataDir, "library-imports", job.id))).toBe(false);
    expect(() => s.start("three")).not.toThrow();
    await vi.waitFor(() => expect(s.workers).toHaveLength(3));
  } finally { await s.stop(); }
});

it("Windows successful taskkill waits for worker exit, then releases the slot without waiting for pipe close (DF-01)", async () => {
  const s = setup();
  try {
    const job = s.start("one"); await vi.waitFor(() => expect(s.workers).toHaveLength(1));
    s.imports.handlers["sources.cancelImport"]({ id: job.id }); s.kills[0]!(null);
    await vi.advanceTimersByTimeAsync(0);
    expect(s.imports.snapshot().jobs[0]!.state).toBe("cloning");
    expect(existsSync(path.join(s.dataDir, "library-imports", job.id))).toBe(true);
    s.workers[0]!.emit("exit", 1, null);
    await vi.waitFor(() => expect(s.imports.snapshot().jobs[0]!.state).toBe("cancelled"));
    expect(existsSync(path.join(s.dataDir, "library-imports", job.id))).toBe(false);
  } finally { await s.stop(); }
});

it("a Windows worker's broken start pipe still waits for confirmed termination", async () => {
  const s = setup();
  try {
    const job = s.start("one"); await vi.waitFor(() => expect(s.workers).toHaveLength(1));
    s.workers[0]!.stdin!.emit("error", Object.assign(new Error("Start pipe closed"), { code: "EPIPE" }));
    expect(s.kills).toHaveLength(1);
    s.kills[0]!(new Error("Access denied")); await vi.advanceTimersByTimeAsync(1100);
    expect(existsSync(path.join(s.dataDir, "library-imports", job.id))).toBe(true);
    expect(s.imports.snapshot().jobs[0]!.state).toBe("cloning");
  } finally { await s.stop(); }
});

it.each(["same", "unknown", "reused", "gone"])("restart preserves containment with a %s worker identity (DG-01)", async identity => {
  const s = setup();
  try {
    const jobs = [s.start("one"), s.start("two")];
    await vi.waitFor(() => expect(s.workers).toHaveLength(2));
    for (const job of jobs) s.imports.handlers["sources.cancelImport"]({ id: job.id });
    for (const done of s.kills) done(new Error("Access denied"));
    await vi.advanceTimersByTimeAsync(1100);
    for (const worker of s.workers) {
      if (identity === "gone") identities.delete(worker.pid!);
      else if (identity !== "same") identities.set(worker.pid!, identity === "unknown" ? null : "a different start");
    }
    const sources = createSources({ dataDir: s.dataDir });
    const next = createLibraryImports({ sources }); s.managers.push(next);
    const clone = (name: string) => next.handlers["sources.clone"]({ url: `https://github.com/example/${name}` });
    if (identity === "same" || identity === "unknown") {
      expect(next.activity().toSorted()).toEqual(jobs.map(job => `Import: ${job.label}`).toSorted());
      for (const job of jobs) expect(existsSync(path.join(s.dataDir, "library-imports", job.id))).toBe(true);
      expect(next.snapshot().jobs.map(job => job.key)).toEqual(expect.arrayContaining(jobs.map(job => job.key)));
      expect(next.snapshot().jobs).toHaveLength(2);
      for (const job of next.snapshot().jobs) expect(job.detail).toMatch(/restart Windows/i);
      expect(() => clone("three")).toThrow(/2 imports/);
      // Once identity can be checked again, a gone process frees both old slots.
      identities.clear();
      next.handlers["sources.cancelImport"]({ id: jobs[0]!.id });
    }
    for (const job of jobs) expect(existsSync(path.join(s.dataDir, "library-imports", job.id))).toBe(false);
    expect(next.activity()).toEqual([]);
    expect(commands.execFile).toHaveBeenCalledTimes(2); // Recovery never kills a saved or recycled PID.
    expect(() => clone("three")).not.toThrow(); expect(() => clone("four")).not.toThrow();
    await vi.waitFor(() => expect(s.workers).toHaveLength(4));
  } finally { await s.stop(); }
});
