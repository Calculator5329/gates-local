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
import { parseArgs } from "node:util";
import { type Pnpm, type Refusal, type UpdateRun, STEP_WORDS, runUpdate } from "./apply.ts";
import type { ChannelChoice, Inspection } from "./check.ts";
import { UpdateGuardError } from "./guard.ts";
import { type UpdateRecord, writeRecord } from "./record.ts";
import { realRunner, type Runner } from "./run.ts";
import { waitForExit } from "./wait.ts";

export const REPO_URL = "https://github.com/Calculator5329/gates-local.git";
/** How long the detached updater waits for the app to close. */
export const CLOSE_WAIT_MS = 60_000;
const KEEP_LOGS = 10;

export interface Relaunch {
  readonly cwd: string;
  readonly args: readonly string[];
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
  readonly relaunch: (spec: Relaunch) => void;
  readonly alive?: (pid: number) => boolean;
  readonly print?: (line: string) => void;
  readonly now?: () => number;
  readonly platform?: NodeJS.Platform;
  readonly closeWaitMs?: number;
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

/** The plain-language lines for a refusal; the last says nothing was changed where that is true. */
export function refusalLines(r: Refusal): string[] {
  switch (r.reason) {
    case "no-git":
      return ["Git was not found. Gates Local updates itself with git.", "Install it from https://git-scm.com/downloads, open a new terminal and try again."];
    case "not-a-clone":
      return ["This folder is not a git clone of Gates Local, so it cannot update itself.", `Get a fresh copy with: git clone ${REPO_URL}`];
    case "no-upstream":
      return [r.detail, "Nothing was changed. Switch back to the main branch with `git switch main` and try again."];
    case "local-changes":
      return [
        "These files have changes that are not saved in git:",
        ...r.files.slice(0, 20).map((f) => `  ${f}`),
        ...(r.files.length > 20 ? [`  …and ${r.files.length - 20} more`] : []),
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
export function stoppedLine(to: string, step: keyof typeof STEP_WORDS, reason: string, from: string): string {
  return `The update to ${to} stopped at ${STEP_WORDS[step]}: ${reason}. Gates Local is still on ${from}.`;
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
  if (waitPid !== undefined && (!Number.isInteger(waitPid) || waitPid <= 0)) {
    print(`--wait-pid must be a process id, not "${values["wait-pid"]}"`);
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
  const reopen = () => {
    if (!restart) return;
    try {
      deps.relaunch(relaunch);
      say("Opening Gates Local again.");
    } catch (e) {
      say(`Could not open Gates Local again (${(e as Error).message}). Start it from your app menu or with pnpm start.`);
    }
  };

  try {
    if (waitPid !== undefined) {
      say("Waiting for Gates Local to close…");
      const closed = await waitForExit(waitPid, { timeoutMs: deps.closeWaitMs ?? CLOSE_WAIT_MS, ...(deps.alive ? { alive: deps.alive } : {}) });
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
        say,
        log: (chunk) => log?.write(chunk),
      });
    } catch (e) {
      // The test guard's refusal is the test's to see.
      if (e instanceof UpdateGuardError) throw e;
      say(`The updater stopped on an error it did not expect: ${(e as Error).message}`);
      if (log) say(`The full log is in ${log.file}`);
      record({ outcome: "refused", reason: (e as Error).message });
      reopen();
      return 1;
    }
    switch (run.outcome) {
      case "refused": {
        const lines = refusalLines(run.refusal);
        for (const line of lines) say(line);
        if (waitPid !== undefined) record({ outcome: "refused", reason: lines.join(" ") });
        reopen();
        return 1;
      }
      case "up-to-date":
        say(`Gates Local is up to date (${run.inspection.head.label}). ${channelLine(run.inspection.channel)}`);
        reopen();
        return 0;
      case "available":
        for (const line of changeLines(run.inspection)) say(line);
        say(channelLine(run.inspection.channel));
        say("To install it, close Gates Local and run: pnpm run app-update");
        return 0;
      case "updated":
        say(`Updated to ${run.to.label}, ${run.changes === 1 ? "1 change" : `${run.changes} changes`}.`);
        if (!restart) say("Start Gates Local from your app menu or with pnpm start.");
        record({ outcome: "updated", channel: run.channel, from: run.from, to: run.to, changes: run.changes });
        reopen();
        return 0;
      case "stopped":
        say(stoppedLine(run.to.label, run.step, run.reason, run.from.label));
        if (log) say(`The full log is in ${log.file}`);
        record({ outcome: "stopped", channel: run.channel, from: run.from, to: run.to, step: run.step, reason: run.reason });
        reopen();
        return 1;
      case "rollback-failed":
        say(`The update to ${run.to.label} stopped at ${STEP_WORDS[run.step]}: ${run.reason}.`);
        say(`Going back to ${run.from.label} did not finish either. Gates Local may not start until you run these commands in ${deps.root}:`);
        for (const c of run.commands ?? []) say(`  ${c}`);
        if (log) say(`The full log is in ${log.file}`);
        record({ outcome: "rollback-failed", channel: run.channel, from: run.from, to: run.to, step: run.step, reason: run.reason, commands: run.commands ?? [] });
        reopen();
        return 1;
      default:
        return run satisfies never;
    }
  } finally {
    log?.close();
  }
}
