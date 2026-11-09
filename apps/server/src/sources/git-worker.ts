// The server holds stdin open. Even if it is killed, EOF ends this worker's git
// process tree before it exits, so an interrupted clone cannot survive a restart.
import { spawn } from "node:child_process";
import { endTree } from "../update/run.ts";

const args: unknown = JSON.parse(process.argv[2] ?? "null");
const cwd = process.argv[3];
if (!Array.isArray(args) || !args.every((s: unknown) => typeof s === "string") || !cwd) throw new Error("Invalid git worker arguments");
// The parent starts this worker as the group leader; git and its helpers stay
// in that group so the parent can stop them even when this worker is stopped.
let git: ReturnType<typeof spawn> | undefined;
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  if (!git) process.exit(1);
  if (process.platform !== "win32") { process.kill(-process.pid, "SIGKILL"); return; }
  // Once the handle has exited the PID may be reused. Let close join any
  // helper still holding stdio, keeping this worker's ownership record alive.
  if (git.exitCode !== null || git.signalCode !== null) return;
  if (git.pid === undefined) process.exit(1);
  // Keep the recorded worker alive if Git could not be stopped. Its identity
  // must not disappear while the child can still write the import's staging.
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
// A suspended worker cannot race ahead of the parent's durable identity record.
if (process.platform === "win32") process.stdin.once("data", start);
else start();
