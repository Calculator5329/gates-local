#!/usr/bin/env node
// Release orchestration fixture only. Run real fixture scripts and install
// only the local CLI protocol double; never resolve or download packages.
const { cpSync, mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { spawn } = require("node:child_process");
const { createRequire } = require("node:module");
const path = require("node:path");

function run(command, args) {
  // The release runner signals the whole group. Reap the script before the
  // package-manager leader exits, leaving escaped writers for it to detect.
  let stopping = false;
  process.on("SIGTERM", () => { stopping = true; });
  const child = spawn(command, args, { stdio: "inherit" });
  child.on("error", (error) => { throw error; });
  child.on("close", (code, signal) => {
    if (stopping) {
      process.stdout.end(() => process.stderr.end(() => process.exit(0)));
    } else if (signal) {
      process.removeAllListeners(signal);
      process.kill(process.pid, signal);
    } else process.exit(code ?? 1);
  });
}

const [command, ...args] = process.argv.slice(2);
const file = path.join(process.cwd(), "package.json");
const pkg = JSON.parse(readFileSync(file, "utf8"));
if (pkg.packageManager !== "pnpm@11.10.0") throw new Error("Unexpected fixture package manager");

if (command === "--version") {
  console.log("11.10.0");
} else if (command === "install") {
  const lock = JSON.stringify({ devDependencies: pkg.devDependencies ?? {} }) + "\n";
  const lockfile = path.join(process.cwd(), "pnpm-lock.yaml");
  if (args.includes("--lockfile-only")) {
    writeFileSync(lockfile, lock);
  } else {
    if (!args.includes("--frozen-lockfile")) throw new Error("Fixture install must keep the frozen-lockfile guard");
    if (readFileSync(lockfile, "utf8") !== lock) throw new Error("Fixture lockfile is out of date");
    for (const [name, source] of Object.entries(pkg.devDependencies ?? {})) {
      if (name !== "playwright" || source !== "file:tools") throw new Error("Only the local Playwright fixture may be installed");
      const modules = path.join(process.cwd(), "node_modules");
      mkdirSync(modules, { recursive: true });
      cpSync(path.join(process.cwd(), "tools"), path.join(modules, name), { recursive: true });
    }
  }
} else if (command === "exec" && args[0] === "playwright") {
  const local = createRequire(file);
  const metadata = local.resolve("playwright/package.json");
  const cli = JSON.parse(readFileSync(metadata, "utf8")).bin.playwright;
  run(process.execPath, [path.resolve(path.dirname(metadata), cli), ...args.slice(1)]);
} else if (command === "perf:compare") {
  run(process.execPath, ["perf.cjs", ...args]);
} else if (command === "verify" || command === "build") {
  const script = pkg.scripts?.[command];
  if (typeof script !== "string") throw new Error("Missing fixture script");
  run("/bin/sh", ["-c", `exec ${script}`]);
} else {
  throw new Error(`Unsupported fixture pnpm command: ${command}`);
}
