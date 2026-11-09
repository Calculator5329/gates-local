// The server holds stdin open. Even if it is killed, EOF ends this worker's git
// process tree before it exits, so an interrupted clone cannot survive a restart.
import { spawn } from "node:child_process";
import { endTree } from "../update/run.ts";

const args: unknown = JSON.parse(process.argv[2] ?? "null");
const cwd = process.argv[3];
if (!Array.isArray(args) || !args.every((s: unknown) => typeof s === "string") || !cwd) throw new Error("Invalid git worker arguments");
// The parent starts this worker as the group leader; git and its helpers stay
// in that group so the parent can stop them even when this worker is stopped.
const git = spawn("git", args, { cwd, env: process.env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  if (process.platform !== "win32") { process.kill(-process.pid, "SIGKILL"); return; }
  if (git.pid === undefined) process.exit(1);
  void endTree(git.pid).then(ended => process.exit(ended ? 1 : 2));
};
process.stdin.resume();
process.stdin.once("end", stop);
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
git.stdout.pipe(process.stdout);
git.stderr.pipe(process.stderr);
git.once("error", (e: NodeJS.ErrnoException) => { process.stderr.write(e.code === "ENOENT" ? "git-not-found" : "git-start-failed"); process.exitCode = 1; process.stdin.destroy(); });
git.once("close", code => { if (!stopping) process.exit(code ?? 1); });
