// How the updater runs git and pnpm. Everything goes through a Runner, so
// tests can make install or build fail (and record every call) while real
// git runs against their own temporary repositories.
//
// The real runner checks the guard (guard.ts) before each command, drops the
// environment variables that point git at another repository, and never lets
// git ask for a password (a check that needs one fails instead of hanging).
import { spawn } from "node:child_process";
import path from "node:path";
import { guardTarget, testRoot } from "./guard.ts";

export interface RunResult {
  /** The exit code; null when the command was killed or did not start. */
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** Set when the command did not start (ENOENT: not installed) or ran past its time limit. */
  readonly failure?: "not-found" | "timeout" | "spawn-error";
}

export interface RunOptions {
  readonly cwd: string;
  readonly timeoutMs?: number;
  /** Each chunk of stdout and stderr as it arrives (the update log). */
  readonly onOutput?: (chunk: string) => void;
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

export const realRunner: Runner = (command, args, options) => {
  // Throws before anything starts when the folder is not allowed.
  guardTarget(options.cwd);
  const env = commandEnv(options.env ?? process.env);
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let failure: RunResult["failure"];
    let child;
    try {
      child = spawn(command, [...args], { cwd: path.resolve(options.cwd), env, shell: options.shell ?? false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      resolve({ code: null, stdout, stderr: (e as Error).message, failure: "spawn-error" });
      return;
    }
    const timer = options.timeoutMs === undefined ? undefined : setTimeout(() => {
      failure = "timeout";
      child.kill();
    }, options.timeoutMs);
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
    let settled = false;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve({ code: failure === undefined ? code : null, stdout, stderr, ...(failure === undefined ? {} : { failure }) });
    };
    // A command that never started may or may not also emit close.
    child.on("error", (e: NodeJS.ErrnoException) => {
      failure = e.code === "ENOENT" ? "not-found" : "spawn-error";
      stderr += e.message;
      if (child.pid === undefined) finish(null);
    });
    child.on("close", (code) => finish(code));
  });
};

/** The last few lines a command printed, for a one-line reason. */
export function lastLines(result: RunResult, n = 3): string {
  const lines = `${result.stdout}\n${result.stderr}`.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "");
  const text = lines.slice(-n).join(" ");
  return text.length > 400 ? `${text.slice(0, 397)}…` : text;
}
