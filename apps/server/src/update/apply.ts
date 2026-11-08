// The update itself: preconditions, the target (check.ts), then fast-forward,
// pnpm install and the two builds `pnpm start` runs. A failed install or
// build goes back to the old commit and installs and builds that again, so
// the person keeps a working app; only when going back fails too does the
// result carry the exact commands to run.
//
// Nothing here merges, rebases or resets over someone's work: a copy with
// tracked changes or commits of its own is refused before anything changes,
// and the one reset (going back) is `git reset --keep`, run only after this
// run has checked again that the copy is exactly as it left it.
//
// The whole of it holds the checkout's lock (lock.ts). Before the checkout
// moves, what is about to happen is saved (transaction.ts), so a run cut off
// at any point is finished or undone by the next one. Each command that
// changes the checkout is saved there too while it runs, so a later run waits
// for one that outlived the updater or could not be stopped.
import { existsSync } from "node:fs";
import path from "node:path";
import { type Blocked, type Channel, type ChannelChoice, type Commit, type Git, type Inspection, changedFiles, gitIn, inspect, isBlocked } from "./check.ts";
import { processRecord, treeGone } from "./identity.ts";
import { acquireLock, lockHolder, stateDir } from "./lock.ts";
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
  | { readonly reason: "busy"; readonly pid: number | null; readonly file: string }
  /** Its lock was replaced while this run was held up; it changed nothing after that. */
  | { readonly reason: "lost-lock" }
  /** A command of an update could not be confirmed ended. Nothing starts until it has. */
  | { readonly reason: "still-running"; readonly pid: number | null; readonly target: string }
  /** The saved state could not be written, so the next command did not go on. `pid`: one that was started and could not be confirmed ended. */
  | { readonly reason: "cannot-save"; readonly target: string; readonly detail: string; readonly pid: number | null }
  /** Files, the index or git's own markers say a merge or reset was cut off. */
  | { readonly reason: "partial-checkout"; readonly target: string; readonly files: readonly string[]; readonly gitLock: string | null }
  /** The copy changed while the update ran, so it did not go back on its own. */
  | { readonly reason: "changed-during-update"; readonly target: string; readonly step: Step; readonly stepReason: string; readonly changed: "branch" | "commit" | "files"; readonly files: readonly string[] };

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

/** The saved state could not be written. Caught once, in runUpdate. */
class CannotSave extends Error {
  readonly refusal: Refusal;

  constructor(refusal: Refusal) {
    super("The update's state could not be saved");
    this.refusal = refusal;
  }
}

interface Context {
  readonly o: UpdateOptions;
  readonly git: Git;
  readonly pnpm: (args: readonly string[], ms: number, onStart?: (pid: number) => void) => Promise<RunResult>;
  /** False once another run has taken the checkout: nothing more may change. */
  readonly ours: () => boolean;
}

/**
 * Runs a command that changes the checkout, with its process in the saved
 * state while it runs. A command that ended is taken out again; one that may
 * not have ended stays, and holds off every later run.
 *
 * No command runs that a later run could not account for. A process's number
 * only exists once it has started, so the write is proved first, and a
 * command whose number then cannot be saved is ended at once. Either way this
 * throws CannotSave, which ends the run with a refusal.
 */
async function changing(c: Context, t: Transaction, run: (onStart: (pid: number) => void) => Promise<RunResult>): Promise<RunResult> {
  const { root } = c.o;
  const cannotSave = (e: unknown, pid: number | null) => new CannotSave({ reason: "cannot-save", target: t.to.label, detail: (e as Error).message, pid });
  if (c.ours()) {
    try {
      saveTransaction(root, t);
    } catch (e) {
      throw cannotSave(e, null);
    }
  }
  let unsaved: { readonly error: unknown; readonly pid: number } | undefined;
  const result = await run((pid) => {
    if (!c.ours()) return;
    try {
      saveTransaction(root, { ...t, running: processRecord(pid) });
    } catch (error) {
      unsaved = { error, pid };
      throw error;
    }
  });
  if (unsaved !== undefined) throw cannotSave(unsaved.error, result.treeStillRunning === true ? unsaved.pid : null);
  if (result.treeStillRunning !== true && c.ours()) {
    try {
      saveTransaction(root, t);
    } catch (e) {
      // The command has ended, so a stale process in the file only costs the next run a look at it.
      c.o.log(`Could not save the update's state: ${(e as Error).message}\n`);
    }
  }
  return result;
}

function stillRunning(c: Context, to: Commit): UpdateRun {
  return refused({ reason: "still-running", pid: readTransaction(c.o.root)?.running?.pid ?? null, target: to.label });
}

interface LeftBehind {
  readonly gitLock: string | null;
  readonly merging: boolean;
  readonly files: readonly string[];
}

/** What git and the files say about the checkout now. */
async function leftBehind(c: Context): Promise<LeftBehind | Blocked> {
  const dir = stateDir(c.o.root);
  const marker = (name: string) => (dir !== null && existsSync(path.join(dir, name)) ? path.join(dir, name) : null);
  const files = await changedFiles(c.git);
  if (isBlocked(files)) return files;
  return { gitLock: marker("index.lock"), merging: marker("MERGE_HEAD") !== null, files };
}

const partial = (to: Commit, l: LeftBehind): UpdateRun => refused({ reason: "partial-checkout", target: to.label, files: l.files, gitLock: l.gitLock });
const anythingLeft = (l: LeftBehind) => l.gitLock !== null || l.merging || l.files.length > 0;

/** Nothing else may look at or change this checkout until it returns. A --check reads, so it only asks. */
export async function runUpdate(o: UpdateOptions): Promise<UpdateRun> {
  if (o.checkOnly) {
    const holder = lockHolder(o.root);
    return holder === null ? transact(o, () => true) : refused({ reason: "busy", pid: holder.pid, file: holder.file });
  }
  const got = acquireLock(o.root);
  if (!got.ok) return refused({ reason: "busy", pid: got.pid, file: got.file });
  try {
    return await transact(o, () => got.lock.stillOurs());
  } catch (e) {
    if (e instanceof CannotSave) return refused(e.refusal);
    throw e;
  } finally {
    got.lock.release();
  }
}

async function transact(o: UpdateOptions, ours: () => boolean): Promise<UpdateRun> {
  const git = gitIn(o.root, o.runner, o.log);
  const pnpm = (args: readonly string[], timeoutMs: number, onStart?: (pid: number) => void) => {
    o.log(`$ ${pnpmLine(args)}\n`);
    return o.runner(o.pnpm.command, [...o.pnpm.prefix, ...args], { cwd: o.root, shell: o.pnpm.shell, timeoutMs, onOutput: o.log, ...(onStart ? { onStart } : {}) });
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
  const forward: Transaction = { ...move, phase: "forward" };
  // Saved by `changing` before anything moves: every way back starts there, and a failure to save stops the update.
  // Never over a file of the person's: by default git writes over ignored ones.
  const switched = await changing(c, forward, (onStart) => git(["merge", "--ff-only", "--no-overwrite-ignore", "--quiet", to.commit], undefined, onStart));
  if (!ok(switched)) {
    if (switched.treeStillRunning === true) return stillRunning(c, to);
    const now = await git(["rev-parse", "HEAD"]);
    if (ok(now) && now.stdout.trim() === from.commit) {
      // The old commit alone proves nothing: a merge cut off can have written files without moving it.
      const left = await leftBehind(c);
      if (isBlocked(left)) return refused(left);
      if (anythingLeft(left)) return partial(to, left);
      if (!ours()) return lostLock();
      settle(c);
      return { outcome: "stopped", channel, from, to, step: "switch", reason: switchFailure(switched) };
    }
    return goBack(c, { ...move, step: "switch", reason: reasonOf(switched, "git merge") });
  }
  o.say(`Switched to ${to.label}.`);
  return installAndBuild(c, move);
}

/**
 * Takes up what a cut-off run left. Null means nothing is left to do and the
 * update goes on as usual.
 *
 * First, a command that may still be running holds everything off. Then what
 * the checkout is on says how far it got. On the new commit: the install and
 * builds may not have finished, so they run (and go back if they fail). On
 * the old commit after a start back: going back runs again. On the old commit
 * otherwise: it did not move, and the saved state goes only once the files
 * and git agree nothing was left half done. Anywhere else, or on another
 * branch, the person has moved it themselves (the manual `git pull` path),
 * and that stands.
 */
async function recover(c: Context, t: Transaction): Promise<UpdateRun | null> {
  const { o, git } = c;
  if (t.running !== undefined && !treeGone(t.running)) return refused({ reason: "still-running", pid: t.running.pid, target: t.to.label });
  const now = await git(["rev-parse", "HEAD"]);
  const branch = await git(["symbolic-ref", "--quiet", "--short", "HEAD"]);
  // git is not usable: inspect says why, and refuses while the file is there.
  if (!ok(now)) return null;
  const head = now.stdout.trim();
  const onNew = head === t.to.commit;
  const onOld = head === t.from.commit;
  if (branch.stdout.trim() !== t.branch || (!onNew && !onOld)) {
    if (!c.ours()) return lostLock();
    settle(c);
    return null;
  }
  const left = await leftBehind(c);
  if (isBlocked(left)) return refused(left);
  // A merge moves the commit last, so on the new commit going forward the files are all there and any difference is the person's.
  const mergeFinished = onNew && t.phase === "forward";
  if (left.gitLock !== null || left.merging || (left.files.length > 0 && !mergeFinished)) return partial(t.to, left);
  if (left.files.length > 0) return refused({ reason: "local-changes", files: left.files });
  if (!c.ours()) return lostLock();
  if (onOld && t.phase === "forward") {
    settle(c);
    return null;
  }
  const move: Move = { channel: t.channel, branch: t.branch, from: t.from, to: t.to, changes: t.changes };
  if (onOld && t.phase === "back") return goBack(c, { ...move, step: t.step, reason: t.reason });
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
  const forward: Transaction = { ...m, phase: "forward" };
  for (const [step, args, ms] of steps) {
    if (!c.ours()) return lostLock();
    c.o.say(`${capital(STEP_WORDS[step])}…${step === "install" ? " (this can take a few minutes)" : ""}`);
    const r = await changing(c, forward, (onStart) => c.pnpm(args, ms, onStart));
    if (r.treeStillRunning === true) return stillRunning(c, m.to);
    if (!ok(r)) return goBack(c, { ...m, step, reason: reasonOf(r, "pnpm") });
  }
  if (!c.ours()) return lostLock();
  settle(c);
  return { outcome: "updated", channel: m.channel, from: m.from, to: m.to, changes: m.changes };
}

interface Failed extends Move {
  readonly step: Step;
  readonly reason: string;
}

/**
 * Why an automatic reset must not run: the copy is not what this run left.
 * `git reset --keep` keeps a changed working copy but can drop a staged
 * version, so any tracked change at all rules it out. Null when it may go on.
 */
async function changedByHand(c: Context, f: Failed): Promise<Refusal | "unknown" | null> {
  const now = await c.git(["rev-parse", "HEAD"]);
  const branch = await c.git(["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (!ok(now)) return "unknown";
  const by = { reason: "changed-during-update", target: f.to.label, step: f.step, stepReason: f.reason } as const;
  if (branch.stdout.trim() !== f.branch) return { ...by, changed: "branch", files: [] };
  const head = now.stdout.trim();
  if (head !== f.to.commit && head !== f.from.commit) return { ...by, changed: "commit", files: [] };
  const files = await changedFiles(c.git);
  if (isBlocked(files)) return "unknown";
  return files.length > 0 ? { ...by, changed: "files", files } : null;
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
  if (!c.ours()) return lostLock();
  const changed = await changedByHand(c, f);
  if (changed === "unknown") return failedBack();
  if (changed !== null) return refused(changed);
  if (!c.ours()) return lostLock();
  o.say(`The update to ${f.to.label} stopped at ${STEP_WORDS[f.step]}. Going back to ${f.from.label}…`);
  const back: Transaction = { channel: f.channel, branch: f.branch, from: f.from, to: f.to, changes: f.changes, phase: "back", step: f.step, reason: f.reason };
  // --keep is safe here: the copy was just found to be exactly as this run left it.
  const reset = await changing(c, back, (onStart) => git(["reset", "--keep", f.from.commit], undefined, onStart));
  if (reset.treeStillRunning === true) return stillRunning(c, f.to);
  if (!ok(reset)) return failedBack();
  for (const [args, ms] of [[INSTALL_ARGS, INSTALL_MS], [BUILD_WEB_ARGS, BUILD_MS], [BUILD_DESKTOP_ARGS, BUILD_MS]] as const) {
    if (!c.ours()) return lostLock();
    const r = await changing(c, back, (onStart) => pnpm(args, ms, onStart));
    if (r.treeStillRunning === true) return stillRunning(c, f.to);
    if (!ok(r)) return failedBack();
  }
  if (!c.ours()) return lostLock();
  settle(c);
  return { outcome: "stopped", ...result };
}
