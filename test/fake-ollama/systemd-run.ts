#!/usr/bin/env node
// A fixture systemd-run for tests. The server runs it through GATES_LOCAL_SYSTEMD_RUN for the
// shell sandbox's probe, so Settings › Tools and the tool turn see the same sandbox on every
// runner (a WSL runner's own bwrap fails its check). GL_FAKE_SANDBOX picks the machine:
//   ready (default)  the scope reports its caps and the probe's /usr/bin/true passes
//   off              no user bus, as on a machine with no systemd user session
// It runs no real command: a shell call answers with a plain refusal.
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
process.stderr.write("the test sandbox stand-in runs no commands\n");
process.exit(1);
