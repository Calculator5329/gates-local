// pnpm run app-update: update this clone of Gates Local. The steps and
// their words are in apps/server/src/update/ (cli.ts, apply.ts, check.ts);
// this file only wires them to this clone, the app's data folder, git and
// pnpm. It imports Node built-ins only, so it keeps working while
// node_modules is being replaced, and while going back after a failed step.
//
// Not named update, upgrade or up: those are pnpm's own commands, and
// `pnpm update` would rewrite the lockfile.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { serverDataDir } from "../apps/desktop/src/data-dir.ts";
import { readRunning } from "../apps/desktop/src/running.ts";
import { APPROVAL_DEADLINE_ENV } from "../apps/desktop/src/update-launch.ts";
import { createRelaunch } from "../apps/desktop/src/update-relaunch.ts";
import type { Pnpm } from "../apps/server/src/update/apply.ts";
import { runCli } from "../apps/server/src/update/cli.ts";
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

const relaunch = createRelaunch({ root, env });

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
  ...(env[APPROVAL_DEADLINE_ENV] === undefined ? {} : { approvalBeforeUptime: Number(env[APPROVAL_DEADLINE_ENV]) }),
});
