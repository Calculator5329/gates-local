import { type ChildProcessByStdio, execFile, spawn } from "node:child_process";
import path from "node:path";
import type { Readable } from "node:stream";
import { groupAlive } from "./process-state.ts";
import { guardTarget, testRoot } from "./guard.ts";
import { isAlive } from "./wait.ts";

/**
 * `failure` is set when the command did not start (`not-found`: not installed)
 * or was ended. `treeStillRunning`: a command that was ended but whose
 * processes could not be confirmed gone; nothing else may touch the checkout.
 */
export interface RunResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly failure?: "not-found" | "timeout" | "spawn-error" | "aborted";
  readonly treeStillRunning?: true;
}

/**
 * `onStart` gets the process id as soon as it is known; if it throws, the
 * command is ended at once. `shell` is needed for pnpm.cmd on Windows, and the
 * arguments must then be plain words.
 */
export interface RunOptions {
  readonly signal?: AbortSignal;
  readonly cwd: string;
  readonly timeoutMs?: number;
  readonly onOutput?: (chunk: string) => void;
  readonly onStart?: (pid: number) => void;
  readonly shell?: boolean;
  readonly env?: NodeJS.ProcessEnv;
}

export type Runner = (command: string, args: readonly string[], options: RunOptions) => Promise<RunResult>;

const REDIRECTS = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_COMMON_DIR", "GIT_NAMESPACE", "GIT_ALTERNATE_OBJECT_DIRECTORIES"];

export function commandEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" };
  for (const key of REDIRECTS) delete env[key];
  const root = testRoot(base);
  if (root !== undefined) env["GIT_CEILING_DIRECTORIES"] = root;
  return env;
}

/** How long a process tree gets to end on SIGTERM, and how long SIGKILL or taskkill gets to be confirmed. */
export const TERM_GRACE_MS = 5_000;
export const KILL_CONFIRM_MS = 5_000;
const POLL_MS = 25;
// why: git's SIGTERM handler removes its locks in this time, before the server's hard exit.
const ABORT_GRACE_MS = 300;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A process group with a running member, whether its leader is still there or not. */
export function groupExists(pid: number): boolean {
  return groupAlive(pid);
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {}
}

function runTaskkill(args: readonly string[]): Promise<number | null> {
  return new Promise((resolve) => {
    execFile("taskkill", [...args], { windowsHide: true, timeout: KILL_CONFIRM_MS }, (error) => {
      if (error === null) resolve(0);
      else resolve(typeof error.code === "number" ? error.code : null);
    });
  });
}

/** `exists` asks whether the tree is still there: the process group on POSIX, the root process on Windows. */
export interface TreeStop {
  readonly platform: NodeJS.Platform;
  readonly graceMs: number;
  readonly confirmMs: number;
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

// external: Windows taskkill exits 128 when it finds no such process.
const TASKKILL_NOT_FOUND = 128;

/** `requireWindowsTreeKill`: startup may leave helpers behind a dead root, so "no such process" cannot certify that tree. */
export interface EndTreeOptions {
  readonly requireWindowsTreeKill?: boolean;
}

/**
 * Ends a command and everything it started, within a bound, and says whether
 * that was confirmed. POSIX: SIGTERM to the process group, SIGKILL after the
 * grace. Windows has no process groups here: `taskkill /T /F` walks the tree
 * from the root, and only the root can be confirmed afterwards.
 */
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

const liveGroups = new Set<number>();
const STOP_SIGNALS: readonly NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];

function killTrackedGroups(): void {
  for (const pid of liveGroups) signalGroup(pid, "SIGKILL");
  liveGroups.clear();
}

function onStopSignal(signal: NodeJS.Signals): void {
  if (process.listeners(signal).some(listener => listener !== onStopSignal)) return;
  killTrackedGroups();
  for (const s of STOP_SIGNALS) process.removeListener(s, onStopSignal);
  if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
}

let listeningFor = 0;

function listenForStop(): void {
  if (listeningFor++ > 0) return;
  // external: Node removes once-listeners as it delivers a signal; this one must see them first.
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
        // external: Node holds a Windows process handle only until exit; then its PID can be reused.
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
          // why: something outside the tree can still hold a pipe open, so `close` is not waited for.
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
      // external: Node may or may not emit close after error for a command that never started.
      child.on("error", (e: NodeJS.ErrnoException) => {
        if (stopping) return;
        failure = e.code === "ENOENT" ? "not-found" : "spawn-error";
        stderr += e.message;
        if (child.pid === undefined) finish(null);
      });
      child.on("close", (code) => {
        if (!stopping) finish(code);
      });
      // why: the onStart hook can abort synchronously, so the abort listener goes in first.
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
