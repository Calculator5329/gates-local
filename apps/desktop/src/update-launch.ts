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
  readonly repoRoot: string;
  readonly pid: number;
  readonly dataDir: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly exists: (file: string) => boolean;
}

export const APPROVAL_DEADLINE_ENV = "GATES_LOCAL_UPDATE_APPROVAL_BEFORE_UPTIME";

// external: Node's os.uptime() is the machine's, so the detached updater and the server read the same clock.
export function approvedHandoffEnv(env: NodeJS.ProcessEnv, nowUptime: number): NodeJS.ProcessEnv {
  return { ...env, [APPROVAL_DEADLINE_ENV]: String(nowUptime + HANDOFF_GRACE_MS / 1000) };
}

export interface UpdaterLaunch {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
}

// external: Windows locks a running electron.exe and an install may replace it, so the updater runs on Node.
export function nodeCommand(env: NodeJS.ProcessEnv, exists: (file: string) => boolean): string {
  const fromPnpm = env["npm_node_execpath"];
  return fromPnpm !== undefined && fromPnpm !== "" && path.isAbsolute(fromPnpm) && exists(fromPnpm) ? fromPnpm : "node";
}

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

export const cannotStartUpdater = (why: string): string =>
  `The updater could not be started (${why}). Install Node 24 on your PATH, or run pnpm run app-update in the Gates Local folder.`;

export function finisherEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...env };
  delete next[APPROVAL_DEADLINE_ENV];
  delete next[STARTUP_TOKEN_ENV];
  return next;
}

export function updaterLaunch(o: UpdaterLaunchInput): UpdaterLaunch {
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
      ...appArgs.map((a) => `--relaunch-arg=${a}`),
    ],
    cwd: o.repoRoot,
  };
}

export function relaunchEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...env };
  delete next[BACKGROUND_ENV];
  delete next["ELECTRON_RUN_AS_NODE"];
  delete next[APPROVAL_DEADLINE_ENV];
  return next;
}

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

export function targetKind(target: string): "commit" | "installed" | null {
  if (/^[a-f0-9]{40}$/.test(target)) return "commit";
  return /^\d+\.\d+\.\d+:[a-f0-9]{128}$/.test(target) ? "installed" : null;
}

export function validUpdateRequest(value: unknown): value is UpdateInstallRequest {
  return typeof value === "object" && value !== null && "reservation" in value && typeof value.reservation === "string" && value.reservation !== "" && "target" in value && typeof value.target === "string" && targetKind(value.target) !== null;
}

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
      await control.cancel(release);
      await control.cancel(request.reservation);
    } catch { result = { ok: false, message: "The update did not start, and its pause could not be released. Close and reopen Gates Local to resume work." }; }
  }
  return result;
}

export function cannotUpdate(o: { readonly packaged: boolean; readonly repoRoot: string; readonly exists: (file: string) => boolean }): string | null {
  if (o.packaged) return "This installed copy of Gates Local cannot update itself yet. Download the new version from the release page.";
  if (!o.exists(path.join(o.repoRoot, "scripts", "update.ts")) || !o.exists(path.join(o.repoRoot, ".git"))) {
    return "This folder is not a git clone of Gates Local, so it cannot update itself.";
  }
  return null;
}
