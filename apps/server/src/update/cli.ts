// `pnpm run app-update`: the command line around runUpdate, written for
// someone who has never used git. scripts/update.ts wires it to this clone,
// the app's data folder and the real git and pnpm.
//
//   pnpm run app-update                 update now (the app must be closed)
//   pnpm run app-update --check         say what an update would bring; change nothing
//   pnpm run app-update --channel main  every change on the branch, not only releases
//
// The desktop app's "Update and restart" starts this detached with
// --wait-pid <its pid> --restart: the command waits for the app to exit,
// updates, writes the result for the app's next start and opens the app
// again with --relaunch-cwd and the --relaunch-arg list it was given.
import { closeSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeSync } from "node:fs";
import path from "node:path";
import { uptime } from "node:os";
import { parseArgs } from "node:util";
import { type Pnpm, type Refusal, type UpdateRun, STEP_WORDS, runUpdate } from "./apply.ts";
import type { ChannelChoice, Inspection } from "./check.ts";
import { UpdateGuardError } from "./guard.ts";
import { type UpdateRecord, writeRecord } from "./record.ts";
import { realRunner, type Runner } from "./run.ts";
import { waitForExit } from "./wait.ts";
import { waitForStartup, type StartupProcess } from "./startup.ts";

export const REPO_URL = "https://github.com/Calculator5329/gates-local.git";
/** How long the detached updater waits for the app to close. */
export const CLOSE_WAIT_MS = 60_000;
const KEEP_LOGS = 10;

export interface Relaunch {
  readonly cwd: string;
  readonly args: readonly string[];
  readonly startup?: { readonly token: string; readonly commit: string };
  readonly onStart?: (pid: number) => void;
}

export interface CliDeps {
  readonly root: string;
  readonly argv: readonly string[];
  /** The app's data folder when --data-dir is not given (the desktop's default). */
  readonly defaultDataDir: string;
  readonly pnpm: Pnpm;
  readonly runner?: Runner;
  /** The running app from the pid file in this data folder, or null. */
  readonly appRunning: (dataDir: string) => { readonly pid: number; readonly file: string } | null;
  /** Opens the app again; throws when it cannot. */
  readonly relaunch: (spec: Relaunch) => StartupProcess | void | Promise<StartupProcess | void>;
  readonly alive?: (pid: number) => boolean;
  readonly print?: (line: string) => void;
  readonly now?: () => number;
  readonly platform?: NodeJS.Platform;
  readonly closeWaitMs?: number;
  readonly startupTimeoutMs?: number;
  readonly approvalBeforeUptime?: number;
  readonly uptime?: () => number;
}

const USAGE = [
  "Usage: pnpm run app-update [--check] [--channel main|release]",
  "",
  "  --check            say what an update would bring; change nothing",
  "  --channel main     take every change on the branch, not only releases",
  "  --channel release  take only releases (the newest v1.2.3 tag)",
  "  --data-dir <dir>   the app's data folder, if you set GATES_LOCAL_DATA_DIR",
  "",
  "Without --channel it follows releases once there are any, and every change",
  "until then, unless Settings says to get every change.",
].join("\n");

/** The channel from --channel, else the Settings switch in settings.json, else auto. */
export function channelChoice(flag: string | undefined, dataDir: string): ChannelChoice | Error {
  if (flag !== undefined) return flag === "main" || flag === "release" ? flag : new Error(`--channel must be main or release, not "${flag}"`);
  try {
    const file = JSON.parse(readFileSync(path.join(dataDir, "settings.json"), "utf8")) as { settings?: { updateEveryChange?: unknown } };
    return file.settings?.updateEveryChange === true ? "main" : "auto";
  } catch {
    return "auto";
  }
}

const stamp = (ms: number) => new Date(ms).toISOString().replace(/[:.]/g, "-");

function openLog(dataDir: string, now: number): { file: string; write: (chunk: string) => void; close: () => void } {
  const dir = path.join(dataDir, "update-logs");
  mkdirSync(dir, { recursive: true });
  // Only the newest few logs stay.
  const old = readdirSync(dir).filter((f) => f.endsWith(".log")).toSorted();
  for (const f of old.slice(0, Math.max(0, old.length - (KEEP_LOGS - 1)))) rmSync(path.join(dir, f), { force: true });
  const file = path.join(dir, `${stamp(now)}.log`);
  const fd = openSync(file, "a");
  return {
    file,
    write: (chunk) => {
      try {
        writeSync(fd, chunk);
      } catch {
        // A full disk must not stop the update half way.
      }
    },
    close: () => closeSync(fd),
  };
}

function listed(files: readonly string[]): string[] {
  return [...files.slice(0, 20).map((f) => `  ${f}`), ...(files.length > 20 ? [`  …and ${files.length - 20} more`] : [])];
}

const BY_HAND = "close Gates Local, then git pull, pnpm install, pnpm start.";

function changedLines(r: Extract<Refusal, { reason: "changed-during-update" }>): string[] {
  if (r.changed === "branch") return ["This copy was switched to another branch while the update ran."];
  if (r.changed === "commit") return ["The commit this copy is on changed while the update ran."];
  return ["These files changed while the update ran:", ...listed(r.files)];
}

/** The plain-language lines for a refusal; the last says nothing was changed where that is true. */
export function refusalLines(r: Refusal): string[] {
  switch (r.reason) {
    case "target-changed":
      return [`The update target changed. You approved ${r.approved}, but the target is now ${r.target.label} (${r.target.commit}).`, "Nothing was installed. Check for updates again and review the new target before approving it."];
    case "no-git":
      return ["Git was not found. Gates Local updates itself with git.", "Install it from https://git-scm.com/downloads, open a new terminal and try again."];
    case "not-a-clone":
      return ["This folder is not a git clone of Gates Local, so it cannot update itself.", `Get a fresh copy with: git clone ${REPO_URL}`];
    case "no-upstream":
      return [r.detail, "Nothing was changed. Switch back to the main branch with `git switch main` and try again."];
    case "local-changes":
      return [
        "These files have changes that are not saved in git:",
        ...listed(r.files),
        "Nothing was changed.",
        "To keep your changes and update: run `git stash`, run the update again, then `git stash pop`.",
      ];
    case "remote":
      return ["Could not reach the place this copy was downloaded from. Check the internet connection and try again.", `Git said: ${r.detail}`];
    case "local-commits":
      return [
        `This copy has ${r.count === 1 ? "a commit" : `${r.count} commits`} of its own that the update does not have:`,
        ...r.subjects.map((s) => `  - ${s}`),
        ...(r.count > r.subjects.length ? [`  …and ${r.count - r.subjects.length} more`] : []),
        "Nothing was changed: the updater never merges or resets over your own commits.",
        'To keep them on a branch and update: git branch my-changes, then git reset --keep "@{upstream}", then run the update again.',
      ];
    case "no-releases":
      return ["There are no releases yet. Run `pnpm run app-update --channel main` to get the newest changes."];
    case "diverged":
      return [`The newest release (${r.target}) is not on this copy's branch, so updating to it would go backwards.`, "Nothing was changed. Run `pnpm run app-update --channel main` to get every change instead."];
    case "app-running":
      return [
        `Gates Local is running (process ${r.pid}). Close it, then run this again.`,
        "Nothing was changed. On Windows a running app keeps its own files locked, so updating it now would stop half way.",
        `If Gates Local is already closed, delete ${r.file} and try again.`,
      ];
    case "no-pnpm":
      return ["pnpm was not found. Run `corepack enable pnpm`, open a new terminal and try again."];
    case "unfinished":
      if (r.runningPid !== null) {
        return [
          `The last update, to ${r.target}, did not finish. Its process tree has not been confirmed stopped (process ${r.runningPid}).`,
          "End that process and its helpers, or use Restart before retrying. On Windows, a Fast Startup shutdown may keep the same boot. Keep Gates Local closed until then.",
          "Then run `pnpm run app-update`: it finishes the update or says what is in the way.",
          `Or by hand, once it has ended: ${BY_HAND}`,
        ];
      }
      return [`The last update, to ${r.target}, did not finish, so this copy may not run yet.`, "Close Gates Local and run `pnpm run app-update`: it finishes the update or says what is in the way.", `Or by hand: ${BY_HAND}`];
    case "busy":
      return [
        `Another update of this copy is already running${r.pid === null ? "" : ` (process ${r.pid})`}.`,
        `Nothing was changed. Wait for it to finish, or end ${r.pid === null ? "it" : "that process"}, then try again.`,
        `If you are sure no update is running, delete ${r.file} and try again.`,
      ];
    case "lost-lock":
      return ["Another update took over this copy while this one was held up, so this one stopped.", "Run `pnpm run app-update` once that one has finished, to see where the copy stands."];
    case "still-running":
      return [
        `The update to ${r.target} has processes that have not been confirmed stopped${r.pid === null ? "" : ` (process ${r.pid})`}.`,
        `The updater will not replace files until they have ended or a restart is proved. End ${r.pid === null ? "those processes" : "that process and its helpers"}, or restart the computer using Restart, then run \`pnpm run app-update\`.`,
        "On Windows, a Fast Startup shutdown may keep the same boot. Keep Gates Local closed while its files may still be held.",
        `Or by hand, once it has ended: ${BY_HAND}`,
      ];
    case "cannot-save":
      return [
        `The update to ${r.target} stopped before its next step, because it could not save what it was doing: ${r.detail}.`,
        r.pid === null
          ? "Nothing of it is left running, and it changed nothing more."
          : `A process it had just started (process ${r.pid}) could not be confirmed ended. End it or restart the computer before anything else, and keep Gates Local closed until then.`,
        "Fix the cause (a full disk is the usual one), then run `pnpm run app-update`.",
        `Or by hand${r.pid === null ? "" : ", once it has ended"}: ${BY_HAND}`,
      ];
    case "partial-checkout":
      return [
        `The last update, to ${r.target}, was cut off while it was changing files, so this copy is part way between two versions.`,
        ...(r.files.length > 0 ? ["These tracked files differ from the commit this copy is on:", ...listed(r.files)] : []),
        ...(r.gitLock === null ? [] : [`Git left its lock behind. If no git command is running, delete ${r.gitLock}.`]),
        "The updater will not clean this up itself, because any edits of your own would be among those files. Copy those somewhere safe first.",
        "To get back: run `git reset --hard` (it discards uncommitted edits to tracked files), then `pnpm run app-update`.",
        "Or by hand: close Gates Local, then git reset --hard, git pull, pnpm install, pnpm start.",
      ];
    case "changed-during-update":
      return [
        `The update to ${r.target} stopped at ${STEP_WORDS[r.step]}: ${r.stepReason}.`,
        ...changedLines(r),
        "It did not go back on its own, so your work is exactly as you left it.",
        "To finish, with your work left as it is: close Gates Local, then run `pnpm install`, then `pnpm start`.",
        "The same works after `git pull`, if you want the newest version first.",
      ];
  }
}

function changeLines(i: Extract<Inspection, { state: "available" }>): string[] {
  const lines = [`${i.total === 1 ? "1 change" : `${i.total} changes`} from ${i.head.label} to ${i.target.label}:`];
  if (i.notes) lines.push(...i.notes.split("\n").map((l) => `  ${l}`));
  else {
    lines.push(...i.changes.map((s) => `  - ${s}`));
    if (i.total > i.changes.length) lines.push(`  …and ${i.total - i.changes.length} more`);
  }
  return lines;
}

const channelLine = (c: "main" | "release") => (c === "release" ? "Following releases." : "Following every change on the main branch.");

/** The stopped-at line both the command and the app show. */
export function stoppedLine(to: string, step: keyof typeof STEP_WORDS, reason: string, from: string, repair = false): string {
  return `${repair ? "The repair of" : "The update to"} ${to} stopped at ${STEP_WORDS[step]}: ${reason}. Gates Local is still on ${from}.`;
}

/** Returns the exit code. */
export async function runCli(deps: CliDeps): Promise<number> {
  const print = deps.print ?? ((line: string) => process.stdout.write(`${line}\n`));
  const now = deps.now ?? Date.now;
  let values;
  try {
    ({ values } = parseArgs({
      args: [...deps.argv],
      options: {
        check: { type: "boolean" },
        channel: { type: "string" },
        "data-dir": { type: "string" },
        "wait-pid": { type: "string" },
        "target-commit": { type: "string" },
        restart: { type: "boolean" },
        "relaunch-cwd": { type: "string" },
        "relaunch-arg": { type: "string", multiple: true },
        help: { type: "boolean" },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (e) {
    print(`${(e as Error).message}\n\n${USAGE}`);
    return 2;
  }
  if (values.help) {
    print(USAGE);
    return 0;
  }
  const dataDir = path.resolve(values["data-dir"] ?? deps.defaultDataDir);
  const choice = channelChoice(values.channel, dataDir);
  if (choice instanceof Error) {
    print(`${choice.message}\n\n${USAGE}`);
    return 2;
  }
  const waitPid = values["wait-pid"] === undefined ? undefined : Number(values["wait-pid"]);
  const approvedCommit = values["target-commit"];
  if (approvedCommit !== undefined && !/^[a-f0-9]{40}$/.test(approvedCommit)) {
    print("--target-commit must be the full 40-character checked commit.");
    return 2;
  }
  if (waitPid !== undefined && (!Number.isInteger(waitPid) || waitPid <= 0)) {
    print(`--wait-pid must be a process id, not "${values["wait-pid"]}"`);
    return 2;
  }
  const approvalDeadline = deps.approvalBeforeUptime;
  if (approvalDeadline !== undefined && (!Number.isFinite(approvalDeadline) || approvalDeadline <= 0 || approvedCommit === undefined || waitPid === undefined)) {
    print("The desktop update handoff is invalid. Check for updates again before approving it.");
    return 2;
  }
  const checkOnly = values.check === true;
  const restart = values.restart === true;
  const relaunch: Relaunch = { cwd: values["relaunch-cwd"] ?? path.join(deps.root, "apps", "desktop"), args: values["relaunch-arg"] ?? [path.join(deps.root, "apps", "desktop")] };

  const log = checkOnly ? undefined : openLog(dataDir, now());
  const say = (line: string) => {
    print(line);
    log?.write(`${line}\n`);
  };
  const record = (r: Omit<UpdateRecord, "at" | "logPath">) => {
    try {
      writeRecord(dataDir, { at: now(), ...r, ...(log ? { logPath: log.file } : {}) });
    } catch (e) {
      say(`Could not save the result for the app (${(e as Error).message}).`);
    }
  };
  let attemptedStartup = false;
  const reopen = async () => {
    if (!restart && !attemptedStartup) return;
    try {
      await deps.relaunch(relaunch);
      say("Opening Gates Local again.");
    } catch (e) {
      say(`Could not open Gates Local again (${(e as Error).message}). Start it from your app menu or with pnpm start.`);
    }
  };

  try {
    if (waitPid !== undefined) {
      say("Waiting for Gates Local to close…");
      const remaining = () => approvalDeadline === undefined ? Infinity : (approvalDeadline - (deps.uptime ?? uptime)()) * 1000;
      const closed = await waitForExit(waitPid, { timeoutMs: Math.min(deps.closeWaitMs ?? CLOSE_WAIT_MS, Math.max(0, remaining())), ...(deps.alive ? { alive: deps.alive } : {}) });
      if (remaining() <= 0) {
        // This updater no longer owns admission. Do not reopen or overwrite a
        // later attempt's result, even when the old desktop has finally quit.
        say("The desktop update approval expired before Gates Local closed. Nothing was installed. Check for updates again and approve the current activity.");
        return 1;
      }
      if (!closed) {
        say(`Gates Local (process ${waitPid}) did not close within ${Math.round((deps.closeWaitMs ?? CLOSE_WAIT_MS) / 1000)} s. Nothing was changed.`);
        record({ outcome: "refused", reason: "Gates Local did not close, so the update did not start" });
        return 1;
      }
      // Electron's helper processes can outlive the main one by a moment, and on Windows they hold electron.exe.
      if ((deps.platform ?? process.platform) === "win32") await new Promise((r) => setTimeout(r, 2000));
    }

    let run: UpdateRun;
    try {
      run = await runUpdate({
        root: deps.root,
        runner: deps.runner ?? realRunner,
        choice,
        pnpm: deps.pnpm,
        appRunning: () => deps.appRunning(dataDir),
        checkOnly,
        ...(approvedCommit === undefined ? {} : { approvedCommit }),
        say,
        log: (chunk) => log?.write(chunk),
        startApp: async (startup, onStart) => {
          attemptedStartup = true;
          try {
            const app = await deps.relaunch({ ...relaunch, startup, onStart });
            if (app === undefined) return { code: 1, stdout: "", stderr: "The new version did not return an owned startup process." };
            return await waitForStartup({ root: deps.root, dataDir, ...startup, app, ...(deps.startupTimeoutMs === undefined ? {} : { timeoutMs: deps.startupTimeoutMs }), ...(deps.alive === undefined ? {} : { alive: deps.alive }) });
          } catch (error) { return { code: 1, stdout: "", stderr: `Could not start the new version: ${(error as Error).message}`, ...(typeof error === "object" && error !== null && "treeStillRunning" in error && error.treeStillRunning === true ? { treeStillRunning: true } : {}) }; }
        },
      });
    } catch (e) {
      // The test guard's refusal is the test's to see.
      if (e instanceof UpdateGuardError) throw e;
      say(`The updater stopped on an error it did not expect: ${(e as Error).message}`);
      if (log) say(`The full log is in ${log.file}`);
      record({ outcome: "refused", reason: (e as Error).message });
      await reopen();
      return 1;
    }
    switch (run.outcome) {
      case "refused": {
        const lines = refusalLines(run.refusal);
        for (const line of lines) say(line);
        if (waitPid !== undefined) record({ outcome: "refused", reason: lines.join(" ") });
        // Not while something may still be replacing what the app runs from.
        if (!["busy", "lost-lock", "still-running"].includes(run.refusal.reason) && !(run.refusal.reason === "cannot-save" && run.refusal.pid !== null)) await reopen();
        return 1;
      }
      case "up-to-date":
        say(`Gates Local is up to date (${run.inspection.head.label}). ${channelLine(run.inspection.channel)}`);
        await reopen();
        return 0;
      case "available":
        for (const line of changeLines(run.inspection)) say(line);
        say(channelLine(run.inspection.channel));
        say("To install it, close Gates Local and run: pnpm run app-update");
        return 0;
      case "updated":
        say(run.from.commit === run.to.commit ? `Repaired ${run.to.label}.` : `Updated to ${run.to.label}, ${run.changes === 1 ? "1 change" : `${run.changes} changes`}.`);
        // The ready app wrote and consumed its own success note. It is
        // already open; launching it again would hide startup failures.
        return 0;
      case "awaiting-start":
        say(`Built ${run.to.label}. Start Gates Local to finish the update; success is recorded only after its server is ready.`);
        return 0;
      case "stopped":
        say(stoppedLine(run.to.label, run.step, run.reason, run.from.label, run.from.commit === run.to.commit));
        if (log) say(`The full log is in ${log.file}`);
        record({ outcome: "stopped", channel: run.channel, from: run.from, to: run.to, step: run.step, reason: run.reason });
        await reopen();
        return 1;
      case "rollback-failed":
        say(`${run.from.commit === run.to.commit ? "Repairing" : "The update to"} ${run.to.label} stopped at ${STEP_WORDS[run.step]}: ${run.reason}.`);
        say(`${run.from.commit === run.to.commit ? "Retrying the repair" : `Going back to ${run.from.label}`} did not finish either. Gates Local may not start until you run these commands in ${deps.root}:`);
        for (const c of run.commands ?? []) say(`  ${c}`);
        if (log) say(`The full log is in ${log.file}`);
        record({ outcome: "rollback-failed", channel: run.channel, from: run.from, to: run.to, step: run.step, reason: run.reason, commands: run.commands ?? [] });
        await reopen();
        return 1;
      default:
        return run satisfies never;
    }
  } finally {
    log?.close();
  }
}
