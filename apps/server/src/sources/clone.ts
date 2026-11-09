import { execFile, spawn } from "node:child_process";
import { mkdir, lstat, opendir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_BYTES = 64 * 1024 * 1024;
export const REPO_FILES = 10_000;
export const IMPORT_MS = 60_000;
export const TOO_LARGE = "This repository is too large. Choose one under 64 MiB and 10,000 files.";

/** Exact spelling, before URL normalization: no credentials, port, escapes, arguments or extra path. */
export function githubRepo(input: string): string {
  const match = /^https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9_][A-Za-z0-9_.-]{0,99})(?:\.git)?\/?$/.exec(input);
  if (!match || match[1]?.endsWith("-") || match[1]?.includes("--")) throw new Error("Paste a public GitHub URL like https://github.com/owner/repo.");
  const repo = match[2]!.replace(/\.git$/, "");
  if (repo === "." || repo === ".." || repo.endsWith(".")) throw new Error("Paste a public GitHub URL like https://github.com/owner/repo.");
  return `https://github.com/${match[1]}/${repo}`;
}

/** Counts metadata as well as files, without following links. Used while git is receiving. */
export async function importSize(root: string, signal: AbortSignal): Promise<number> {
  let bytes = 0;
  let files = 0;
  const walk = async (dir: string): Promise<void> => {
    signal.throwIfAborted();
    let entries;
    try { entries = await opendir(dir); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return; throw e; }
    for await (const entry of entries) {
      signal.throwIfAborted();
      if (++files > REPO_FILES * 2) throw new Error(TOO_LARGE);
      const at = path.join(dir, entry.name);
      let stat;
      try { stat = await lstat(at); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") continue; throw e; }
      bytes += stat.size;
      if (bytes > REPO_BYTES) throw new Error(TOO_LARGE);
      if (stat.isDirectory()) await walk(at);
    }
  };
  await walk(root);
  return bytes;
}

export interface GitCall {
  args: readonly string[]; cwd: string; env: NodeJS.ProcessEnv; signal: AbortSignal;
  /** Test-only observation of the owned worker; never supplied by the wire or production main. */
  onWorkerStart?: (pid: number) => void;
  onStopUnconfirmed?: () => void;
}
export type GitTransport = (call: GitCall) => Promise<string>;

/** Parent-owned process group, bounded output and bounded cancellation. No shell. */
export const runGit: GitTransport = ({ args, cwd, env, signal, onWorkerStart, onStopUnconfirmed }) => new Promise((resolve, reject) => {
  signal.throwIfAborted();
  const worker = spawn(process.execPath, [fileURLToPath(new URL("./git-worker.ts", import.meta.url)), JSON.stringify(args), cwd], { env, detached: process.platform !== "win32", windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let output = "";
  let error = "";
  let failure: Error | undefined;
  let settled = false;
  let stopping = false;
  let exited = false;
  let closed = false;
  let windowsStop: "pending" | "confirmed" | "unconfirmed" = "pending";
  let stopTimer: ReturnType<typeof setTimeout> | undefined;
  const finish = (code: number | null) => {
    if (settled) return;
    settled = true;
    if (stopTimer) clearTimeout(stopTimer);
    signal.removeEventListener("abort", cancel);
    worker.stdin.destroy(); worker.stdout.destroy(); worker.stderr.destroy();
    if (signal.aborted) reject(signal.reason);
    else if (failure) reject(failure);
    else if (code === 0) resolve(output);
    else reject(new Error(error.includes("git-not-found") ? "Git is not installed. Install Git and try again."
      : /could not resolve|unable to access|failed to connect|network is unreachable/i.test(error) ? "GitHub could not be reached. Check your connection and retry."
      : "This repository is private, missing or unavailable. Choose a public GitHub repository and retry."));
  };
  const cancel = () => {
    if (stopping || settled) return;
    stopping = true;
    // Never wait exclusively for close or for a stopped worker to service EOF.
    const pid = worker.pid;
    if (pid === undefined) { finish(null); return; }
    if (process.platform === "win32") {
      const unconfirmed = () => {
        if (settled) return;
        if (stopTimer) clearTimeout(stopTimer);
        if (windowsStop !== "confirmed") windowsStop = "unconfirmed";
        if (closed) finish(null);
        else onStopUnconfirmed?.(); // Keep the promise, staging and admission slot held.
      };
      stopTimer = setTimeout(unconfirmed, 1000);
      execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { timeout: 1000, windowsHide: true }, killError => {
        if (settled) return;
        if (killError !== null) { unconfirmed(); return; }
        windowsStop = "confirmed";
        // A successful tree kill plus the worker's exit confirms termination.
        if (exited || closed) finish(null);
      });
    } else {
      stopTimer = setTimeout(() => finish(null), 1000);
      try { process.kill(-pid, "SIGKILL"); }
      catch { worker.kill("SIGKILL"); }
    }
  };
  signal.addEventListener("abort", cancel, { once: true });
  worker.stdout.on("data", (chunk: Buffer) => {
    if (stopping) return;
    output += chunk.toString();
    if (output.length > 2_000_000) { failure = new Error(TOO_LARGE); cancel(); }
  });
  worker.stderr.on("data", (chunk: Buffer) => { error = (error + chunk.toString()).slice(-4000); });
  worker.on("error", () => { failure = new Error("Git could not start. Install Git and try again."); if (!stopping) finish(null); });
  worker.on("exit", () => {
    exited = true;
    if (stopping && (process.platform !== "win32" || windowsStop === "confirmed")) finish(null);
  });
  worker.on("close", code => {
    closed = true;
    if (!stopping || process.platform !== "win32" || windowsStop !== "pending") finish(code);
  });
  worker.once("spawn", () => {
    if (worker.pid === undefined || stopping) return;
    try { onWorkerStart?.(worker.pid); }
    catch (e) { failure = e instanceof Error ? e : new Error("The git worker could not start."); cancel(); }
  });
});

/** Config, hooks, filters, credentials and writable scratch paths are isolated to this job. */
export async function cloneRepository(options: { url: string; work: string; destination: string; signal: AbortSignal; progress: (bytes: number) => void; onStopUnconfirmed?: () => void; git?: GitTransport }): Promise<number> {
  const { work, destination, signal } = options;
  const config = path.join(work, "empty-config");
  const empty = path.join(work, "empty");
  await mkdir(empty, { mode: 0o700 });
  await writeFile(config, "", { mode: 0o600 });
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "LANG"]) if (process.env[key] !== undefined) env[key] = process.env[key];
  Object.assign(env, {
    HOME: work, USERPROFILE: work, XDG_CONFIG_HOME: work, TMPDIR: work, TMP: work, TEMP: work,
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_SYSTEM: config, GIT_CONFIG_GLOBAL: config,
    GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", GIT_LFS_SKIP_SMUDGE: "1", GIT_ATTR_NOSYSTEM: "1",
    // The desktop server's execPath is Electron; its worker must stay in Node mode.
    ELECTRON_RUN_AS_NODE: "1",
    GIT_ALLOW_PROTOCOL: "https", GIT_PROTOCOL_FROM_USER: "0",
  });
  const settings = ["core.hooksPath=" + empty, "core.symlinks=false", "credential.helper=", "core.askPass=", "protocol.allow=never", "protocol.https.allow=always", "submodule.recurse=false", "filter.lfs.required=false", "filter.lfs.smudge=", "filter.lfs.process=", "http.followRedirects=false", "http.extraHeader=", "http.cookieFile=", "http.saveCookies=false", "http.lowSpeedLimit=1", "http.lowSpeedTime=15"];
  const prefix = settings.flatMap(s => ["-c", s]);
  const git = (args: readonly string[], cwd = work) => (options.git ?? runGit)({ args: [...prefix, ...args], cwd, env, signal, onStopUnconfirmed: options.onStopUnconfirmed });
  // No checkout until the entire tree's expanded sizes and modes have passed the budget.
  await git(["clone", "--depth=1", "--single-branch", "--no-tags", "--no-checkout", "--no-recurse-submodules", `--template=${empty}`, "--", options.url, destination]);
  const tree = await git(["ls-tree", "-r", "-l", "-z", "HEAD", "--"], destination);
  let size = 0;
  let files = 0;
  for (const row of tree.split("\0")) {
    if (row === "") continue;
    const match = /^(100644|100755|120000|160000) (blob|commit) [a-f0-9]+ +([0-9]+|-)\t/.exec(row);
    if (!match) throw new Error("This repository contains an unsupported file type.");
    if (match[1] === "160000") continue; // Submodules stay empty and are never fetched.
    size += Number(match[3]);
    if (++files > REPO_FILES || size > REPO_BYTES) throw new Error(TOO_LARGE);
  }
  signal.throwIfAborted();
  options.progress(size);
  await git(["-c", "core.protectNTFS=true", "-c", "core.protectHFS=true", "reset", "--hard", "HEAD", "--"], destination);
  await importSize(destination, signal);
  return size;
}
