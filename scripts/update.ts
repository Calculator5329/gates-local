// pnpm run app-update: update this clone of Gates Local. The steps and
// their words are in apps/server/src/update/ (cli.ts, apply.ts, check.ts);
// this file only wires them to this clone, the app's data folder, git and
// pnpm. It imports Node built-ins only, so it keeps working while
// node_modules is being replaced, and while going back after a failed step.
//
// Not named update, upgrade or up: those are pnpm's own commands, and
// `pnpm update` would rewrite the lockfile.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";
import { serverDataDir } from "../apps/desktop/src/data-dir.ts";
import { readRunning } from "../apps/desktop/src/running.ts";
import type { Pnpm } from "../apps/server/src/update/apply.ts";
import { type Relaunch, runCli } from "../apps/server/src/update/cli.ts";
import { isAlive } from "../apps/server/src/update/wait.ts";

const root = path.resolve(import.meta.dirname, "..");
const env = process.env;

/**
 * The pnpm that ran this script when there is one (pnpm run sets
 * npm_execpath), else pnpm on PATH; on Windows that is pnpm.cmd, which only
 * runs through the shell.
 */
function pnpmCommand(): Pnpm {
  const exec = env["npm_execpath"];
  if (exec !== undefined && existsSync(exec) && /pnpm/i.test(path.basename(exec))) {
    if (/\.(c|m)?js$/i.test(exec)) return { command: process.execPath, prefix: [exec], shell: false };
    if (!/\.(cmd|bat)$/i.test(exec)) return { command: exec, prefix: [], shell: false };
  }
  return { command: "pnpm", prefix: [], shell: process.platform === "win32" };
}

/** Electron from this clone's install, found after the update so a new version's path is used. */
function relaunch({ cwd, args }: Relaunch): void {
  const electron = createRequire(path.join(root, "apps", "desktop", "package.json"))("electron") as unknown;
  if (typeof electron !== "string" || !existsSync(electron)) throw new Error("Electron is not installed in this clone");
  const childEnv = { ...env };
  delete childEnv["ELECTRON_RUN_AS_NODE"];
  const child = spawn(electron, [...args], { cwd, env: childEnv, detached: true, stdio: "ignore" });
  child.unref();
}

const defaultDataDir = serverDataDir({
  platform: process.platform,
  env,
  home: homedir(),
  // Electron's userData, which the data folder follows only when GATES_LOCAL_USER_DATA is set (and on macOS).
  userData: env["GATES_LOCAL_USER_DATA"] ?? path.join(homedir(), "Library", "Application Support", "gates-local"),
});

process.exitCode = await runCli({
  root,
  argv: process.argv.slice(2),
  defaultDataDir,
  pnpm: pnpmCommand(),
  appRunning: (dataDir) => readRunning(dataDir, isAlive),
  relaunch,
});
