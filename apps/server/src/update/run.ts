// How the updater runs git and pnpm. Everything goes through a Runner, so
// tests can make install or build fail (and record every call) while real
// git runs against their own temporary repositories.
//
// The real runner checks the guard (guard.ts) before each command, drops the
// environment variables that point git at another repository, and never lets
// git ask for a password (a check that needs one fails instead of hanging).
import { type ChildProcessByStdio, execFile, spawn } from "node:child_process";
import path from "node:path";
import type { Readable } from "node:stream";
import { guardTarget, testRoot } from "./guard.ts";
import { isAlive } from "./wait.ts";

export interface RunResult {
  /** The exit code; null when the command was killed or did not start. */
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** Set when the command did not start (ENOENT: not installed) or ran past its time limit. */
  readonly failure?: "not-found" | "timeout" | "spawn-error";
  /** A timed-out command whose processes could not be confirmed ended. Nothing else may touch the checkout. */
  readonly treeStillRunning?: true;
}

export interface RunOptions {
  readonly cwd: string;
  readonly timeoutMs?: number;
  /** Each chunk of stdout and stderr as it arrives (the update log). */
  readonly onOutput?: (chunk: string) => void;
  /** The started process's id, as soon as it is known. If this throws, the command is ended at once. */
  readonly onStart?: (pid: number) => void;
  /** Run through the shell. Needed for pnpm.cmd on Windows; the arguments must be plain words. */
  readonly shell?: boolean;
  readonly env?: NodeJS.ProcessEnv;
}

export type Runner = (command: string, args: readonly string[], options: RunOptions) => Promise<RunResult>;

/** Variables that would make git act on a repository other than the one in cwd. */
const REDIRECTS = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_COMMON_DIR", "GIT_NAMESPACE", "GIT_ALTERNATE_OBJECT_DIRECTORIES"];

export function commandEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" };
  for (const key of REDIRECTS) delete env[key];
  // In tests git never looks for a repository above the test root.
  const root = testRoot(base);
  if (root !== undefined) env["GIT_CEILING_DIRECTORIES"] = root;
  return env;
}

/** How long a process tree gets to end on SIGTERM, and how long SIGKILL or taskkill gets to be confirmed. */
export const TERM_GRACE_MS = 5_000;
export const KILL_CONFIRM_MS = 5_000;
const POLL_MS = 25;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A process group: `pid` led it, and it lasts as long as any member does, the leader or not. */
export function groupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // Already gone.
  }
}

/** Runs taskkill and resolves its exit code; null when it could not run or did not finish. */
function runTaskkill(args: readonly string[]): Promise<number | null> {
  return new Promise((resolve) => {
    execFile("taskkill", [...args], { windowsHide: true, timeout: KILL_CONFIRM_MS }, (error) => {
      if (error === null) resolve(0);
      else resolve(typeof error.code === "number" ? error.code : null);
    });
  });
}

export interface TreeStop {
  readonly platform: NodeJS.Platform;
  readonly graceMs: number;
  readonly confirmMs: number;
  /** Is the tree still there: the process group on POSIX, the root process on Windows. */
  readonly exists: (pid: number) => boolean;
  readonly signal: (pid: number, signal: NodeJS.Signals) => void;
  readonly taskkill: (args: readonly string[]) => Promise<number | null>;
}

const treeStop = (platform: NodeJS.Platform = process.platform): TreeStop => ({
  platform,
  graceMs: TERM_GRACE_MS,
  confirmMs: KILL_CONFIRM_MS,
  exists: platform === "win32" ? isAlive : groupExists,
  signal: signalGroup,
  taskkill: runTaskkill,
});

async function goneWithin(pid: number, ms: number, exists: TreeStop["exists"]): Promise<boolean> {
  const until = performance.now() + ms;
  while (exists(pid)) {
    if (performance.now() >= until) return false;
    await sleep(POLL_MS);
  }
  return true;
}

/** taskkill's exit code when it found no such process: already gone. */
const TASKKILL_NOT_FOUND = 128;

/**
 * Ends a command and everything it started, within a bound, and says whether
 * that was confirmed. POSIX: SIGTERM to the process group, SIGKILL after the
 * grace. Windows has no process groups here: `taskkill /T /F` walks the tree
 * from the root, and only the root can be confirmed afterwards.
 */
export async function endTree(pid: number, s: TreeStop = treeStop()): Promise<boolean> {
  if (s.platform === "win32") {
    const code = await s.taskkill(["/PID", String(pid), "/T", "/F"]);
    if (code !== 0 && code !== TASKKILL_NOT_FOUND) return false;
    return goneWithin(pid, s.confirmMs, s.exists);
  }
  s.signal(pid, "SIGTERM");
  if (await goneWithin(pid, s.graceMs, s.exists)) return true;
  s.signal(pid, "SIGKILL");
  return goneWithin(pid, s.confirmMs, s.exists);
}

// Commands run in their own process groups so a timeout can end all of each
// one, which also keeps Ctrl+C from reaching them: it goes to the terminal's
// foreground group, this process. Without this they would outlive it.
const liveGroups = new Set<number>();
const STOP_SIGNALS: readonly NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];

function onStopSignal(signal: NodeJS.Signals): void {
  for (const pid of liveGroups) signalGroup(pid, "SIGKILL");
  liveGroups.clear();
  for (const s of STOP_SIGNALS) process.removeListener(s, onStopSignal);
  // Nobody else is handling it (the updater): die of it, as a signal normally would.
  if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
}

function trackGroup(pid: number): void {
  if (liveGroups.size === 0) for (const s of STOP_SIGNALS) process.on(s, onStopSignal);
  liveGroups.add(pid);
}

function untrackGroup(pid: number): void {
  if (!liveGroups.delete(pid) || liveGroups.size > 0) return;
  for (const s of STOP_SIGNALS) process.removeListener(s, onStopSignal);
}

/** The runner, with the tree-stopping steps replaceable for a test of the escalation. */
export function createRunner(stop: Partial<TreeStop> = {}): Runner {
  return (command, args, options) => {
    // Throws before anything starts when the folder is not allowed.
    guardTarget(options.cwd);
    const env = commandEnv(options.env ?? process.env);
    const ownGroup = process.platform !== "win32";
    return new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let failure: RunResult["failure"];
      let stopping = false;
      let child: ChildProcessByStdio<null, Readable, Readable>;
      try {
        child = spawn(command, [...args], {
          cwd: path.resolve(options.cwd),
          env,
          shell: options.shell ?? false,
          windowsHide: true,
          detached: ownGroup,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (e) {
        resolve({ code: null, stdout, stderr: (e as Error).message, failure: "spawn-error" });
        return;
      }
      const group = ownGroup ? child.pid : undefined;
      if (group !== undefined) trackGroup(group);
      let refusedAtStart = false;
      try {
        if (child.pid !== undefined) options.onStart?.(child.pid);
      } catch {
        refusedAtStart = true;
      }
      let settled = false;
      const finish = (code: number | null, treeStillRunning = false) => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        if (group !== undefined) untrackGroup(group);
        resolve({ code: failure === undefined ? code : null, stdout, stderr, ...(failure === undefined ? {} : { failure }), ...(treeStillRunning ? { treeStillRunning } : {}) });
      };
      const stopTree = (why: NonNullable<RunResult["failure"]>) => {
        failure = why;
        stopping = true;
        const pid = child.pid;
        if (pid === undefined) {
          finish(null);
          return;
        }
        void endTree(pid, { ...treeStop(), ...stop }).then((ended) => {
          // Something outside the tree can still hold a pipe open; `close` is no longer waited for.
          child.stdout.destroy();
          child.stderr.destroy();
          finish(null, !ended);
        });
      };
      const timer = options.timeoutMs === undefined ? undefined : setTimeout(() => stopTree("timeout"), options.timeoutMs);
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
        options.onOutput?.(chunk);
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
        options.onOutput?.(chunk);
      });
      // A command that never started may or may not also emit close.
      child.on("error", (e: NodeJS.ErrnoException) => {
        if (stopping) return;
        failure = e.code === "ENOENT" ? "not-found" : "spawn-error";
        stderr += e.message;
        if (child.pid === undefined) finish(null);
      });
      // While a timeout is ending the tree, the answer waits for that to be confirmed.
      child.on("close", (code) => {
        if (!stopping) finish(code);
      });
      if (refusedAtStart) stopTree("spawn-error");
    });
  };
}

export const realRunner: Runner = createRunner();

/** The last few lines a command printed, for a one-line reason. */
export function lastLines(result: RunResult, n = 3): string {
  const lines = `${result.stdout}\n${result.stderr}`.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "");
  const text = lines.slice(-n).join(" ");
  return text.length > 400 ? `${text.slice(0, 397)}…` : text;
}
