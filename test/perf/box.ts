import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import { chromium } from "@playwright/test";
import { ROOT } from "../e2e/env.ts";
import { limitEnv, limited, type Limit } from "./limits.ts";
import type { ownProcesses } from "./processes.ts";

function isGone(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
function scopeMembers(file: string): string {
  try { return readFileSync(file, "utf8").trim(); } catch (error) { if (isGone(error)) return ""; throw error; }
}

/** Preserve Playwright's default headless shell when interposing the launcher. */
function headlessBrowser(): string {
  if (process.env["GATES_LOCAL_CHROMIUM"]) return process.env["GATES_LOCAL_CHROMIUM"];
  if (existsSync("/usr/bin/chromium")) return "/usr/bin/chromium";
  const bundled = chromium.executablePath();
  const shell = bundled.replace(/chromium-(\d+)\/chrome-linux64\/chrome$/, "chromium_headless_shell-$1/chrome-headless-shell-linux64/chrome-headless-shell");
  if (shell === bundled || !existsSync(shell)) throw new Error("Install Playwright's chromium headless shell before a limited comparison");
  return shell;
}

/** The helper CPUs never overlap the app's first N CPUs. */
export function helperCpus(limit: Limit, cores = availableParallelism()): string {
  if (limit.cores >= cores) throw new Error(`Limit ${limit.spec} leaves no cores for the performance helpers`);
  return Array.from({ length: cores - limit.cores }, (_, i) => String(limit.cores + i)).join(",");
}

/** Own the keeper and sampler until the entire limited arm has stopped. */
export async function performanceBox(processes: ReturnType<typeof ownProcesses>, limit: Limit, everything: boolean, out: string, report: string, signal: AbortSignal) {
  const others = helperCpus(limit);
  const env = { ...limitEnv(process.env), GL_PERF_OUT: out, GL_PERF_ACCOUNTING: "1", GL_PERF_HARNESS: ROOT, GL_PERF_NODE: process.execPath,
    GL_PERF_HELPER_CPUS: others, GL_PERF_APP_CORES: String(limit.cores), GL_PERF_APP_GROUP: "", GL_PERF_BROWSER: "" };
  let keeper: ReturnType<typeof processes.spawn> | undefined;
  let sampler: ReturnType<typeof processes.spawn> | undefined;
  async function stopScope(marker: string) {
    const file = path.join(out, marker);
    if (!existsSync(file)) return;
    const group = readFileSync(file, "utf8").trim();
    const members = path.join(group, "cgroup.procs");
    if (!scopeMembers(members)) return;
    try { writeFileSync(path.join(group, "cgroup.kill"), "1"); } catch (error) { if (!isGone(error)) throw error; }
    const deadline = Date.now() + 2_000;
    while (scopeMembers(members)) {
      if (Date.now() >= deadline) throw new Error("Owned performance scope did not stop");
      await setTimeout(20);
    }
  }
  const close = async () => {
    // Playwright can detach children into their own process groups. The
    // two scopes contain only this arm, including the moved GPU helper.
    const errors: unknown[] = [];
    for (const stop of [() => sampler && processes.stop(sampler), () => keeper && processes.stop(keeper), () => stopScope("helpers.path"), () => stopScope("box.path")]) {
      try { await stop(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, "Performance box cleanup failed");
  };
  try {
    if (!everything) {
      env.GL_PERF_BROWSER = headlessBrowser();
      const groupFile = path.join(out, "box.path");
      const [file, ...args] = limited(limit, ["python3", path.join(ROOT, "test/perf/placement.py"), "hold", groupFile], report);
      keeper = processes.spawn(file!, args, { cwd: ROOT, env, detached: true, stdio: "inherit" });
      let failure: Error | undefined;
      keeper.once("error", error => { failure = error; });
      const deadline = Date.now() + 10_000;
      while (!existsSync(groupFile)) {
        signal.throwIfAborted();
        if (failure) throw failure;
        if (Date.now() > deadline || keeper.exitCode !== null) throw new Error("The limited app box did not start");
        await setTimeout(20);
      }
      env.GL_PERF_APP_GROUP = readFileSync(groupFile, "utf8").trim();
    }
    sampler = processes.spawn("python3", [path.join(ROOT, "test/perf/cpu-sample.py"), String(process.pid), path.join(out, "cpu.jsonl"), others], { cwd: ROOT, env, detached: true, stdio: "inherit" });
    const sampling = sampler;
    let sampleError: Error | undefined;
    sampling.once("error", error => { sampleError = error; });
    return {
      env,
      command(args: readonly string[]): string[] {
        const driver = ["python3", path.join(ROOT, "test/perf/placement.py"), "driver", ...args];
        return everything ? limited(limit, driver, report) : ["taskset", "-c", others, "systemd-run", "--user", "--scope", "--quiet", "--collect", "--", ...driver];
      },
      async close() {
        const failed = sampleError ?? (sampling.exitCode !== null ? new Error(`Performance sampler exited ${sampling.exitCode}`) : undefined);
        await close();
        if (failed) throw failed;
      },
    };
  } catch (error) { await close(); throw error; }
}
