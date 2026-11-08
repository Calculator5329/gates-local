// "Update and restart": how main starts the updater (scripts/update.ts)
// before it quits. Pure, so it is tested without Electron.
//
// The updater runs on the `node` on PATH, never on Electron's own binary:
// the install may need to replace that binary, and on Windows a running
// electron.exe is locked. It gets this process's pid and waits for it to
// exit before it touches the clone, then opens the app again the way it was
// started: the same working folder and the same arguments after the
// Electron binary (`.` from `pnpm start`, the absolute app folder from the
// app-menu launcher), found again after the install so a new Electron
// version's path is used.
import path from "node:path";
import { BACKGROUND_ENV, BACKGROUND_FLAG } from "./launch.ts";

export interface UpdaterLaunchInput {
  /** The clone: apps/desktop/../.. */
  readonly repoRoot: string;
  readonly pid: number;
  readonly dataDir: string;
  /** process.argv of main: the Electron binary, then its arguments. */
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly exists: (file: string) => boolean;
}

export interface UpdaterLaunch {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
}

/**
 * pnpm sets npm_node_execpath for `pnpm start`, so the node that ran it is
 * used even when PATH lacks one (a version manager's shell setup); an app-menu
 * launch has no such variable and uses node on PATH.
 */
export function nodeCommand(env: NodeJS.ProcessEnv, exists: (file: string) => boolean): string {
  const fromPnpm = env["npm_node_execpath"];
  return fromPnpm !== undefined && fromPnpm !== "" && path.isAbsolute(fromPnpm) && exists(fromPnpm) ? fromPnpm : "node";
}

export function updaterLaunch(o: UpdaterLaunchInput): UpdaterLaunch {
  // A background launch would come back with no window; the person clicked Update in one.
  const appArgs = o.argv.slice(1).filter((a) => a !== BACKGROUND_FLAG);
  return {
    command: nodeCommand(o.env, o.exists),
    args: [
      path.join(o.repoRoot, "scripts", "update.ts"),
      "--wait-pid",
      String(o.pid),
      "--restart",
      "--data-dir",
      o.dataDir,
      "--relaunch-cwd",
      o.cwd,
      // One token each: as a separate word, a value like --disable-gpu reads as an option and stops the updater.
      ...appArgs.map((a) => `--relaunch-arg=${a}`),
    ],
    cwd: o.repoRoot,
  };
}

/**
 * The environment of the reopened app. A background start's variable would
 * bring it back with no window, the same as the flag above; a parent running
 * as Node must not turn Electron into Node.
 */
export function relaunchEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...env };
  delete next[BACKGROUND_ENV];
  delete next["ELECTRON_RUN_AS_NODE"];
  return next;
}

/**
 * Wraps a start so overlapping calls share it, decided before the first await
 * (two IPC calls can both arrive before a spawn reports). A success stays, as
 * the app is quitting; a failure or a throw lets the next click try again.
 */
export function onceUntilFailed<R extends { readonly ok: boolean }>(start: () => Promise<R>): () => Promise<R> {
  let current: Promise<R> | null = null;
  return () => {
    current ??= start().then(
      (r) => {
        if (!r.ok) current = null;
        return r;
      },
      (e: unknown) => {
        current = null;
        throw e;
      },
    );
    return current;
  };
}

/** Why "Update and restart" cannot start here, or null when it can. */
export function cannotUpdate(o: { readonly packaged: boolean; readonly repoRoot: string; readonly exists: (file: string) => boolean }): string | null {
  if (o.packaged) return "This copy of Gates Local was not run from a git clone, so it cannot update itself.";
  if (!o.exists(path.join(o.repoRoot, "scripts", "update.ts")) || !o.exists(path.join(o.repoRoot, ".git"))) {
    return "This folder is not a git clone of Gates Local, so it cannot update itself.";
  }
  return null;
}
