import { ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createSources } from "./index.ts";
import { createLibraryImports } from "./imports.ts";

const commands = vi.hoisted(() => ({ spawn: vi.fn(), execFile: vi.fn() }));
vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(), ...commands }));
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const roots: string[] = [];
beforeEach(() => {
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  vi.useFakeTimers(); commands.spawn.mockReset(); commands.execFile.mockReset();
});
afterEach(() => {
  Object.defineProperty(process, "platform", platform); vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup(timeoutMs = 10_000) {
  const dataDir = mkdtempSync(path.join(tmpdir(), "library-win-stop-")); roots.push(dataDir);
  const workers: ChildProcess[] = [];
  const kills: ((error: Error | null) => void)[] = [];
  commands.spawn.mockImplementation(() => {
    const worker = Object.assign(new ChildProcess(), { pid: 7000 + workers.length, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
    workers.push(worker); queueMicrotask(() => worker.emit("spawn")); return worker;
  });
  commands.execFile.mockImplementation((_command: string, _args: string[], _options: unknown, done: (error: Error | null) => void) => { kills.push(done); return new ChildProcess(); });
  const imports = createLibraryImports({ sources: createSources({ dataDir }), timeoutMs });
  const start = (name: string) => imports.handlers["sources.clone"]({ url: `https://github.com/example/${name}` });
  const stop = async () => {
    imports.close();
    for (const done of kills) done(new Error("Stopped fixture"));
    for (const worker of workers) worker.emit("close", 1);
    await vi.waitFor(() => expect(imports.snapshot().jobs.every(job => ["error", "cancelled", "ready"].includes(job.state))).toBe(true));
  };
  return { dataDir, workers, kills, imports, start, stop };
}

it.each(["cancel-error", "cancel-timeout", "timeout-error", "timeout-timeout"])("Windows %s retains staging and both slots until the worker closes (DF-01)", async scenario => {
  const s = setup(scenario.startsWith("timeout") ? 500 : 10_000);
  try {
    const jobs = [s.start("one"), s.start("two")];
    await vi.waitFor(() => expect(s.workers).toHaveLength(2));
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
