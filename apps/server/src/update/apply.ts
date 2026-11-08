// The update itself: preconditions, the target (check.ts), then fast-forward,
// pnpm install and the two builds `pnpm start` runs. A failed install or
// build goes back to the old commit and installs and builds that again, so
// the person keeps a working app; only when going back fails too does the
// result carry the exact commands to run.
//
// Nothing here merges, rebases or resets over someone's work: a copy with
// tracked changes or commits of its own is refused before anything changes,
// and the one reset (going back) is `git reset --keep` on a tree this run
// found clean.
//
// The whole of it holds the checkout's lock (lock.ts). Before the checkout
// moves, what is about to happen is saved (transaction.ts), so a run cut off
// at any point is finished or undone by the next one.
import { type Blocked, type Channel, type ChannelChoice, type Commit, type Git, type Inspection, changedFiles, gitIn, inspect, isBlocked } from "./check.ts";
import { acquireLock, lockHolder } from "./lock.ts";
import { lastLines, type RunResult, type Runner } from "./run.ts";
import { type Transaction, clearTransaction, readTransaction, saveTransaction } from "./transaction.ts";

export type Step = "switch" | "install" | "build-web" | "build-desktop";

export const STEP_WORDS: Record<Step, string> = {
  switch: "switching to the new version",
  install: "installing packages",
  "build-web": "building the app window",
  "build-desktop": "building the desktop app",
};

const INSTALL_MS = 20 * 60_000;
const BUILD_MS = 10 * 60_000;

/** How to run pnpm: a command plus arguments that come before pnpm's own (node <pnpm.cjs>). */
export interface Pnpm {
  readonly command: string;
  readonly prefix: readonly string[];
  /** pnpm.cmd on Windows only runs through the shell. */
  readonly shell: boolean;
}

/** The pnpm commands of one update, in order. A non-TTY install must not stop to ask about node_modules. */
export const INSTALL_ARGS = ["install", "--frozen-lockfile", "--config.confirmModulesPurge=false"] as const;
export const BUILD_WEB_ARGS = ["--filter", "@gates-local/web", "build"] as const;
export const BUILD_DESKTOP_ARGS = ["--filter", "@gates-local/desktop", "build"] as const;

export type Refusal =
  | Blocked
  | { readonly reason: "app-running"; readonly pid: number; readonly file: string }
  | { readonly reason: "no-pnpm" }
  /** Another update holds this checkout. */
  | { readonly reason: "busy"; readonly pid: number | null }
  /** This run was paused past the lock's limit and another took over; it changed nothing after that. */
  | { readonly reason: "lost-lock" };

export type UpdateRun =
  | { readonly outcome: "refused"; readonly refusal: Refusal }
  | { readonly outcome: "up-to-date"; readonly inspection: Extract<Inspection, { state: "up-to-date" }> }
  | { readonly outcome: "available"; readonly inspection: Extract<Inspection, { state: "available" }> }
  | { readonly outcome: "updated"; readonly channel: Channel; readonly from: Commit; readonly to: Commit; readonly changes: number }
  | {
      readonly outcome: "stopped" | "rollback-failed";
      readonly channel: Channel;
      readonly from: Commit;
      readonly to: Commit;
      readonly step: Step;
      readonly reason: string;
      /** rollback-failed: what to run by hand, one command a line, from the clone. */
      readonly commands?: readonly string[];
    };

export interface UpdateOptions {
  readonly root: string;
  readonly runner: Runner;
  readonly choice: ChannelChoice;
  readonly pnpm: Pnpm;
  /** The running app, from its pid file; null when it is not running. */
  readonly appRunning: () => { readonly pid: number; readonly file: string } | null;
  /** Report only: change nothing. */
  readonly checkOnly: boolean;
  /** Plain-language progress, one line each. */
  readonly say: (line: string) => void;
  /** Every command and its output, for the log file. */
  readonly log: (chunk: string) => void;
}

const ok = (r: RunResult) => r.code === 0;

function reasonOf(r: RunResult, what: string): string {
  if (r.treeStillRunning === true) return `${what} took too long and could not be stopped; end it or restart the computer first`;
  if (r.failure === "not-found") return `${what} was not found`;
  if (r.failure === "timeout") return `${what} took too long and was stopped`;
  return lastLines(r) || `${what} exited with code ${String(r.code)}`;
}

export function pnpmLine(args: readonly string[]): string {
  return `pnpm ${args.join(" ")}`;
}

const refused = (refusal: Refusal): UpdateRun => ({ outcome: "refused", refusal });
const lostLock = (): UpdateRun => refused({ reason: "lost-lock" });

/** The files git names, one per tab-indented line, when it will not write over them. Read by shape, so any git language works. */
function filesInTheWay(merge: RunResult): string[] {
  return merge.stderr.split(/\r?\n/).filter((l) => l.startsWith("\t")).map((l) => l.trim());
}

const NAMED_IN_THE_WAY = 3;

function inTheWaySentence(files: readonly string[]): string {
  if (files.length === 1) return `your own file ${files[0]} is where the new version puts a file of the same name. It was left as it was; move or rename it and try again`;
  const shown = files.slice(0, NAMED_IN_THE_WAY).join(", ");
  const rest = files.length - NAMED_IN_THE_WAY;
  const names = rest > 0 ? `${shown} and ${rest} more` : shown;
  return `your own files ${names} are where the new version puts files of the same name. They were left as they were; move or rename them and try again`;
}

function switchFailure(merge: RunResult): string {
  const files = filesInTheWay(merge);
  return files.length > 0 ? inTheWaySentence(files) : reasonOf(merge, "git merge");
}

interface Context {
  readonly o: UpdateOptions;
  readonly git: Git;
  readonly pnpm: (args: readonly string[], ms: number) => Promise<RunResult>;
  /** False once another run has taken the checkout: nothing more may change. */
  readonly ours: () => boolean;
}

/** Nothing else may look at or change this checkout until it returns. A --check reads, so it only asks. */
export async function runUpdate(o: UpdateOptions): Promise<UpdateRun> {
  if (o.checkOnly) {
    const holder = lockHolder(o.root);
    return holder === null ? transact(o, () => true) : refused({ reason: "busy", pid: holder.pid });
  }
  const got = acquireLock(o.root);
  if (!got.ok) return refused({ reason: "busy", pid: got.pid });
  try {
    return await transact(o, () => got.lock.stillOurs());
  } finally {
    got.lock.release();
  }
}

async function transact(o: UpdateOptions, ours: () => boolean): Promise<UpdateRun> {
  const git = gitIn(o.root, o.runner, o.log);
  const pnpm = (args: readonly string[], timeoutMs: number) => {
    o.log(`$ ${pnpmLine(args)}\n`);
    return o.runner(o.pnpm.command, [...o.pnpm.prefix, ...args], { cwd: o.root, shell: o.pnpm.shell, timeoutMs, onOutput: o.log });
  };
  const c: Context = { o, git, pnpm, ours };

  if (!o.checkOnly) {
    // On Windows a running app holds electron.exe and the install would stop half way.
    const running = o.appRunning();
    if (running !== null) return refused({ reason: "app-running", ...running });
    if (!ok(await pnpm(["--version"], 60_000))) return refused({ reason: "no-pnpm" });
    const unfinished = readTransaction(o.root);
    if (unfinished !== null) {
      const recovered = await recover(c, unfinished);
      if (recovered !== null) return recovered;
    }
  }

  o.say("Checking for updates…");
  const found = await inspect({ root: o.root, runner: o.runner, choice: o.choice, log: o.log });
  if (found.state === "blocked") return refused(found.blocked);
  if (found.state === "up-to-date") return { outcome: "up-to-date", inspection: found };
  if (o.checkOnly) return { outcome: "available", inspection: found };

  const { channel, head: from, target: to, total } = found;
  const branch = await git(["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const move: Move = { channel, branch: branch.stdout.trim(), from, to, changes: total };
  if (!ours()) return lostLock();
  // Saved before anything moves: every way back starts here, and a failure to save stops the update.
  saveTransaction(o.root, { ...move, phase: "forward" });
  // Never over a file of the person's: by default git writes over ignored ones.
  const switched = await git(["merge", "--ff-only", "--no-overwrite-ignore", "--quiet", to.commit]);
  if (!ok(switched)) {
    const now = await git(["rev-parse", "HEAD"]);
    // merge --ff-only changes nothing when it fails; if HEAD moved anyway, or the merge may still be running, it is not over.
    if (ok(now) && now.stdout.trim() === from.commit && switched.treeStillRunning !== true) {
      if (!ours()) return lostLock();
      settle(c);
      return { outcome: "stopped", channel, from, to, step: "switch", reason: switchFailure(switched) };
    }
    return goBack(c, { ...move, step: "switch", reason: reasonOf(switched, "git merge"), stuck: switched.treeStillRunning === true });
  }
  o.say(`Switched to ${to.label}.`);
  return installAndBuild(c, move);
}

/**
 * Takes up what a cut-off run left. Null means nothing is left to do and the
 * update goes on as usual.
 *
 * What the checkout is on says how far it got. On the new commit: the install
 * and builds may not have finished, so they run (and go back if they fail).
 * On the old commit after a start back: going back runs again. On the old
 * commit otherwise: it never moved. Anywhere else, or on another branch, the
 * person has moved it themselves (the manual `git pull` path), and that stands.
 */
async function recover(c: Context, t: Transaction): Promise<UpdateRun | null> {
  const { o, git } = c;
  const now = await git(["rev-parse", "HEAD"]);
  const branch = await git(["symbolic-ref", "--quiet", "--short", "HEAD"]);
  // git is not usable: inspect says why, and refuses while the file is there.
  if (!ok(now)) return null;
  const head = now.stdout.trim();
  const onNew = head === t.to.commit;
  const goingBack = head === t.from.commit && t.phase === "back" ? t : null;
  if (branch.stdout.trim() !== t.branch || (!onNew && goingBack === null)) {
    if (!c.ours()) return lostLock();
    settle(c);
    return null;
  }
  const files = await changedFiles(git);
  if (isBlocked(files)) return refused(files);
  if (files.length > 0) return refused({ reason: "local-changes", files });
  if (!c.ours()) return lostLock();
  const move: Move = { channel: t.channel, branch: t.branch, from: t.from, to: t.to, changes: t.changes };
  if (goingBack !== null) return goBack(c, { ...move, step: goingBack.step, reason: goingBack.reason });
  o.say(`The update to ${t.to.label} did not finish. Finishing it…`);
  return installAndBuild(c, move);
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The saved update is done with. Not saving this only repeats the install next time, so it never fails a run. */
function settle(c: Context): void {
  try {
    clearTransaction(c.o.root);
  } catch (e) {
    c.o.log(`Could not clear the update's saved state: ${(e as Error).message}\n`);
  }
}

interface Move {
  readonly channel: Channel;
  readonly branch: string;
  readonly from: Commit;
  readonly to: Commit;
  readonly changes: number;
}

async function installAndBuild(c: Context, m: Move): Promise<UpdateRun> {
  const steps: Array<[Step, readonly string[], number]> = [
    ["install", INSTALL_ARGS, INSTALL_MS],
    ["build-web", BUILD_WEB_ARGS, BUILD_MS],
    ["build-desktop", BUILD_DESKTOP_ARGS, BUILD_MS],
  ];
  for (const [step, args, ms] of steps) {
    if (!c.ours()) return lostLock();
    c.o.say(`${capital(STEP_WORDS[step])}…${step === "install" ? " (this can take a few minutes)" : ""}`);
    const r = await c.pnpm(args, ms);
    if (!ok(r)) return goBack(c, { ...m, step, reason: reasonOf(r, "pnpm"), stuck: r.treeStillRunning === true });
  }
  if (!c.ours()) return lostLock();
  settle(c);
  return { outcome: "updated", channel: m.channel, from: m.from, to: m.to, changes: m.changes };
}

interface Failed extends Move {
  readonly step: Step;
  readonly reason: string;
  /** The failed step's processes may still be running: going back now would race them. */
  readonly stuck?: boolean;
}

async function goBack(c: Context, f: Failed): Promise<UpdateRun> {
  const { o, git, pnpm } = c;
  const result = { channel: f.channel, from: f.from, to: f.to, step: f.step, reason: f.reason };
  const commands = [
    `git reset --keep ${f.from.commit}`,
    pnpmLine(INSTALL_ARGS),
    pnpmLine(BUILD_WEB_ARGS),
    pnpmLine(BUILD_DESKTOP_ARGS),
  ];
  // The saved state stays, so the next run takes this up again.
  const failedBack = (): UpdateRun => ({ outcome: "rollback-failed", ...result, commands });
  if (f.stuck === true) return failedBack();
  if (!c.ours()) return lostLock();
  o.say(`The update to ${f.to.label} stopped at ${STEP_WORDS[f.step]}. Going back to ${f.from.label}…`);
  try {
    saveTransaction(o.root, { channel: f.channel, branch: f.branch, from: f.from, to: f.to, changes: f.changes, phase: "back", step: f.step, reason: f.reason });
  } catch (e) {
    // Going back matters more than remembering it.
    o.log(`Could not save that the update is going back: ${(e as Error).message}\n`);
  }
  // --keep is safe: the tree was clean when this run started, and it refuses to drop a change.
  if (!ok(await git(["reset", "--keep", f.from.commit]))) return failedBack();
  for (const [args, ms] of [[INSTALL_ARGS, INSTALL_MS], [BUILD_WEB_ARGS, BUILD_MS], [BUILD_DESKTOP_ARGS, BUILD_MS]] as const) {
    if (!c.ours()) return lostLock();
    if (!ok(await pnpm(args, ms))) return failedBack();
  }
  if (!c.ours()) return lostLock();
  settle(c);
  return { outcome: "stopped", ...result };
}
