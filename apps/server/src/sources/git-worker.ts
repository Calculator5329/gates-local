import { spawn } from "node:child_process";
import { endTree } from "@gates-local/update/run";

const args: unknown = JSON.parse(process.argv[2] ?? "null");
const cwd = process.argv[3];
if (!Array.isArray(args) || !args.every((s: unknown) => typeof s === "string") || !cwd) throw new Error("Invalid git worker arguments");
let git: ReturnType<typeof spawn> | undefined;
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  if (!git) process.exit(1);
  // why: git and its helpers are in this worker's group, so one group kill ends them all
  if (process.platform !== "win32") { process.kill(-process.pid, "SIGKILL"); return; }
  // why: an exited git's PID may be reused, so close joins any helper still on stdio
  if (git.exitCode !== null || git.signalCode !== null) return;
  if (git.pid === undefined) process.exit(1);
  // why: this worker's record must outlive a git that can still write the import's staging
  void endTree(git.pid).then(ended => { if (ended) process.exit(1); });
};
process.stdin.resume();
process.stdin.once("end", stop);
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
const start = () => {
  if (git || stopping) return;
  const child = spawn("git", args, { cwd, env: process.env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  git = child;
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  child.once("error", (e: NodeJS.ErrnoException) => { process.stderr.write(e.code === "ENOENT" ? "git-not-found" : "git-start-failed"); process.exitCode = 1; process.stdin.destroy(); });
  child.once("close", code => process.exit(stopping ? 1 : code ?? 1));
};
// why: on Windows git waits for the parent's start line, sent once this worker's identity is saved
if (process.platform === "win32") process.stdin.once("data", start);
else start();
