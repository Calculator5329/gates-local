// "Restart to update": how main starts the updater (scripts/update.ts)
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
import { randomUUID } from "node:crypto";
import { uptime } from "node:os";
import { HANDOFF_GRACE_MS } from "@gates-local/update/admission";
import { brokenForTest } from "@gates-local/update/break-for-test";
import { FINISH_TRIED_FLAG } from "@gates-local/update/checkout-start";
import { STARTUP_TOKEN_ENV } from "@gates-local/update/startup";
import { BACKGROUND_ENV, BACKGROUND_FLAG } from "./launch.ts";
import type { UpdateCommitRequest, UpdateCommitResult, UpdateInstallRequest } from "@gates-local/contracts";
import type { UpdateAndRestartResult } from "./bridge.ts";

export interface UpdaterLaunchInput {
  readonly approvedCommit?: string;
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

export const APPROVAL_DEADLINE_ENV = "GATES_LOCAL_UPDATE_APPROVAL_BEFORE_UPTIME";

/** Bound the detached wait before the server can reopen admission. Uptime is shared across processes; `nowUptime` is launchApprovedUpdate's `askedAt`. */
export function approvedHandoffEnv(env: NodeJS.ProcessEnv, nowUptime: number): NodeJS.ProcessEnv {
  return { ...env, [APPROVAL_DEADLINE_ENV]: String(nowUptime + HANDOFF_GRACE_MS / 1000) };
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

/**
 * The updater for an update a crash left, started by the app's own start
 * (checkout-start.ts): it finishes that update or takes it back and looks for
 * nothing new. Where the start cannot stay while files are replaced
 * (`quits`: Windows holds electron.exe), the updater waits for it to exit and
 * opens the app again, marked so that start says what is left instead of
 * trying a second time. Elsewhere the start stays, shows its window and
 * waits for this process to end.
 */
export function finisherLaunch(o: Omit<UpdaterLaunchInput, "approvedCommit"> & { readonly quits: boolean }): UpdaterLaunch {
  const appArgs = o.argv.slice(1).filter((a) => a !== FINISH_TRIED_FLAG);
  return {
    command: nodeCommand(o.env, o.exists),
    args: [
      path.join(o.repoRoot, "scripts", "update.ts"),
      "--finish",
      ...(o.quits ? ["--wait-pid", String(o.pid), "--restart"] : []),
      "--data-dir",
      o.dataDir,
      "--relaunch-cwd",
      o.cwd,
      ...[...appArgs, ...(o.quits ? [FINISH_TRIED_FLAG] : [])].map((a) => `--relaunch-arg=${a}`),
    ],
    cwd: o.repoRoot,
  };
}

/** What the person reads when the updater's process cannot be started at all. */
export const cannotStartUpdater = (why: string): string =>
  `The updater could not be started (${why}). Install Node 24 on your PATH, or run pnpm run app-update in the Gates Local folder.`;

/** The finisher's environment: no approval deadline and no startup token of an earlier update. */
export function finisherEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...env };
  delete next[APPROVAL_DEADLINE_ENV];
  delete next[STARTUP_TOKEN_ENV];
  return next;
}

export function updaterLaunch(o: UpdaterLaunchInput): UpdaterLaunch {
  // A background launch would come back with no window; the person clicked Update in one.
  // The mark of an earlier finish attempt belongs to that start alone.
  const appArgs = o.argv.slice(1).filter((a) => a !== BACKGROUND_FLAG && a !== FINISH_TRIED_FLAG);
  return {
    command: nodeCommand(o.env, o.exists),
    args: [
      path.join(o.repoRoot, "scripts", "update.ts"),
      "--wait-pid",
      String(o.pid),
      "--restart",
      "--data-dir",
      o.dataDir,
      ...(o.approvedCommit === undefined ? [] : ["--target-commit", o.approvedCommit]),
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
  delete next[APPROVAL_DEADLINE_ENV];
  return next;
}

/**
 * Wraps a start so overlapping calls share it, decided before the first await
 * (two IPC calls can both arrive before a spawn reports). A success stays, as
 * the app is quitting; a failure or a throw lets the next click try again.
 */
export function onceUntilFailed<R extends { readonly ok: boolean }, A extends readonly unknown[] = []>(start: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
  let current: Promise<R> | null = null;
  return (...args) => {
    current ??= start(...args).then(
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

export interface UpdateControl {
  commit(request: UpdateCommitRequest): Promise<UpdateCommitResult>;
  cancel(reservation: string): Promise<unknown>;
}

/**
 * What an approved target names: a clone's full commit, or an installed
 * copy's `<version>:<SHA-512 of the signed list>` (apps/server/src/update/installed/module.ts).
 */
export function targetKind(target: string): "commit" | "installed" | null {
  if (/^[a-f0-9]{40}$/.test(target)) return "commit";
  return /^\d+\.\d+\.\d+:[a-f0-9]{128}$/.test(target) ? "installed" : null;
}

export function validUpdateRequest(value: unknown): value is UpdateInstallRequest {
  return typeof value === "object" && value !== null && "reservation" in value && typeof value.reservation === "string" && value.reservation !== "" && "target" in value && typeof value.target === "string" && targetKind(value.target) !== null;
}

/**
 * Main validates the server reservation before spawning; every failed handoff
 * releases it. start gets the approved target and `askedAt`, the uptime read
 * before the server was asked to commit. The approval's deadline counts from
 * `askedAt`: the server counts its own wait from the moment main lets go,
 * which is later, so with the same length it never reopens before the deadline.
 */
export async function launchApprovedUpdate(
  request: UpdateInstallRequest, control: UpdateControl,
  start: (approvedTarget: string, askedAt: number) => Promise<UpdateAndRestartResult>,
  now: () => number = uptime,
): Promise<UpdateAndRestartResult> {
  let started = false;
  const release = randomUUID();
  let result: UpdateAndRestartResult;
  try {
    const askedAt = now();
    const committed = await control.commit({ ...request, release });
    if (!committed.accepted || committed.release !== release) result = { ok: false, message: "The update approval expired or changed. Check for updates again and review the target." };
    else { result = await start(request.target, askedAt); started = result.ok; }
  } catch {
    result = { ok: false, message: "Could not start the approved update. Gates Local is staying open; check for updates again to retry." };
  }
  if (!started || brokenForTest("cancel-after-a-good-start")) {
    try {
      // Either the commit was accepted (release) or it never happened
      // (reservation). Lost acknowledgements are safe in either case.
      await control.cancel(release);
      await control.cancel(request.reservation);
    } catch { result = { ok: false, message: "The update did not start, and its pause could not be released. Close and reopen Gates Local to resume work." }; }
  }
  return result;
}

/** Why "Restart to update" cannot start here, or null when it can. */
export function cannotUpdate(o: { readonly packaged: boolean; readonly repoRoot: string; readonly exists: (file: string) => boolean }): string | null {
  if (o.packaged) return "This installed copy of Gates Local cannot update itself yet. Download the new version from the release page.";
  if (!o.exists(path.join(o.repoRoot, "scripts", "update.ts")) || !o.exists(path.join(o.repoRoot, ".git"))) {
    return "This folder is not a git clone of Gates Local, so it cannot update itself.";
  }
  return null;
}
