// The detached updater's desktop launch and owned-process cleanup. Node built-ins only.
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import type { Relaunch } from "../../server/src/update/cli.ts";
import { createProcessRecorder, startOf, treeGone, type ProcessRecord } from "../../server/src/update/identity.ts";
import { endTree, type EndTreeOptions } from "../../server/src/update/run.ts";
import { STARTUP_TOKEN_ENV, type StartupProcess } from "../../server/src/update/startup.ts";
import { relaunchEnv } from "./update-launch.ts";

export interface RelaunchDeps {
  root: string;
  env: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  spawn?: (file: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
  record?: (pid: number) => ProcessRecord;
  gone?: (owned: ProcessRecord) => boolean;
  startOf?: (pid: number) => string | null;
  stopTree?: (pid: number, options?: EndTreeOptions) => Promise<boolean>;
}

/** Re-resolve this clone's install on every attempt, including the restored version. */
export function createRelaunch(deps: RelaunchDeps) {
  const recordProcess = deps.record ?? createProcessRecorder({ platform: deps.platform ?? process.platform });
  return async ({ cwd, args, startup, onStart }: Relaunch): Promise<StartupProcess> => {
    // require() and its path resolution both retain modules across installs.
    // Resolve the dependency link and Electron's path.txt through the filesystem
    // on every launch, including after rollback replaced that link.
    const folder = realpathSync(path.join(deps.root, "apps", "desktop", "node_modules", "electron"));
    const binary = readFileSync(path.join(folder, "path.txt"), "utf8").trim();
    const electron = path.join(deps.env["ELECTRON_OVERRIDE_DIST_PATH"] || path.join(folder, "dist"), binary);
    if (binary === "" || !existsSync(electron)) throw new Error("Electron is not installed in this clone");
    const env = relaunchEnv(deps.env);
    delete env[STARTUP_TOKEN_ENV];
    if (startup !== undefined) env[STARTUP_TOKEN_ENV] = startup.token;
    const child = (deps.spawn ?? spawn)(electron, [...args], { cwd, env, detached: true, stdio: "ignore" });
    child.on("error", () => undefined);
    const pid = child.pid;
    if (pid === undefined) throw new Error("Electron did not start");
    const owned = recordProcess(pid);
    const stopTree = deps.stopTree ?? ((ownedPid: number, options?: EndTreeOptions) => endTree(ownedPid, undefined, options));
    const stop = () => {
      if ((deps.platform ?? process.platform) === "win32") {
        // A dead/reused root says nothing about surviving descendants. Never
        // signal a recycled PID or certify its helpers from that observation.
        if (owned.start === null || (deps.startOf ? deps.startOf(pid) : startOf(pid, "win32")) !== owned.start) return Promise.resolve(false);
        // A small PID-reuse window remains between this lookup and taskkill.
        return stopTree(pid, { requireWindowsTreeKill: true });
      }
      const gone = (deps.gone ?? treeGone)(owned);
      return gone ? Promise.resolve(true) : stopTree(pid);
    };
    child.unref();
    try { onStart?.(pid); }
    catch (error) {
      const stopped = await stop();
      if (!stopped) throw Object.assign(new Error("Could not save or stop the new app's startup"), { treeStillRunning: true });
      throw error;
    }
    return { pid, stop };
  };
}
