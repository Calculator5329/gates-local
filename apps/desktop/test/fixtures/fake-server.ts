// Fake Gates Local server for supervisor tests. Speaks the CLI contract in
// apps/desktop/README.md; FAKE_MODE picks a misbehaviour.
//   ready        listen, print the ready line, run until told to stop
//   never-ready  print stderr noise, never print ready
//   crash-once   ready, then exit 1 on the first launch per data dir
//   exit-early   stderr line, exit 3 before ready
//   ignore-term  ready, ignore SIGTERM (and stdin EOF)
//   wrong-port   print a ready line naming another port

import { existsSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";

function arg(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (value === undefined) {
    process.stderr.write(`missing ${name}\n`);
    process.exit(2);
  }
  return value;
}

const port = Number(arg("--port"));
const dataDir = arg("--data-dir");
const mode = process.env["FAKE_MODE"] ?? "ready";
const token = process.env["GATES_LOCAL_SERVER_TOKEN"] ?? "";

writeFileSync(
  join(dataDir, `launch-${process.pid}.json`),
  JSON.stringify({
    pid: process.pid,
    port,
    token,
    argv: process.argv.slice(2),
    electronRunAsNode: process.env["ELECTRON_RUN_AS_NODE"],
    webRoot: process.env["GATES_LOCAL_WEB_ROOT"],
    phoneUser: process.env["GATES_LOCAL_WEB_USER"],
  }),
);

// Parent-death path from the contract: exit when stdin reaches EOF. The
// eof-<pid> marker tells a test this exit was the server's own.
if (mode !== "ignore-term") {
  process.stdin.on("end", () => {
    writeFileSync(join(dataDir, `eof-${process.pid}`), "");
    process.exit(0);
  });
  process.stdin.resume();
}

function ready(reportedPort: number = port): void {
  const server = createServer();
  server.listen(port, "127.0.0.1", () => {
    process.stdout.write("booting\n");
    process.stdout.write(`${JSON.stringify({ ready: true, port: reportedPort })}\n`);
  });
  process.on("SIGTERM", () => {
    if (mode === "ignore-term") {
      process.stderr.write("ignoring SIGTERM\n");
      return;
    }
    server.close();
    process.exit(0);
  });
}

switch (mode) {
  case "ready":
  case "ignore-term":
    ready();
    break;
  case "wrong-port":
    ready(port + 1);
    break;
  case "never-ready":
    process.stderr.write("loading models...\n");
    setInterval(() => process.stderr.write("still loading\n"), 100);
    break;
  case "crash-once": {
    const marker = join(dataDir, "crashed-once");
    ready();
    if (!existsSync(marker)) {
      writeFileSync(marker, "");
      setTimeout(() => {
        process.stderr.write("boom: simulated crash\n");
        process.exit(1);
      }, 150);
    }
    break;
  }
  case "exit-early":
    process.stderr.write("fatal: cannot open database\n");
    process.exit(3);
    break;
  default:
    process.stderr.write(`unknown FAKE_MODE ${mode}\n`);
    process.exit(2);
}
