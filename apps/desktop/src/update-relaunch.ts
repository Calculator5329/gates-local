import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import type { Relaunch } from "@gates-local/update/cli";
import { createProcessRecorder, startOf, treeGone, type ProcessRecord } from "@gates-local/update/identity";
import { endTree, type EndTreeOptions } from "@gates-local/update/run";
import { STARTUP_TOKEN_ENV, type StartupProcess } from "@gates-local/update/startup";
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

export function createRelaunch(deps: RelaunchDeps) {
  const recordProcess = deps.record ?? createProcessRecorder({ platform: deps.platform ?? process.platform });
  return async ({ cwd, args, startup, onStart }: Relaunch): Promise<StartupProcess> => {
    // external: Node's require() keeps modules and their resolved paths, so a rollback's new link is read here.
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
        if (owned.start === null || (deps.startOf ? deps.startOf(pid) : startOf(pid, "win32")) !== owned.start) return Promise.resolve(false);
        // external: Windows can still reuse this PID between the lookup above and taskkill.
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
