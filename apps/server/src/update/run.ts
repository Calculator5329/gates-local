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
import { groupAlive } from "../process-state.ts";
import { guardTarget, testRoot } from "./guard.ts";
import { isAlive } from "./wait.ts";

export interface RunResult {
  /** The exit code; null when the command was killed or did not start. */
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** Set when the command did not start (ENOENT: not installed) or ran past its time limit. */
  readonly failure?: "not-found" | "timeout" | "spawn-error" | "aborted";
  /** A timed-out command whose processes could not be confirmed ended. Nothing else may touch the checkout. */
  readonly treeStillRunning?: true;
}

export interface RunOptions {
  readonly signal?: AbortSignal;
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
/** Let git's SIGTERM handler remove its locks before the server's hard exit. */
const ABORT_GRACE_MS = 300;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A process group with a running member, whether its leader is still there or not. */
export function groupExists(pid: number): boolean {
  return groupAlive(pid);
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
export interface EndTreeOptions {
  /** Startup may leave helpers behind a dead root; exit 128 cannot certify that tree. */
  readonly requireWindowsTreeKill?: boolean;
}
export async function endTree(pid: number, s: TreeStop = treeStop(), options: EndTreeOptions = {}): Promise<boolean> {
  if (s.platform === "win32") {
    const code = await s.taskkill(["/PID", String(pid), "/T", "/F"]);
    if (code === TASKKILL_NOT_FOUND && options.requireWindowsTreeKill === true) return false;
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

function killTrackedGroups(): void {
  for (const pid of liveGroups) signalGroup(pid, "SIGKILL");
  liveGroups.clear();
}

function onStopSignal(signal: NodeJS.Signals): void {
  // The server owns graceful shutdown; exit cleanup catches anything it leaves.
  if (process.listeners(signal).some(listener => listener !== onStopSignal)) return;
  killTrackedGroups();
  for (const s of STOP_SIGNALS) process.removeListener(s, onStopSignal);
  // Nobody else is handling it (the updater): die of it, as a signal normally would.
  if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
}

// Commands starting or running. The listeners go in before a command is
// started: a signal that arrives between the start and the next line of this
// file would otherwise end the process by default and leave the group running.
let listeningFor = 0;

function listenForStop(): void {
  if (listeningFor++ > 0) return;
  // Run before once-listeners remove themselves during signal delivery.
  for (const s of STOP_SIGNALS) process.prependListener(s, onStopSignal);
  process.on("exit", killTrackedGroups);
}

function stopListening(): void {
  if (--listeningFor > 0) return;
  for (const s of STOP_SIGNALS) process.removeListener(s, onStopSignal);
  process.removeListener("exit", killTrackedGroups);
}

/** The runner, with the tree-stopping steps replaceable for a test of the escalation. */
export function createRunner(stop: Partial<TreeStop> = {}): Runner {
  const s = { ...treeStop(), ...stop };
  return (command, args, options) => {
    // Throws before anything starts when the folder is not allowed.
    guardTarget(options.cwd);
    const env = commandEnv(options.env ?? process.env);
    if (options.signal?.aborted) return Promise.resolve({ code: null, stdout: "", stderr: "The command was cancelled.", failure: "aborted" });
    const ownGroup = process.platform !== "win32";
    return new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let failure: RunResult["failure"];
      let stopping = false;
      let child: ChildProcessByStdio<null, Readable, Readable>;
      if (ownGroup) listenForStop();
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
        if (ownGroup) stopListening();
        resolve({ code: null, stdout, stderr: (e as Error).message, failure: "spawn-error" });
        return;
      }
      const group = ownGroup ? child.pid : undefined;
      if (group !== undefined) liveGroups.add(group);
      let settled = false;
      const finish = (code: number | null, treeStillRunning = false) => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
        if (group !== undefined) liveGroups.delete(group);
        if (ownGroup) stopListening();
        resolve({ code: failure === undefined ? code : null, stdout, stderr, ...(failure === undefined ? {} : { failure }), ...(treeStillRunning ? { treeStillRunning } : {}) });
      };
      const stopTree = (why: NonNullable<RunResult["failure"]>) => {
        if (stopping || settled) return;
        failure = why;
        stopping = true;
        // Node holds the Windows process handle until exit. Afterwards its
        // PID can belong to someone else, even while a helper keeps stdio open.
        if (s.platform === "win32" && (child.exitCode !== null || child.signalCode !== null)) {
          child.stdout.destroy();
          child.stderr.destroy();
          finish(null, true);
          return;
        }
        const pid = child.pid;
        if (pid === undefined) {
          finish(null);
          return;
        }
        void endTree(pid, why === "aborted" ? { ...s, graceMs: ABORT_GRACE_MS } : s).then((ended) => {
          // Something outside the tree can still hold a pipe open; `close` is no longer waited for.
          child.stdout.destroy();
          child.stderr.destroy();
          finish(null, !ended);
        });
      };
      const timer = options.timeoutMs === undefined ? undefined : setTimeout(() => stopTree("timeout"), options.timeoutMs);
      const abort = () => stopTree("aborted");
      options.signal?.addEventListener("abort", abort, { once: true });
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
      // The hook can abort synchronously, so install its listener first.
      try { if (child.pid !== undefined) options.onStart?.(child.pid); }
      catch { stopTree("spawn-error"); }
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
