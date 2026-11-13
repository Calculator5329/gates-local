#!/usr/bin/env node
// A fixture systemd-run for tests. The server runs it through GATES_LOCAL_SYSTEMD_RUN for the
// shell sandbox's probe, so Settings › Tools and the tool turn see the same sandbox on every
// runner (a WSL runner's own bwrap fails its check). GL_FAKE_SANDBOX picks the machine:
//   ready (default)  the scope reports its caps and the probe's /usr/bin/true passes
//   off              no user bus, as on a machine with no systemd user session
// It runs no real command: a shell call answers with a plain refusal, except a database read,
// `sqlite3 /data/<id>.db "<sql>"`, answered read-only from the file the server bound there, so a
// test sees the source it added reach the model (real confinement is in sandbox.test.ts).
// GATES_LOCAL_BWRAP and GATES_LOCAL_SQLITE point the probe here too, so no runner's own tools count.
import { writeSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { SCOPE_LIMITS } from "../../packages/harness/src/sandbox/index.ts";

const args = process.argv.slice(2);
if (process.env["GL_FAKE_SANDBOX"] === "off") {
  process.stderr.write("Failed to connect to bus: No medium found\n");
  process.exit(1);
}
if (args.some(a => a.includes("/sys/fs/cgroup"))) {
  process.stdout.write(`${SCOPE_LIMITS.memoryMaxBytes}\n0\n${SCOPE_LIMITS.tasksMax}\n`);
  process.exit(0);
}
if (args.at(-1) === "/usr/bin/true") process.exit(0);
const read = args.at(-2) === "gates-shell" ? /^sqlite3 (\/data\/[\w-]+\.db) "([^"]*)"$/.exec(args.at(-1) ?? "") : null;
const bound = read ? args.findIndex((arg, i) => arg === "--ro-bind" && args[i + 2] === read[1]) : -1;
if (read && bound >= 0) {
  writeSync(5, "."); // the command started (index.ts launch)
  const db = new DatabaseSync(args[bound + 1]!, { readOnly: true });
  for (const row of db.prepare(read[2]!).all()) process.stdout.write(`${Object.values(row).join("|")}\n`);
  db.close();
  process.exit(0);
}
process.stderr.write("the test sandbox stand-in runs no commands\n");
process.exit(1);
