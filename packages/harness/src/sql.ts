import { spawn } from "node:child_process";

export const SQL_TIMEOUT_MS = 10000;

// Runs in a child Node process. A worker_thread cannot do this job: terminate()
// only stops JavaScript, and a running sqlite3_step (a recursive CTE, a huge
// cross join) never returns to JavaScript, so the thread spins on and even
// process.exit() waits for it. A child process can always be killed.
//
// The child also guards itself: its main thread may be stuck in sqlite3_step,
// so a watchdog worker kills the process at the timer (plus a second) or as
// soon as its parent is gone, so a crashed server never leaves a query spinning.
const CHILD = String.raw`
const { Worker } = require("node:worker_threads");
new Worker("const { workerData: w } = require('node:worker_threads');" +
  "const die = () => process.kill(w.pid, 'SIGKILL');" +
  "setTimeout(die, w.ms); setInterval(() => { if (process.ppid !== w.parent) die(); }, 250);",
  { eval: true, workerData: { pid: process.pid, parent: process.ppid, ms: Number(process.argv[1]) + 1000 } }).unref();
const { DatabaseSync } = require("node:sqlite");
const big = (_k, v) => typeof v === "bigint" ? v.toString() : v;
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", d => { input += d; });
process.stdin.on("end", () => {
  const { file, query, limit } = JSON.parse(input);
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true, allowExtension: false });
    db.exec("PRAGMA query_only=ON");
    const rows = [];
    let size = 0;
    for (const row of db.prepare(query).iterate()) {
      size += JSON.stringify(row, big).length;
      if (rows.length >= limit || size > 50000) break;
      rows.push(row);
    }
    process.stdout.write(JSON.stringify({ rows }, big));
  } catch (e) {
    process.stdout.write(JSON.stringify({ error: String(e && e.message || e) }));
  } finally { if (db) db.close(); }
});
`;

/** One read-only query against a snapshot, stopped after `timeoutMs` or on abort. */
export function runSnapshotQuery(input: { file: string; query: string; limit: number; signal: AbortSignal; timeoutMs?: number }): Promise<unknown[]> {
  input.signal.throwIfAborted();
  const timeoutMs = input.timeoutMs ?? SQL_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    // The server runs with ELECTRON_RUN_AS_NODE=1 under Electron, so execPath is a Node here too.
    const child = spawn(process.execPath, ["-e", CHILD, String(timeoutMs)], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });
    let stdout = "";
    let stderr = "";
    let failure: unknown;
    const stop = (reason: unknown) => { failure ??= reason; child.kill("SIGKILL"); };
    const timer = setTimeout(() => stop(new Error(`The query ran longer than ${timeoutMs / 1000} s and was stopped.`)), timeoutMs);
    const abort = () => stop(input.signal.reason);
    input.signal.addEventListener("abort", abort, { once: true });
    child.stdout.setEncoding("utf8").on("data", d => { stdout += d; if (stdout.length > 1000000) stop(new Error("The query result was too large")); });
    child.stderr.setEncoding("utf8").on("data", d => { stderr += d; });
    child.stdin.on("error", () => undefined).end(JSON.stringify({ file: input.file, query: input.query, limit: input.limit }));
    const cleanup = () => { clearTimeout(timer); input.signal.removeEventListener("abort", abort); };
    child.on("error", e => { cleanup(); reject(e); });
    child.on("close", code => {
      cleanup();
      if (failure !== undefined) return reject(failure);
      try {
        const result = JSON.parse(stdout) as { rows?: unknown[]; error?: string };
        if (result.error !== undefined) reject(new Error(result.error));
        else resolve(result.rows ?? []);
      } catch { reject(new Error(`The query process exited ${code}: ${stderr.slice(0, 500)}`)); }
    });
  });
}
